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
import { type LedgerEntry, type ReserveResult, SpendLedger, sumDay, utcDay } from './ledger.js'
import {
  matchService,
  POLICY_DECIMALS,
  parseX402Rules,
  type SpendAction,
  type SpendPolicy,
  sameDestination,
  toPolicyUnits,
  type X402Service,
} from './policy.js'

/**
 * The rule that refused an action: a policy field, `firstPayment` when nobody
 * approved the first payment to an x402 service, or `ledger` when the spend
 * ledger failed.
 */
export type SpendPolicyRule =
  | 'expiresAt'
  | 'actions'
  | 'chains'
  | 'destinations'
  | 'perTransferCap'
  | 'dailyCap'
  | 'redemptionApprovalAbove'
  | 'services'
  | 'categoryBudgets'
  | 'paymentsPerMinute'
  | 'firstPayment'
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

export type ApprovalRequest =
  | {
      action: 'redeem'
      chain: string
      destination: string
      amount: string
      /** The policy's `redemptionApprovalAbove`. */
      threshold: string
    }
  | {
      /** The first x402 payment to a service. Once one is recorded, the budgets alone decide. */
      action: 'x402'
      chain: string
      destination: string
      amount: string
      url: string
      reason: string
      /** The `x402.services` match the URL falls under. */
      service: string
      category: string
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
  /**
   * Without one, every redemption above the approval threshold, and every
   * first x402 payment to a service, is refused.
   */
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
  /**
   * What is left under the daily cap today: `0` once the policy has expired.
   * The other rules can still refuse an action within it.
   */
  remaining: string
}

