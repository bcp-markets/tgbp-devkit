/**
 * The spend guard checks an action against a spend policy before anything is
 * signed or sent. It refuses with `SPEND_POLICY_DENIED` and names the rule.
 *
 * It runs in your process, so it binds an agent that can only reach tGBP
 * through it. Anyone holding the API key or the wallet key directly can
 * bypass it.
 */
import { formatAmount } from '../amount.js'
import { TgbpKitError } from '../errors.js'
import { type LedgerEntry, SpendLedger, utcDay } from './ledger.js'
import {
  POLICY_DECIMALS,
  type SpendAction,
  type SpendPolicy,
  sameDestination,
  toPolicyUnits,
} from './policy.js'

/** The policy field that refused an action, or `ledger` when the spend ledger failed. */
export type SpendPolicyRule =
  | 'expiresAt'
  | 'actions'
  | 'chains'
  | 'destinations'
  | 'perTransferCap'
  | 'dailyCap'
  | 'redemptionApprovalAbove'
  | 'ledger'

export type SpendRequest =
  | { action: 'balance'; chain: string }
  | {
      action: Exclude<SpendAction, 'balance' | 'x402'>
      chain: string
      /** Recipient address, mint destination address, or redemption bank id. */
      destination: string
      /** Pounds, as a decimal string. */
      amount: string
    }
  | {
      action: 'x402'
      chain: string
      /** The payee address. */
      destination: string
      /** Pounds, as a decimal string. */
      amount: string
      /** The URL paid for. */
      url: string
      /** Why the agent is paying. Required, because the ledger records it. */
      reason: string
    }

export interface ApprovalRequest {
  action: 'redeem'
  chain: string
  destination: string
  amount: string
  /** The policy's `redemptionApprovalAbove`. */
  threshold: string
}

/**
 * Asks a human to approve an action. Resolve `true` only on an explicit yes.
 * The guard aborts `signal` when its wait runs out, and treats the timeout,
 * any other value, and a rejection as a refusal.
 */
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>

export interface SpendGuardOptions {
  policy: SpendPolicy
  /** The append-only spend ledger for this policy. */
  ledgerPath: string
  /** Without one, every redemption above the approval threshold is refused. */
  approver?: Approver
  /** How long to wait for a human before refusing. Default 5 minutes. */
  approvalTimeoutMs?: number
  /** How long to wait for another process holding the ledger lock. Default 5 seconds. */
  ledgerLockWaitMs?: number
  /** Clock, for tests. */
  now?: () => Date
}

/** Pounds, as decimal strings. */
export interface SpendBudget {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string
  dailyCap: string
  /** What the ledger records as spent today. */
  spent: string
  /** What the agent may still spend today: `0` once the policy has expired. */
  remaining: string
}

