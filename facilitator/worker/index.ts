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
    return stub(env).fetch(
      new Request(request.url, { method: request.method, headers: request.headers, body }),
    )
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(stub(env).fetch(new Request('https://facilitator/gas-check', { method: 'POST' })))
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
  private checking?: Promise<Response>
  private built?: Promise<{ facilitator: Facilitator; publicClient: PublicClient; address: Hex }>

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/gas-check') return this.gasCheck()
    return handle(request, {
      facilitator: async () => (await this.build()).facilitator,
      authToken: this.env.FACILITATOR_AUTH_TOKEN,
      token: this.token(),
      serialize: (run) => this.serialize(run),
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
   * while the first awaits the balance, and send the alert twice.
   */
  private gasCheck(): Promise<Response> {
    if (!this.checking) {
      this.checking = this.runGasCheck().finally(() => {
        this.checking = undefined
      })
    }
    return this.checking.then((response) => response.clone())
  }

  private async runGasCheck(): Promise<Response> {
    try {
      const { publicClient, address } = await this.build()
      const result = await checkGas({
        storage: this.state.storage,
        address,
        balance: () => publicClient.getBalance({ address }),
        threshold: parseEther(this.env.MIN_GAS_ETH ?? '0.001'),
        notify: (text) => this.alert(text),
      })
      return Response.json({ result })
    } catch (error) {
      console.error('gas check failed', describeError(error))
      return Response.json({ error: 'gas check failed' }, { status: 500 })
    }
  }

  private async alert(text: string): Promise<void> {
    console.error('low gas', text)
    const url = this.env.ALERT_WEBHOOK_URL
    if (!url) return
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
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
