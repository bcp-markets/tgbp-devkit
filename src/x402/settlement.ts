import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FacilitatorClient } from '@x402/core/server'
import { x402HTTPResourceServer } from '@x402/core/server'
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types'
import { SettleError } from '@x402/core/types'

import { MAX_PAYMENT_WINDOW_SECONDS } from './token.js'

/** The `errorReason` for a settlement submitted but not yet confirmed. */
export const SETTLEMENT_PENDING = 'settlement_pending'

/** The `errorReason` for a payment that has already bought a response. */
export const PAYMENT_ALREADY_SETTLED = 'payment_already_settled'

/** How long a buyer waits before it retries a pending payment, in seconds. */
export const SETTLEMENT_RETRY_AFTER_SECONDS = 2

// A record outlives its payment's deadline by this much. Permit2 refuses a
// transfer after its deadline, so by then a pending settlement has landed or
// failed, and the grace covers the facilitator learning which.
const RECORD_GRACE_SECONDS = 600

interface PaymentRecord {
  payment: PaymentPayload
  requirements: PaymentRequirements
  payer: string | undefined
  /** The last settlement transaction the facilitator reported, or ''. */
  transaction: string
  expiresAt: number
  /** The settlement in flight for this payment, if any. */
  settling: Promise<SettleResponse> | undefined
  settled: boolean
}

type Permit2Fields = { from?: unknown; nonce?: unknown; deadline?: unknown }

function permit2Of(payment: PaymentPayload): Permit2Fields | undefined {
  return (payment.payload as { permit2Authorization?: Permit2Fields } | undefined)
    ?.permit2Authorization
}

/**
 * The payment's identity. An exact-scheme Permit2 payment is its payer and
 * Permit2 nonce on its network: the pair Permit2 itself refuses to spend
 * twice. Any other payload is identified by a hash of what was signed.
 */
export function paymentKey(payment: PaymentPayload): string {
  const auth = permit2Of(payment)
  if (typeof auth?.from === 'string' && typeof auth.nonce === 'string') {
    let nonce = auth.nonce
    try {
      nonce = BigInt(auth.nonce).toString()
    } catch {
      // Not a number; the facilitator refuses it, so its spelling can stand as the key.
    }
    return `permit2:${payment.accepted.network}:${auth.from.toLowerCase()}:${nonce}`
  }
  const signed = JSON.stringify(payment.payload ?? null)
  return `payload:${createHash('sha256').update(signed).digest('hex')}`
}

function expiryOf(payment: PaymentPayload, now: number): number {
  const latest = now + MAX_PAYMENT_WINDOW_SECONDS * 1000
  const deadline = Number(permit2Of(payment)?.deadline)
  const until = Number.isFinite(deadline) ? Math.min(deadline * 1000, latest) : latest
  return until + RECORD_GRACE_SECONDS * 1000
}

function pending(
  requirements: PaymentRequirements,
  transaction: string,
  errorMessage: string,
): SettleResponse {
  return {
    success: false,
    errorReason: SETTLEMENT_PENDING,
    errorMessage,
    transaction,
    network: requirements.network,
  }
}

/**
 * Wraps a facilitator so each payment settles at most once and buys at most
 * one response.
 *
 * - A pending settlement is kept. A retry of the identical payment skips
 *   verification, because its Permit2 nonce may already be spent on chain,
 *   and asks the facilitator to settle it again, which reports how the first
 *   submission ended.
 * - Once a payment has been pending, or a refusal names its transaction, it
 *   stays pending until it settles: such a refusal does not prove nothing
 *   moved on chain.
 * - A facilitator that throws, times out or answers 5xx while settling leaves
 *   the outcome unknown, so that counts as pending too.
 * - A settled payment is refused if it comes back, on any route.
 * - Another payload under a pending payment's identity gets the pending
 *   answer, and never replaces the payment the facilitator is settling.
 * - A payment refused with no transaction before it was ever pending is
 *   forgotten, and the facilitator rules on a retry.
 *
 * Payments are remembered in this process only, until ten minutes after
 * their deadline. A payment forgotten unconfirmed is logged for the seller to
 * reconcile against its transaction.
 */
