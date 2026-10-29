/**
 * The x402 facilitator's rules: who may ask it to verify or settle, which
 * payments it takes, where it keeps settlements that are still pending, and
 * when it warns that its gas key is running low. The Durable Object in
 * `index.ts` holds the signer and runs one settlement at a time.
 */
import { type PendingSettlementStore, x402Facilitator } from '@x402/core/facilitator'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import type { FacilitatorEvmSigner } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/facilitator'
import { UptoEvmScheme } from '@x402/evm/upto/facilitator'
import { type Address, formatEther, getAddress, isAddress } from 'viem'

import type { EvmTokenDeployment } from '../../src/registry/index.js'
import { x402Network } from '../../src/x402/token.js'

/**
 * `@x402/extensions`' `EIP2612_GAS_SPONSORING`. Importing that package pulls
 * Node built-ins into the Worker; `@x402/evm` carries its own copy of the code.
 */
export const EIP2612_GAS_SPONSORING = { key: 'eip2612GasSponsoring' } as const

/** The schemes the facilitator registers. */
export const SCHEMES = ['exact', 'upto'] as const

/** A pending settlement is retried by its tx hash for this long; the x402 in-memory store's TTL. */
export const PENDING_TTL_MS = 5 * 60 * 1000

/** A low-gas alert repeats at most this often while the balance stays low. */
export const ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000

const MAX_BODY_BYTES = 16 * 1024

/** The subset of Durable Object storage the facilitator uses. */
export interface FacilitatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Thrown when a secret the facilitator needs is not set; answered with 503. */
export class NotConfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotConfigured'
  }
}

/** Thrown by `serialize` when too many settlements are waiting; answered with 503. */
export class Busy extends Error {
  constructor() {
    super('too many settlements are waiting')
    this.name = 'Busy'
  }
}

export type Facilitator = Pick<x402Facilitator, 'getSupported' | 'verify' | 'settle'>

/**
 * The x402 reference facilitator with the `exact` and `upto` schemes on the
 * token's chain only, and the `eip2612GasSponsoring` extension, which lets a
 * payer with no ETH sign a permit that the settlement submits for them.
 */
export function createTgbpFacilitator(
  signer: FacilitatorEvmSigner,
  token: EvmTokenDeployment,
  pendingSettlementStore: PendingSettlementStore,
): x402Facilitator {
  const network = x402Network(token)
  return new x402Facilitator()
    .register(network, new ExactEvmScheme(signer, { pendingSettlementStore }))
    .register(network, new UptoEvmScheme(signer, { pendingSettlementStore }))
    .registerExtension(EIP2612_GAS_SPONSORING)
}

export interface HandleDeps {
  /** Builds the facilitator on first use; throws `NotConfigured` without its secrets. */
  facilitator: () => Promise<Facilitator>
  /** The bearer token `/verify` and `/settle` require. Unset, they answer 503. */
  authToken: string | undefined
  token: EvmTokenDeployment
  /** Runs settlements one at a time, so the gas key's nonces never race. */
  serialize: <T>(run: () => Promise<T>) => Promise<T>
}

/**
 * Answers the x402 facilitator API: `GET /supported` for anyone, and
 * `POST /verify` and `POST /settle` for callers holding the bearer token, so
 * no one else can spend the gas key's ETH. It takes tGBP on its own chain only.
 */
export async function handle(request: Request, deps: HandleDeps): Promise<Response> {
  const { pathname } = new URL(request.url)
  const action = pathname === '/verify' ? 'verify' : pathname === '/settle' ? 'settle' : undefined
  if (pathname === '/supported') {
    if (request.method !== 'GET') return json(405, { error: 'use GET' }, { allow: 'GET' })
  } else if (action === undefined) {
    return json(404, { error: 'not found' })
  } else if (request.method !== 'POST') {
    return json(405, { error: 'use POST' }, { allow: 'POST' })
  } else if (deps.authToken === undefined || deps.authToken === '') {
    return json(503, { error: 'the facilitator is not configured' })
  } else if (!(await authorized(request, deps.authToken))) {
    return json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
  }

  try {
    const facilitator = await deps.facilitator()
    if (action === undefined) return json(200, facilitator.getSupported())

    const body = await readBody(request)
    if (!body) {
      return json(400, { error: 'send JSON with paymentPayload and paymentRequirements' })
    }
    const { paymentPayload, paymentRequirements } = body
    const refusal = refuse(paymentRequirements, deps.token)
    if (action === 'verify') {
      if (refusal) return json(200, { isValid: false, invalidReason: refusal })
      return json(200, await facilitator.verify(paymentPayload, paymentRequirements))
    }
    if (refusal) {
      return json(200, {
        success: false,
        errorReason: refusal,
        transaction: '',
        network: paymentRequirements.network,
      })
    }
    return json(
      200,
      await deps.serialize(() => facilitator.settle(paymentPayload, paymentRequirements)),
    )
  } catch (error) {
    if (error instanceof NotConfigured) {
      console.error('facilitator not configured', error.message)
      return json(503, { error: 'the facilitator is not configured' })
    }
    if (error instanceof Busy) {
      return json(503, { error: 'the facilitator is busy; nothing was settled' })
    }
    console.error(`facilitator ${action ?? 'supported'} failed`, describeError(error))
    return json(500, { error: `${action ?? 'supported'} failed` })
  }
}

