/**
 * The test tGBP faucet's rules: who gets a drip, and what the faucet answers.
 * The Durable Object in `index.ts` runs one drip at a time, so these checks
 * and the send never interleave.
 */
import { type Address, getAddress, type Hash, isAddress, zeroAddress } from 'viem'

import { isTgbpKitError } from '../../src/errors.js'
import {
  FAUCET_CHAIN_ID,
  FAUCET_DRIP_TGBP,
  type FaucetRefusal,
  type FaucetResponse,
} from '../../src/faucet/index.js'

/** One drip per address, and per client network, in this window. */
export const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Caps what a flood of fresh addresses and networks can drain in a day (UTC). */
export const DAILY_DRIP_LIMIT = 200

/** The subset of Durable Object storage the faucet uses. */
export interface FaucetStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface DripRequest {
  address?: unknown
  chainId?: unknown
  /** The client IP, from `CF-Connecting-IP`. */
  ip: string
}

/**
 * Thrown by `send` for a failure before anything was signed, so the claim can
 * be given back. Any other error may come after the broadcast.
 */
export class DripNotSent extends Error {
  constructor(cause: unknown) {
    super('the faucet failed before it signed the transfer', { cause })
    this.name = 'DripNotSent'
  }
}

export interface DripDeps {
  storage: FaucetStorage
  /**
   * Sends the drip and resolves with the hash once it is mined. Throws
   * `DripNotSent` when nothing was signed; a `TRANSFER_UNCONFIRMED` error means
   * it was broadcast and may still land.
   */
  send: (to: Address) => Promise<Hash>
  /** The block explorer's base URL, e.g. `https://sepolia.basescan.org`. */
  explorerUrl: string
  now?: () => number
}

export interface DripResult {
  status: number
  body: FaucetResponse
}

export async function drip(request: DripRequest, deps: DripDeps): Promise<DripResult> {
  const { storage, send, explorerUrl } = deps
  const now = (deps.now ?? Date.now)()

  if (request.chainId !== undefined && request.chainId !== FAUCET_CHAIN_ID) {
    return refuse(400, {
      reason: 'wrong_chain',
      message: `The faucet sends test tGBP on Base Sepolia (chain ${FAUCET_CHAIN_ID}) only, not chain ${String(request.chainId)}.`,
    })
  }
  const { address } = request
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    return refuse(400, { reason: 'invalid_request', message: 'Send a valid EVM address.' })
  }
  const to = getAddress(address)
  if (to === zeroAddress) {
    return refuse(400, { reason: 'invalid_request', message: 'The zero address cannot hold tGBP.' })
  }

  const addressKey = `address:${to.toLowerCase()}`
  const networkKey = `network:${await sha256(ipBucket(request.ip))}`
  const day = new Date(now).toISOString().slice(0, 10)
  const dayKey = `day:${day}`

  const [addressLast, networkLast, dayCount = 0] = await Promise.all([
    storage.get<number>(addressKey),
    storage.get<number>(networkKey),
    storage.get<number>(dayKey),
  ])
  if (addressLast !== undefined && now - addressLast < RATE_LIMIT_WINDOW_MS) {
    return rateLimited('This address', addressLast, now)
  }
  if (networkLast !== undefined && now - networkLast < RATE_LIMIT_WINDOW_MS) {
    return rateLimited('Your network', networkLast, now)
  }
  if (dayCount >= DAILY_DRIP_LIMIT) {
    const midnight = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000
    return refuse(429, {
      reason: 'daily_limit',
      message: 'The faucet has sent its daily total. Try again after midnight UTC.',
      retryAfterSeconds: Math.ceil((midnight - now) / 1000),
    })
  }

  // Claim before sending: a drip that is broadcast must count even if its receipt never arrives.
  await Promise.all([
    storage.put(addressKey, now),
    storage.put(networkKey, now),
    storage.put(dayKey, dayCount + 1),
  ])

  let hash: Hash
  let confirmed = true
  try {
    hash = await send(to)
  } catch (error) {
    if (error instanceof DripNotSent) {
      console.error('faucet send failed before signing', describeError(error.cause))
      // Nothing was signed, so give the claim back.
      try {
        await Promise.all([
          restore(storage, addressKey, addressLast),
          restore(storage, networkKey, networkLast),
          storage.put(dayKey, dayCount),
        ])
      } catch (rollbackError) {
        console.error('faucet rollback failed', describeError(rollbackError))
      }
      return refuse(503, {
        reason: 'unavailable',
        message: 'The faucet cannot send right now, and nothing was sent. Try again later.',
      })
    }
    if (!isTgbpKitError(error, 'TRANSFER_UNCONFIRMED') || typeof error.details.hash !== 'string') {
      // Signed and perhaps broadcast, or mined and reverted: the claim stands, so a
      // retry cannot send twice and a failing transfer cannot burn gas in a loop.
      console.error('faucet send failed after signing', { to, error: describeError(error) })
      return refuse(503, { reason: 'unavailable', message: MAY_HAVE_SENT })
    }
    hash = error.details.hash as Hash
    confirmed = false
  }
  console.log('faucet drip', { to, hash, confirmed })

  return {
    status: confirmed ? 200 : 202,
    body: {
      ok: true,
      hash,
      amount: FAUCET_DRIP_TGBP,
      confirmed,
      explorerUrl: `${explorerUrl}/tx/${hash}`,
    },
  }
}

/**
 * The rate-limit bucket for a client IP: the address for IPv4, the /64
 * network for IPv6, because one IPv6 client can rotate through a whole /64.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped?.[1]) return mapped[1]
  const [head = '', tail] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const fill = Math.max(0, 8 - left.length - right.length)
  const groups = tail === undefined ? left : [...left, ...Array<string>(fill).fill('0'), ...right]
  const prefix = groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
  return `${prefix.join(':')}::/64`
}

/** The reply when a transfer may have gone out: never "nothing was sent". */
export const MAY_HAVE_SENT =
  'The faucet hit an error after signing the transfer, so the test tGBP may still arrive. Check the address on Base Sepolia before you ask again.'

/** An error's name and short message, without the RPC URL or request body viem adds. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const short = 'shortMessage' in error ? error.shortMessage : undefined
  return `${error.name}: ${typeof short === 'string' ? short : error.message}`
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function rateLimited(who: string, last: number, now: number): DripResult {
  const retryAfterSeconds = Math.ceil((last + RATE_LIMIT_WINDOW_MS - now) / 1000)
  const hours = Math.ceil(retryAfterSeconds / 3600)
  return refuse(429, {
    reason: 'rate_limited',
    message: `${who} had test tGBP in the last 24 hours. Try again in ${hours} hour${hours === 1 ? '' : 's'}.`,
    retryAfterSeconds,
  })
}

function refuse(status: number, refusal: Omit<FaucetRefusal, 'ok'>): DripResult {
  return { status, body: { ok: false, ...refusal } }
}

function restore(storage: FaucetStorage, key: string, previous: number | undefined) {
  return previous === undefined ? storage.delete(key) : storage.put(key, previous)
}
