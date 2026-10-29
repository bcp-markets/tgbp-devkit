/**
 * tGBP's x402 facilitator: the x402 reference facilitator's `exact` and
 * `upto` EVM schemes, with EIP-2612 gas sponsoring, for tGBP on one chain.
 * It pays the gas for each settlement from a gas-only key that holds ETH and
 * never tGBP; the payer's signed permit moves the tGBP straight to the payee.
 *
 * GET /supported is public. POST /verify and POST /settle need the bearer
 * token. A cron trigger checks the gas key's ETH balance (`checkGas`).
 */
import { toFacilitatorEvmSigner } from '@x402/evm'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  type PublicClient,
  parseEther,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import { assertClientChain } from '../../src/evm/checks.js'
import { type EvmTokenDeployment, getEvmToken } from '../../src/registry/index.js'
import {
  Busy,
  checkGas,
  createTgbpFacilitator,
  describeError,
  type Facilitator,
  type FacilitatorStorage,
  handle,
  NotConfigured,
  StoragePendingSettlements,
  StorageSettledPayments,
} from './facilitator.js'

// The few runtime types this Worker touches, so it needs no workers-types package.
interface Fetcher {
  fetch(request: Request): Promise<Response>
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): Fetcher
}
interface DurableObjectState {
  storage: FacilitatorStorage
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface Env {
  FACILITATOR: DurableObjectNamespace
  /** `base` or `base-sepolia`, a wrangler.jsonc var. */
  FACILITATOR_CHAIN?: string
  /** The gas key, a Worker secret. It holds ETH for gas only, never tGBP. */
  FACILITATOR_PRIVATE_KEY?: string
  /** A Worker secret. Required: the facilitator has no public RPC default. */
  FACILITATOR_RPC_URL?: string
  /** The bearer token for /verify and /settle, a Worker secret. */
  FACILITATOR_AUTH_TOKEN?: string
  /** Where the low-gas alert is posted as `{"text": "…"}`, a Worker secret. */
  ALERT_WEBHOOK_URL?: string
  /** The low-gas alert threshold in ETH, a wrangler.jsonc var. */
  MIN_GAS_ETH?: string
}

const CHAINS = ['base', 'base-sepolia'] as const
/** Settlements waiting behind a slow one; past this the facilitator answers busy rather than queue. */
const MAX_PENDING_SETTLEMENTS = 20

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (!['/supported', '/verify', '/settle'].includes(pathname)) {
      return Response.json({ error: 'not found' }, { status: 404 })
    }
    // Buffer the body: a streamed body the Durable Object answers without reading, a 401 say, throws.
    const body = request.method === 'POST' ? await request.arrayBuffer() : undefined
    try {
      return await stub(env).fetch(
        new Request(request.url, { method: request.method, headers: request.headers, body }),
      )
    } catch (error) {
      // A retry is safe: the pending and settled stores and the Permit2 nonce stop a second payment.
      console.error('facilitator request failed', describeError(error))
      return Response.json(
        { error: 'the settlement outcome is unknown; retry with the same payment' },
        { status: 503 },
      )
    }
  },

  /** Throws when the gas check fails, so the cron run is marked failed. */
  async scheduled(_controller: unknown, env: Env, _ctx: ExecutionContext): Promise<void> {
    const response = await stub(env).fetch(
      new Request('https://facilitator/gas-check', { method: 'POST' }),
    )
    if (!response.ok) throw new Error(`gas check failed: ${response.status}`)
  },
}

/** One instance holds the signer, so settlements run one at a time and the pending store is shared. */
function stub(env: Env): Fetcher {
  return env.FACILITATOR.get(env.FACILITATOR.idFromName('facilitator'))
}