/** Why the facilitator will not take these requirements, or undefined if it will. */
export function refuse(
  requirements: PaymentRequirements,
  token: EvmTokenDeployment,
): string | undefined {
  if (requirements.network !== x402Network(token)) return 'invalid_network'
  if (!(SCHEMES as readonly string[]).includes(requirements.scheme)) return 'unsupported_scheme'
  if (
    typeof requirements.asset !== 'string' ||
    !isAddress(requirements.asset) ||
    getAddress(requirements.asset) !== getAddress(token.address)
  ) {
    return 'unsupported_asset'
  }
  return undefined
}

/** Compares SHA-256 digests, so the comparison takes the same time for every wrong token. */
async function authorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  const [a, b] = await Promise.all([digest(given), digest(token)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function readBody(
  request: Request,
): Promise<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return null
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body !== 'object' || body === null) return null
    const { paymentPayload, paymentRequirements } = body as Record<string, unknown>
    if (!isObject(paymentPayload) || !isObject(paymentRequirements)) return null
    return {
      paymentPayload: paymentPayload as unknown as PaymentPayload,
      paymentRequirements: paymentRequirements as unknown as PaymentRequirements,
    }
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * x402's pending-settlement store in Durable Object storage, so a settlement
 * whose receipt timed out is found again by its tx hash after a restart, and
 * the retry cannot broadcast it twice.
 */
export class StoragePendingSettlements implements PendingSettlementStore {
  constructor(
    private readonly storage: FacilitatorStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const entry = await this.storage.get<{ txHash: string; at: number }>(`pending:${key}`)
    if (!entry) return undefined
    if (this.now() - entry.at > PENDING_TTL_MS) {
      await this.storage.delete(`pending:${key}`)
      return undefined
    }
    return entry.txHash
  }

  async set(key: string, txHash: string): Promise<void> {
    await this.storage.put(`pending:${key}`, { txHash, at: this.now() })
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(`pending:${key}`)
  }
}

export interface GasCheckDeps {
  storage: FacilitatorStorage
  address: Address
  balance: () => Promise<bigint>
  /** Alert below this many wei. */
  threshold: bigint
  /** Sends the alert; the caller also logs it. */
  notify: (text: string) => Promise<void>
  now?: () => number
}

export type GasCheckResult = 'ok' | 'alerted' | 'already-alerted'

/**
 * Alerts when the gas key holds less ETH than the threshold: at once, then at
 * most every `ALERT_INTERVAL_MS` while it stays low. Topping it up re-arms it.
 */
export async function checkGas({
  storage,
  address,
  balance,
  threshold,
  notify,
  now = Date.now,
}: GasCheckDeps): Promise<GasCheckResult> {
  const wei = await balance()
  if (wei >= threshold) {
    await storage.delete('gas-alerted-at')
    return 'ok'
  }
  const last = await storage.get<number>('gas-alerted-at')
  if (last !== undefined && now() - last < ALERT_INTERVAL_MS) return 'already-alerted'
  await notify(
    `x402 facilitator gas key ${address} holds ${formatEther(wei)} ETH, below the ${formatEther(threshold)} ETH alert threshold. Settlements fail once it runs out.`,
  )
  await storage.put('gas-alerted-at', now())
  return 'alerted'
}

/** The error's name and short message, never a stack that could carry an RPC URL. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage
    return `${error.name}: ${typeof short === 'string' ? short : error.message}`
  }
  return String(error)
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}
