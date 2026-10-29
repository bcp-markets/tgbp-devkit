/**
 * The developer site's Worker. It runs only for /api/* (`run_worker_first`
 * in wrangler.jsonc); the static assets serve every other path.
 *
 * POST /api/faucet sends test tGBP on Base Sepolia. A JSON body gets a JSON
 * answer, for `tgbp-faucet` and scripts; the quickstart's form gets a page.
 */
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hash,
  type Hex,
  http,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { parseAmount } from '../../src/amount.js'
import { assertCanTransfer, assertClientChain } from '../../src/evm/checks.js'
import { transfer } from '../../src/evm/index.js'
import { FAUCET_DRIP_TGBP, type FaucetResponse } from '../../src/faucet/index.js'
import { getEvmToken } from '../../src/registry/index.js'
import {
  DripNotSent,
  type DripRequest,
  describeError,
  drip,
  type FaucetStorage,
  MAY_HAVE_SENT,
} from './faucet.js'

// The few runtime types this Worker touches, so it needs no workers-types package.
interface Fetcher {
  fetch(request: Request): Promise<Response>
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): Fetcher
}
interface DurableObjectState {
  storage: FaucetStorage
}

export interface Env {
  ASSETS: Fetcher
  FAUCET: DurableObjectNamespace
  /** The faucet wallet's key, a Worker secret. It holds test tGBP and Base Sepolia ETH only. */
  FAUCET_PRIVATE_KEY?: string
  /** Defaults to Base's public RPC. */
  FAUCET_RPC_URL?: string
}

const TOKEN = getEvmToken('base-sepolia')
const MAX_BODY_BYTES = 1024
/** Drips waiting behind a slow one; past this the faucet answers busy rather than queue. */
const MAX_PENDING_DRIPS = 20

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname !== '/api/faucet') {
      return pathname.startsWith('/api/')
        ? json(404, { error: 'not found' })
        : env.ASSETS.fetch(request)
    }
    if (request.method !== 'POST') {
      return json(405, { error: 'use POST' }, { allow: 'POST' })
    }

    const ip = request.headers.get('cf-connecting-ip')
    const parsed = await readBody(request)
    if (!parsed || !ip) {
      return json(400, {
        ok: false,
        reason: 'invalid_request',
        message: 'Send JSON with an EVM address: {"address":"0x…"}.',
      })
    }

    // One Durable Object instance serves every drip, so they run one at a time.
    const faucet = env.FAUCET.get(env.FAUCET.idFromName('faucet'))
    const input: DripRequest = { ...parsed.fields, ip }
    let status: number
    let body: FaucetResponse
    try {
      const answer = await faucet.fetch(
        new Request('https://faucet/drip', { method: 'POST', body: JSON.stringify(input) }),
      )
      status = answer.status
      body = (await answer.json()) as FaucetResponse
    } catch (error) {
      // The Durable Object can fail or reset mid-send, so this cannot say nothing was sent.
      console.error('faucet request failed', describeError(error))
      status = 503
      body = { ok: false, reason: 'unavailable', message: MAY_HAVE_SENT }
    }
    return parsed.form ? page(status, body) : json(status, body)
  },
}

/** Runs drips one at a time, so the rate-limit checks and the wallet's nonces never race. */
export class Faucet {
  private readonly state: DurableObjectState
  private readonly env: Env
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  private sender?: (to: Address) => Promise<Hash>

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    if (this.pending >= MAX_PENDING_DRIPS) {
      return json(503, {
        ok: false,
        reason: 'unavailable',
        message: 'The faucet is busy, and nothing was sent. Try again in a minute.',
      })
    }
    // Count the request before its first await, so a burst cannot slip past the cap.
    this.pending++
    try {
      const input = (await request.json()) as DripRequest
      const run = this.queue.then(() =>
        drip(input, {
          storage: this.state.storage,
          send: (to) => this.send(to),
          explorerUrl: TOKEN.explorerUrl,
        }),
      )
      this.queue = run.catch(() => undefined)
      const { status, body } = await run
      return json(status, body)
    } finally {
      this.pending--
    }
  }

  private async send(to: Address): Promise<Hash> {
    if (!this.sender) {
      const key = this.env.FAUCET_PRIVATE_KEY
      if (!key) throw new DripNotSent(new Error('FAUCET_PRIVATE_KEY is not set'))
      let account: ReturnType<typeof privateKeyToAccount>
      try {
        account = privateKeyToAccount(key as Hex)
      } catch (cause) {
        throw new DripNotSent(cause)
      }
      const url = this.env.FAUCET_RPC_URL ?? 'https://sepolia.base.org'
      const chain = defineChain({
        id: TOKEN.chainId,
        name: TOKEN.chain,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [url] } },
      })
      const publicClient = createPublicClient({ chain, transport: http(url) })
      const walletClient = createWalletClient({ account, chain, transport: http(url) })
      const amount = parseAmount(FAUCET_DRIP_TGBP, TOKEN.decimals)
      this.sender = async (recipient) => {
        // The same checks transfer() runs before it signs, so their failures, a
        // mainnet RPC URL among them, are known to have sent nothing.
        try {
          await Promise.all([
            assertClientChain(publicClient, TOKEN),
            assertClientChain(walletClient, TOKEN),
          ])
          await assertCanTransfer(publicClient, TOKEN, account.address, recipient, amount)
        } catch (cause) {
          throw new DripNotSent(cause)
        }
        return (await transfer({ publicClient, walletClient, chain: TOKEN, to: recipient, amount }))
          .hash
      }
    }
    return this.sender(to)
  }
}

async function readBody(
  request: Request,
): Promise<{ fields: Pick<DripRequest, 'address' | 'chainId'>; form: boolean } | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return null
  const type = request.headers.get('content-type') ?? ''
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return { fields: { address: new URLSearchParams(text).get('address')?.trim() }, form: true }
  }
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body !== 'object' || body === null) return null
    const { address, chainId } = body as Record<string, unknown>
    return { fields: { address, chainId }, form: false }
  } catch {
    return null
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

/** The answer to the quickstart's form: a page in the site's style, with no script. */
function page(status: number, body: FaucetResponse): Response {
  const title = body.ok ? 'Test tGBP sent' : 'No test tGBP sent'
  const detail = body.ok
    ? `<p>${body.confirmed ? 'Sent' : 'Sent, not yet confirmed:'} ${escapeHtml(body.amount)} test tGBP on Base Sepolia.</p>
    <p><a href="${escapeHtml(body.explorerUrl)}">View the transaction</a></p>`
    : `<p>${escapeHtml(body.message)}</p>`
  const html = `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · tGBP developers</title>
  <meta name="robots" content="noindex">
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" type="image/png" href="/assets/favicon.png">
</head>
<body>
  <header>
    <a class="home" href="/"><img src="/assets/tgbp-logo.svg" alt="tGBP" width="107" height="40"> developers</a>
  </header>
  <main>
    <h1>${title}</h1>
    ${detail}
    <p><a href="/quickstart#fund">Back to the quickstart</a></p>
  </main>
</body>
</html>
`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  })
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  )
}