export class TgbpFacilitator {
  private readonly state: DurableObjectState
  private readonly env: Env
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  private checking?: Promise<{ status: number; body: unknown }>
  private readonly settledPayments: StorageSettledPayments
  private built?: Promise<{ facilitator: Facilitator; publicClient: PublicClient; address: Hex }>

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.settledPayments = new StorageSettledPayments(state.storage)
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/gas-check') return this.gasCheck()
    let token: EvmTokenDeployment
    try {
      token = this.token()
    } catch (error) {
      if (!(error instanceof NotConfigured)) throw error
      console.error('facilitator not configured', error.message)
      return Response.json({ error: 'the facilitator is not configured' }, { status: 503 })
    }
    return handle(request, {
      facilitator: async () => (await this.build()).facilitator,
      authToken: this.env.FACILITATOR_AUTH_TOKEN,
      token,
      serialize: (run) => this.serialize(run),
      settled: this.settledPayments,
    })
  }

  private async serialize<T>(run: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING_SETTLEMENTS) {
      throw new Busy()
    }
    this.pending++
    try {
      const next = this.queue.then(run)
      this.queue = next.catch(() => undefined)
      return await next
    } finally {
      this.pending--
    }
  }

  /**
   * Joins a check already running: a second check would read the alert time
   * while the first awaits the balance, and send the alert twice. Each caller
   * gets its own Response built from the shared result.
   */
  private gasCheck(): Promise<Response> {
    if (!this.checking) {
      this.checking = this.runGasCheck().finally(() => {
        this.checking = undefined
      })
    }
    return this.checking.then(({ status, body }) => Response.json(body, { status }))
  }

  /** The token is resolved inside `build()`, so a bad FACILITATOR_CHAIN is caught here too. */
  private async runGasCheck(): Promise<{ status: number; body: unknown }> {
    try {
      const { publicClient, address } = await this.build()
      const result = await checkGas({
        storage: this.state.storage,
        address,
        balance: () => publicClient.getBalance({ address }),
        threshold: this.minGas(),
        notify: (text) => this.alert(text),
      })
      return { status: 200, body: { result } }
    } catch (error) {
      console.error('gas check failed', describeError(error))
      return { status: 500, body: { error: 'gas check failed' } }
    }
  }

  /** MIN_GAS_ETH in wei; a typo must not turn the alert off. */
  private minGas(): bigint {
    const eth = this.env.MIN_GAS_ETH ?? '0.001'
    if (!/^\d+(\.\d+)?$/.test(eth) || parseEther(eth) === 0n) {
      throw new NotConfigured('MIN_GAS_ETH must be a positive ETH amount')
    }
    return parseEther(eth)
  }

  /** Throws when the alert is not sent, so checkGas does not record it and tries again. */
  private async alert(text: string): Promise<void> {
    console.error('low gas', text)
    const url = this.env.ALERT_WEBHOOK_URL
    if (!url) throw new NotConfigured('ALERT_WEBHOOK_URL is not set')
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`alert webhook answered ${response.status}`)
  }

  private token(): EvmTokenDeployment {
    const chain = this.env.FACILITATOR_CHAIN ?? 'base'
    if (!(CHAINS as readonly string[]).includes(chain)) {
      throw new NotConfigured(`FACILITATOR_CHAIN must be one of ${CHAINS.join(', ')}`)
    }
    return getEvmToken(chain as (typeof CHAINS)[number])
  }

  private build() {
    if (!this.built) {
      this.built = this.create()
      // A failed build, a missing secret or an RPC on the wrong chain, is tried again next request.
      this.built.catch(() => {
        this.built = undefined
      })
    }
    return this.built
  }

  private async create() {
    const token = this.token()
    const key = this.env.FACILITATOR_PRIVATE_KEY
    if (!key) throw new NotConfigured('FACILITATOR_PRIVATE_KEY is not set')
    const url = this.env.FACILITATOR_RPC_URL
    if (!url) throw new NotConfigured('FACILITATOR_RPC_URL is not set')
    if (token.network === 'mainnet' && url === base.rpcUrls.default.http[0]) {
      throw new NotConfigured('FACILITATOR_RPC_URL is the public Base RPC; use a private one')
    }
    let account: ReturnType<typeof privateKeyToAccount>
    try {
      account = privateKeyToAccount(key as Hex)
    } catch {
      throw new NotConfigured('FACILITATOR_PRIVATE_KEY is not a private key')
    }
    const chain = defineChain({
      id: token.chainId,
      name: token.chain,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    })
    const publicClient = createPublicClient({ chain, transport: http(url) })
    const walletClient = createWalletClient({ account, chain, transport: http(url) })
    try {
      await assertClientChain(publicClient, token)
    } catch (error) {
      throw new NotConfigured(`FACILITATOR_RPC_URL: ${describeError(error)}`)
    }

    const signer = toFacilitatorEvmSigner({
      address: account.address,
      readContract: (args) => publicClient.readContract(args as never),
      verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
      writeContract: (args) => walletClient.writeContract(args as never),
      sendTransaction: (args) => walletClient.sendTransaction(args),
      waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
      getCode: (args) => publicClient.getCode(args),
    })
    const facilitator = createTgbpFacilitator(
      signer,
      token,
      new StoragePendingSettlements(this.state.storage),
    )
    return { facilitator, publicClient: publicClient as PublicClient, address: account.address }
  }
}
