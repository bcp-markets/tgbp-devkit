// The test tGBP faucet: a fixed amount of test tGBP on Base Sepolia, once a day per address.
// The client needs no peer dependency, so `npx tgbp-faucet` runs on a bare install.
import { TgbpKitError } from '../errors.js'

/** The faucet service behind the developer site. */
export const TEST_TGBP_FAUCET_URL = 'https://dev.tokenisedgbp.com/api/faucet'

/** Base Sepolia, the only chain the faucet funds. */
export const FAUCET_CHAIN_ID = 84532

/** What one request sends, in whole test tGBP. */
export const FAUCET_DRIP_TGBP = '10'

/** Why the faucet sent nothing. */
export type FaucetRefusalReason =
  /** The body is not JSON with a valid EVM `address`. */
  | 'invalid_request'
  /** The request named a chain other than Base Sepolia. */
  | 'wrong_chain'
  /** This address or IP address had test tGBP in the last 24 hours. */
  | 'rate_limited'
  /** The faucet has sent its daily total; it resets at midnight UTC. */
  | 'daily_limit'
  /** The faucet could not send; nothing was sent. */
  | 'unavailable'

export interface FaucetDrip {
  ok: true
  /** The Base Sepolia transaction hash. */
  hash: `0x${string}`
  /** Whole test tGBP, e.g. `"10"`. */
  amount: string
  /**
   * False when the transfer was broadcast but its receipt did not arrive in time.
   * It may still land: check `explorerUrl` before asking again.
   */
  confirmed: boolean
  explorerUrl: string
}

export interface FaucetRefusal {
  ok: false
  reason: FaucetRefusalReason
  /** One sentence a person can act on. */
  message: string
  /** When a retry can succeed, for `rate_limited` and `daily_limit`. */
  retryAfterSeconds?: number
}

/** The faucet's JSON response body. */
export type FaucetResponse = FaucetDrip | FaucetRefusal

export interface RequestTestTgbpParams {
  /** The EVM address to fund. */
  address: string
  /** Must be 84532 (Base Sepolia) when set; the faucet funds no other chain. */
  chainId?: number
  /** Another faucet endpoint, such as a local `wrangler dev`. */
  url?: string
  fetch?: typeof globalThis.fetch
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Asks the faucet for test tGBP on Base Sepolia. A refusal throws
 * `FAUCET_REFUSED` with `details.reason` and, for a rate limit,
 * `details.retryAfterSeconds`. A wrong chain or a malformed address throws
 * before anything is sent.
 */
export async function requestTestTgbp({
  address,
  chainId = FAUCET_CHAIN_ID,
  url = TEST_TGBP_FAUCET_URL,
  fetch = globalThis.fetch,
}: RequestTestTgbpParams): Promise<FaucetDrip> {
  if (chainId !== FAUCET_CHAIN_ID) {
    throw refused({
      ok: false,
      reason: 'wrong_chain',
      message: `The faucet sends test tGBP on Base Sepolia (chain ${FAUCET_CHAIN_ID}) only, not chain ${chainId}.`,
    })
  }
  if (!EVM_ADDRESS.test(address)) {
    throw refused({
      ok: false,
      reason: 'invalid_request',
      message: `${address} is not an EVM address.`,
    })
  }

  let status: number
  let text: string
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ address, chainId }),
    })
    status = response.status
    text = await response.text()
  } catch (cause) {
    throw new Error(`Could not reach the faucet at ${url}`, { cause })
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (typeof body === 'object' && body !== null) {
    const answer = body as Partial<FaucetDrip> & Partial<FaucetRefusal>
    if (answer.ok === true && typeof answer.hash === 'string') return answer as FaucetDrip
    if (answer.ok === false && typeof answer.message === 'string') {
      throw refused(answer as FaucetRefusal)
    }
  }
  throw new Error(`The faucet at ${url} answered ${status} without a faucet response`)
}

function refused(refusal: FaucetRefusal): TgbpKitError {
  return new TgbpKitError('FAUCET_REFUSED', refusal.message, {
    details: {
      reason: refusal.reason,
      ...(refusal.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: refusal.retryAfterSeconds }),
    },
  })
}
