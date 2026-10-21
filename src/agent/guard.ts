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
      action: Exclude<SpendAction, 'balance'>
      chain: string
      /** Recipient address, mint destination address, or redemption bank id. */
      destination: string
      /** Pounds, as a decimal string. */
      amount: string
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
  /** Clock, for tests. */
  now?: () => Date
}

export interface SpendGuard {
  readonly policy: SpendPolicy
  /** Resolves once the action is allowed and recorded; throws `SPEND_POLICY_DENIED` otherwise. */
  authorize(request: SpendRequest): Promise<void>
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000

export function createSpendGuard(options: SpendGuardOptions): SpendGuard {
  const { policy } = options
  const ledger = new SpendLedger(options.ledgerPath)
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
      const approved = await waitForApproval({
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
      amount: request.amount,
    }
    let result: Awaited<ReturnType<SpendLedger['reserve']>>
    try {
      result = await ledger.reserve(entry, dailyCap)
    } catch (error) {
      throw ledgerDenied(ledger.path, request, error)
    }
    if (!result.ok) throw dailyCapDenied(request, result.spent)
  }

  async function waitForApproval(request: ApprovalRequest): Promise<boolean> {
    const { approver } = options
    if (!approver) return false
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
      return answer === true && !controller.signal.aborted
    } catch {
      return false
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

  return { policy, authorize }
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
    { cause, details: { rule: 'ledger', ...request, ledgerPath: path } },
  )
}