export interface SpendGuard {
  readonly policy: SpendPolicy
  /** Resolves once the action is allowed and recorded; throws `SPEND_POLICY_DENIED` otherwise. */
  authorize(request: SpendRequest): Promise<void>
  /** Today's spend against the daily cap. Throws `SPEND_POLICY_DENIED` if the ledger cannot be read. */
  budget(): Promise<SpendBudget>
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000
/** The longest x402 `reason` the ledger accepts, in characters. */
export const MAX_REASON_LENGTH = 500

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

export function createSpendGuard(options: SpendGuardOptions): SpendGuard {
  const { policy } = options
  const ledger = new SpendLedger(options.ledgerPath, options.ledgerLockWaitMs)
  const now = options.now ?? (() => new Date())
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const expiresAt = Date.parse(policy.expiresAt)
  const perTransferCap = toPolicyUnits(policy.perTransferCap)
  const dailyCap = toPolicyUnits(policy.dailyCap)
  const approvalAbove = toPolicyUnits(policy.redemptionApprovalAbove)
  // Checked here as well as in parseSpendPolicy: a policy built in code skips the parser.
  const x402 = policy.x402 === undefined ? undefined : parseX402Rules(policy.x402)
  const categoryBudgets = new Map(
    Object.entries(x402?.categoryBudgets ?? {}).map(([category, pounds]) => [
      category,
      toPolicyUnits(pounds),
    ]),
  )
  const categoryOf = new Map(x402?.services.map(({ match, category }) => [match, category]))

  function checkExpiry(request: SpendRequest): void {
    if (now().getTime() >= expiresAt) {
      throw denied('expiresAt', `the spend policy expired at ${policy.expiresAt}`, request)
    }
  }

  async function readLedger(request: SpendRequest): Promise<LedgerEntry[]> {
    try {
      return await ledger.entries()
    } catch (error) {
      throw ledgerDenied(ledger.path, request, error)
    }
  }

  /** The cap or budget `amount` would break at time `at`, given what `entries` already spent. */
  function overLimit(
    request: SpendRequest,
    amount: bigint,
    service: X402Service | undefined,
    entries: LedgerEntry[],
    at: Date,
  ): TgbpKitError | undefined {
    const spent = sumDay(entries, utcDay(at))
    if (spent + amount > dailyCap) return dailyCapDenied(request, spent)
    if (service === undefined || x402 === undefined) return undefined

    const budget = categoryBudgets.get(service.category)
    if (budget === undefined) {
      return denied('categoryBudgets', `category "${service.category}" has no budget`, request)
    }
    // Rolling windows. An entry dated in the future still counts, so a skewed clock overstates.
    const x402Since = (ms: number) =>
      entries.filter((entry) => entry.action === 'x402' && Date.parse(entry.at) > at.getTime() - ms)
    const categorySpent = x402Since(DAY_MS)
      // Its recorded category, or its service's category now, so moving a service keeps its spend.
      .filter(
        (entry) =>
          entry.category === service.category ||
          (entry.service !== undefined && categoryOf.get(entry.service) === service.category),
      )
      .reduce((total, entry) => total + toPolicyUnits(entry.amount), 0n)
    if (categorySpent + amount > budget) {
      const spentText = formatAmount(categorySpent, POLICY_DECIMALS)
      return denied(
        'categoryBudgets',
        `${formatAmount(amount, POLICY_DECIMALS)} would take "${service.category}" over its budget of ${formatAmount(budget, POLICY_DECIMALS)} in 24 hours (${spentText} already spent)`,
        request,
        { category: service.category, spentInCategory: spentText },
      )
    }
    if (x402Since(MINUTE_MS).length >= x402.paymentsPerMinute) {
      return denied(
        'paymentsPerMinute',
        `the spend policy allows ${x402.paymentsPerMinute} x402 payments a minute`,
        request,
      )
    }
    return undefined
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
      (typeof request.reason !== 'string' ||
        request.reason.trim() === '' ||
        request.reason.length > MAX_REASON_LENGTH)
    ) {
      throw new RangeError(`an x402 payment needs a reason of 1 to ${MAX_REASON_LENGTH} characters`)
    }
    if (!policy.destinations.some((allowed) => sameDestination(allowed, destination))) {
      throw denied('destinations', `"${destination}" is not an allowed destination`, request)
    }
    let service: X402Service | undefined
    if (request.action === 'x402') {
      service = x402 && matchService(x402.services, request.url)
      if (service === undefined) {
        throw denied('services', `${request.url} is not an approved x402 service`, request)
      }
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
    // Check the caps before asking a human, so nobody approves an action that would fail.
    const entries = await readLedger(request)
    const limited = overLimit(request, amount, service, entries, now())
    if (limited) throw limited

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

    // A service the ledger has paid before was approved then; the budgets decide from here.
    let firstPayment = false
    if (
      request.action === 'x402' &&
      service !== undefined &&
      !entries.some((entry) => entry.action === 'x402' && entry.service === service.match)
    ) {
      const { approved, approverError } = await waitForApproval({
        action: 'x402',
        chain: request.chain,
        destination,
        amount: request.amount,
        url: request.url,
        reason: request.reason,
        service: service.match,
        category: service.category,
      })
      if (!approved) {
        throw denied(
          'firstPayment',
          `approval required: the first payment to "${service.match}" needs the owner's approval, and none was given`,
          request,
          { service: service.match, ...(approverError ? { approverError } : {}) },
        )
      }
      checkExpiry(request)
      firstPayment = true
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
            ...(service ? { service: service.match, category: service.category } : {}),
            ...(firstPayment ? { firstPayment: true as const } : {}),
          }
        : {}),
    }
    let result: ReserveResult<TgbpKitError>
    try {
      // Again under the ledger lock: another process may have spent since the check above.
      result = await ledger.reserve(entry, (recorded) => {
        // Stamp the entry with the time it is checked at, after any wait for the lock.
        const checkedAt = now()
        entry.at = checkedAt.toISOString()
        entry.day = utcDay(checkedAt)
        return overLimit(request, amount, service, recorded, checkedAt)
      })
    } catch (error) {
      throw ledgerDenied(ledger.path, request, error)
    }
    if (!result.ok) throw result.refusal
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
      throw new TgbpKitError(
        'SPEND_POLICY_DENIED',
        `The spend ledger ${ledger.path} cannot be read, so today's budget is unknown`,
        {
          cause: error,
          details: { rule: 'ledger', ledgerPath: ledger.path, ledgerError: errorMessage(error) },
        },
      )
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
      details: { ...request, ...extra, rule },
    },
  )
}

function ledgerDenied(path: string, request: SpendRequest, cause: unknown): TgbpKitError {
  return new TgbpKitError(
    'SPEND_POLICY_DENIED',
    `Spend policy refused ${request.action}: the spend ledger ${path} cannot be read or written, so the daily cap cannot be checked`,
    {
      cause,
      details: { ...request, rule: 'ledger', ledgerPath: path, ledgerError: errorMessage(cause) },
    },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