export function settleOnce(facilitator: FacilitatorClient, now = Date.now): FacilitatorClient {
  const records = new Map<string, PaymentRecord>()

  const sweep = () => {
    const time = now()
    for (const [key, record] of records) {
      if (record.settling !== undefined || record.expiresAt > time) continue
      if (!record.settled) {
        console.error('tGBP x402: forgetting a payment that never confirmed; reconcile it', {
          key,
          transaction: record.transaction,
          payer: record.payer,
        })
      }
      records.delete(key)
    }
  }

  const isSame = (
    record: PaymentRecord,
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ) =>
    isDeepStrictEqual(record.payment, payment) &&
    isDeepStrictEqual(record.requirements, requirements)

  const alreadySettled = (
    requirements: PaymentRequirements,
    record: PaymentRecord,
  ): SettleResponse => ({
    success: false,
    errorReason: PAYMENT_ALREADY_SETTLED,
    transaction: '',
    network: requirements.network,
    ...(record.payer === undefined ? {} : { payer: record.payer }),
  })

  const settleAndClassify = async (
    key: string,
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> => {
    try {
      const result = await facilitator.settle(payment, requirements)
      if (typeof result !== 'object' || result === null) {
        throw new TypeError('facilitator.settle returned no settlement response')
      }
      return result
    } catch (error) {
      if (error instanceof SettleError && error.statusCode < 500) {
        return {
          success: false,
          errorReason: error.errorReason ?? 'settlement_failed',
          ...(error.errorMessage === undefined ? {} : { errorMessage: error.errorMessage }),
          ...(error.payer === undefined ? {} : { payer: error.payer }),
          transaction: error.transaction,
          network: error.network,
        }
      }
      // The buyer sees only that the outcome is unknown; the seller's log gets the cause.
      console.error('tGBP x402: the facilitator gave no settlement result', { key }, error)
      return pending(
        requirements,
        error instanceof SettleError ? error.transaction : '',
        'the facilitator gave no settlement result',
      )
    }
  }

  const settleRecord = async (
    key: string,
    record: PaymentRecord,
    wasPending: boolean,
  ): Promise<SettleResponse> => {
    let result = await settleAndClassify(key, record.payment, record.requirements)
    record.transaction = result.transaction || record.transaction
    record.payer = result.payer ?? record.payer
    // A refusal for a payment that was pending, or one that names a
    // transaction, does not prove nothing moved on chain.
    const mayLand = wasPending || record.transaction !== ''
    if (!result.success && result.errorReason !== SETTLEMENT_PENDING && mayLand) {
      console.error('tGBP x402: a refusal for a payment that may still land; keeping it pending', {
        key,
        errorReason: result.errorReason,
        transaction: record.transaction,
      })
      result = pending(
        record.requirements,
        record.transaction,
        `the facilitator answered ${result.errorReason ?? 'a failure'} for a payment that may still land`,
      )
    }
    if (result.success) record.settled = true
    else if (result.errorReason !== SETTLEMENT_PENDING) records.delete(key)
    return result
  }

  return {
    getSupported: () => facilitator.getSupported(),

    async verify(payment, requirements): Promise<VerifyResponse> {
      sweep()
      const record = records.get(paymentKey(payment))
      if (record?.settled) {
        return {
          isValid: false,
          invalidReason: PAYMENT_ALREADY_SETTLED,
          ...(record.payer === undefined ? {} : { payer: record.payer }),
        }
      }
      if (record !== undefined && isSame(record, payment, requirements)) {
        return { isValid: true, ...(record.payer === undefined ? {} : { payer: record.payer }) }
      }
      return facilitator.verify(payment, requirements)
    },

    async settle(payment, requirements): Promise<SettleResponse> {
      sweep()
      const key = paymentKey(payment)
      const existing = records.get(key)
      if (existing?.settled) return alreadySettled(requirements, existing)
      if (existing?.settling !== undefined) {
        const result = await existing.settling
        return result.success ? alreadySettled(requirements, existing) : result
      }
      if (existing !== undefined && !isSame(existing, payment, requirements)) {
        return pending(requirements, existing.transaction, 'this payment is still settling')
      }

      const record: PaymentRecord = existing ?? {
        payment,
        requirements,
        payer: undefined,
        transaction: '',
        expiresAt: expiryOf(payment, now()),
        settling: undefined,
        settled: false,
      }
      records.set(key, record)
      record.settling = settleRecord(key, record, existing !== undefined)
      try {
        return await record.settling
      } finally {
        record.settling = undefined
      }
    },
  }
}

/**
 * The x402 HTTP server, with a pending settlement answered as HTTP 503 and
 * `Retry-After` instead of 402. A 402 asks the buyer to pay, and paying again
 * while the first payment is still settling is how a buyer pays twice.
 */
export class TgbpHTTPResourceServer extends x402HTTPResourceServer {
  override async processSettlement(
    ...args: Parameters<x402HTTPResourceServer['processSettlement']>
  ): ReturnType<x402HTTPResourceServer['processSettlement']> {
    const result = await super.processSettlement(...args)
    if (result.success || result.errorReason !== SETTLEMENT_PENDING) return result
    return {
      ...result,
      response: {
        ...result.response,
        status: 503,
        headers: {
          ...result.response.headers,
          'Retry-After': String(SETTLEMENT_RETRY_AFTER_SECONDS),
        },
      },
    }
  }
}