export interface SpendGuard {
  readonly policy: SpendPolicy
  /** Resolves once the action is allowed and recorded; throws `SPEND_POLICY_DENIED` otherwise. */
  authorize(request: SpendRequest): Promise<void>
  /** Today's spend against the daily cap. Throws if the ledger cannot be read. */
  budget(): Promise<SpendBudget>
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000

export function createSpendGuard(options: SpendGuardOptions): SpendGuard {
  const { policy } = options
  const ledger = new SpendLedger(options.ledgerPath, options.ledgerLockWaitMs)
  const now = options.now ?? (() => new Date())
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const expiresAt = Date.parse(policy.expiresAt)
  const perTransferCap = toPolicyUnits(policy.perTransferCap)
  const dailyCap = toPolicyUnits(policy.dailyCap)
  const approvalAbove = toPolicyUnits(policy.redemptionApprovalAbove)

  function checkExpiry(request: SpendRequest): void {
    if (now().getTime() >= expiresAt) {
      throw denied('expiresAt', `the spend policy expired at ${policy.expiresAt}`, request)
    }
  }

  async function spentToday(request: SpendRequest): Promise<bigint> {
    try {
      return await ledger.spentOn(utcDay(now()))
    } catch (error) {
      throw ledgerDenied(ledger.path, request, error)
    }
  }

  async function authorize(request: SpendRequest): Promise<void> {
    checkExpiry(request)
    if (!policy.actions.includes(request.action)) {
      throw denied('actions', `the spend policy does not allow "${request.action}"`, request)
    }
    if (!policy.chains.includes(request.chain)) {
      throw denied('chains', `the spend policy does not allow chain "${request.chain}"`, request)
    }
    if (request.action === 'balance') return

    const { destination } = request
    if (
      request.action === 'x402' &&
      (typeof request.reason !== 'string' || request.reason.trim() === '')
    ) {
      throw new RangeError('an x402 payment needs a reason')
    }
    if (!policy.destinations.some((allowed) => sameDestination(allowed, destination))) {
      throw denied('destinations', `"${destination}" is not an allowed destination`, request)
    }
    const amount = toPolicyUnits(request.amount)
    if (amount <= 0n) throw new RangeError('amount must be greater than zero')
    if (amount > perTransferCap) {
      throw denied(
        'perTransferCap',
        `${request.amount} is over the per-transfer cap of ${policy.perTransferCap}`,
        request,
      )
    }
    // Check the daily cap before asking a human, so nobody approves an action that would fail.
    const spent = await spentToday(request)
    if (spent + amount > dailyCap) throw dailyCapDenied(request, spent)

    if (request.action === 'redeem' && amount > approvalAbove) {
      const { approved, approverError } = await waitForApproval({
        action: 'redeem',
        chain: request.chain,
        destination,
        amount: request.amount,
        threshold: policy.redemptionApprovalAbove,
      })
      if (!approved) {
        throw denied(
          'redemptionApprovalAbove',
          `a redemption over ${policy.redemptionApprovalAbove} needs a human's approval, and none was given`,
          request,
          approverError ? { approverError } : {},
        )
      }
      // The policy may have expired while the human was deciding.
      checkExpiry(request)
    }

    const at = now()
    const entry: LedgerEntry = {
      at: at.toISOString(),
      day: utcDay(at),
      action: request.action,
      chain: request.chain,
      destination,
      amount: formatAmount(amount, POLICY_DECIMALS),
      ...(request.action === 'x402'
        ? {
            url: request.url,
            pence: formatAmount(amount, POLICY_DECIMALS - 2),
            reason: request.reason,
          }
        : {}),
    }
    let result: Awaited<ReturnType<SpendLedger['reserve']>>
    try {
      result = await ledger.reserve(entry, dailyCap)
    } catch (error) {
      throw ledgerDenied(ledger.path, request, error)
    }
    if (!result.ok) throw dailyCapDenied(request, result.spent)
  }

  async function waitForApproval(
    request: ApprovalRequest,
  ): Promise<{ approved: boolean; approverError?: string }> {
    const { approver } = options
    if (!approver) return { approved: false, approverError: 'no approver is configured' }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(false)
      }, approvalTimeoutMs)
    })
    try {
      const answer = await Promise.race([approver(request, controller.signal), timeout])
      // Only an explicit true approves; a truthy string or object does not.
      if (controller.signal.aborted) {
        return { approved: false, approverError: 'no answer before the timeout' }
      }
      return { approved: answer === true }
    } catch (error) {
      // Refuse, but say why: a broken client must not look like a human's "no".
      return { approved: false, approverError: errorMessage(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  function dailyCapDenied(request: SpendRequest, spent: bigint): TgbpKitError {
    const amount = 'amount' in request ? request.amount : '0'
    return denied(
      'dailyCap',
      `${amount} would take today's spend over the daily cap of ${policy.dailyCap} (${formatAmount(spent, POLICY_DECIMALS)} already spent)`,
      request,
      { spentToday: formatAmount(spent, POLICY_DECIMALS) },
    )
  }

  async function budget(): Promise<SpendBudget> {
    const at = now()
    const day = utcDay(at)
    let spent: bigint
    try {
      spent = await ledger.spentOn(day)
    } catch (error) {
      throw new Error(`Cannot read the spend ledger ${ledger.path}`, { cause: error })
    }
    const left = at.getTime() >= expiresAt || spent >= dailyCap ? 0n : dailyCap - spent
    return {
      day,
      dailyCap: formatAmount(dailyCap, POLICY_DECIMALS),
      spent: formatAmount(spent, POLICY_DECIMALS),
      remaining: formatAmount(left, POLICY_DECIMALS),
    }
  }

  return { policy, authorize, budget }
}

function denied(
  rule: SpendPolicyRule,
  reason: string,
  request: SpendRequest,
  extra: Record<string, unknown> = {},
): TgbpKitError {
  return new TgbpKitError(
    'SPEND_POLICY_DENIED',
    `Spend policy refused ${request.action}: ${reason}`,
    {
      details: { rule, ...request, ...extra },
    },
  )
}

function ledgerDenied(path: string, request: SpendRequest, cause: unknown): TgbpKitError {
  return new TgbpKitError(
    'SPEND_POLICY_DENIED',
    `Spend policy refused ${request.action}: the spend ledger ${path} cannot be read or written, so the daily cap cannot be checked`,
    {
      cause,
      details: { rule: 'ledger', ...request, ledgerPath: path, reason: errorMessage(cause) },
    },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
