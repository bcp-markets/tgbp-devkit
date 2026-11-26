import { x402Client, x402HTTPClient } from '@x402/core/client'
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types'
import { type ClientEvmSigner, PERMIT2_ADDRESS } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import {
  type Address,
  getAddress,
  isAddress,
  type PublicClient,
  type WalletClient,
  zeroAddress,
} from 'viem'

import type { SpendGuard } from '../agent/guard.js'
import { matchService, type X402Service } from '../agent/policy.js'
import { formatAmount } from '../amount.js'
import { readCapped } from '../body.js'
import { TgbpKitError } from '../errors.js'
import { tgbpAbi } from '../evm/abi.js'
import { assertCanTransfer } from '../evm/checks.js'
import type { EvmTokenDeployment } from '../registry/index.js'
import {
  MAX_PAYMENT_WINDOW_SECONDS,
  penceToBaseUnits,
  TGBP_BASE_SEPOLIA,
  TGBP_EIP712_DOMAIN,
  x402Network,
} from './token.js'

export {
  MAX_PAYMENT_WINDOW_SECONDS,
  penceToBaseUnits,
  TGBP_BASE_SEPOLIA,
  x402Network,
} from './token.js'

export interface TgbpPaymentFetchOptions {
  /** Reads pause and ban state, balances, the Permit2 allowance and the permit nonce. */
  publicClient: PublicClient
  /** Signs the payment. Must carry an account: `createWalletClient({ account, ... })`. */
  walletClient: WalletClient
  /** The most the client pays for one request, in whole pence. */
  maxPencePerRequest: number | bigint
  /**
   * The spend guard every payment must pass before it is signed. Its policy
   * must allow the `x402` action, the token's chain and the payee, and its
   * daily cap counts x402 payments with every other action it guards.
   */
  guard: SpendGuard
  /** Defaults to tGBP on Base Sepolia. */
  token?: EvmTokenDeployment
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

export interface TgbpPaymentContext {
  /**
   * Why the agent is paying, at most `MAX_REASON_LENGTH` characters. The spend
   * ledger records it. Every call needs one.
   */
  reason: string
  /** Lowers `maxPencePerRequest` for this call only, in whole pence. */
  maxPence?: number | bigint
}

export interface TgbpPaidResponse {
  response: Response
  /**
   * The settlement the server reported, when the client paid. `transaction`
   * is the on-chain transaction hash. The facilitator reported it: read the
   * receipt before treating the payment as final. Undefined when the route
   * was free.
   */
  settlement?: SettleResponse
  /** The price paid, in tGBP base units. Undefined when the route was free. */
  amount?: bigint
  /** Who was paid. Undefined when the route was free. */
  payTo?: Address
}

/**
 * Returns a `fetch` that pays x402 routes in tGBP. On a 402 it picks the
 * server's tGBP offer, checks it, signs a Permit2 transfer, and sends the
 * request again with the payment. When the server offers
 * `eip2612GasSponsoring`, it also signs an EIP-2612 permit for Permit2, and
 * the facilitator pays the gas, so the payer needs no ETH.
 *
 * The unpaid first request follows a redirect only to a URL on one of the
 * guard policy's x402 services. A redirect anywhere else throws
 * `SPEND_POLICY_DENIED` before any request reaches it. A browser fetch hides
 * a redirect's target, so there a redirect throws `PAYMENT_NOT_OFFERED`.
 *
 * Before signing it reads the token's pause state, the ban status of payer
 * and payee, and the payer's balance, and throws a `TgbpKitError` without
 * signing when one fails. These checks are best effort: the state can change
 * before the facilitator settles. It refuses a price above
 * `maxPencePerRequest` or the call's `payment.maxPence`, and an offer whose signature would stay valid longer
 * than `MAX_PAYMENT_WINDOW_SECONDS`.
 *
 * Last before signing, it asks `guard`, which refuses with
 * `SPEND_POLICY_DENIED` or records the payment in the spend ledger with its
 * URL (without credentials or query), price, payee and `payment.reason`. A
 * call with no reason throws `RangeError` before any request. A payment that
 * then fails stays counted, so the ledger may overstate the day's spend but
 * never understate it.
 *
 * After signing, any outcome other than a reported settlement throws
 * `PAYMENT_REFUSED` or `PAYMENT_UNCONFIRMED`. Neither proves the payment did
 * not happen: the signature stays valid until `details.deadline`. Retrying
 * before then may pay twice, so check the payer's balance or wait for the
 * deadline first.
 *
 * One returned function makes one payment at a time; concurrent calls wait
 * their turn, because two payments signed at once would share a permit nonce.
 */
export function createTgbpPaymentFetch({
  publicClient,
  walletClient,
  maxPencePerRequest,
  token = TGBP_BASE_SEPOLIA,
  guard,
  fetch: fetchFn = globalThis.fetch,
}: TgbpPaymentFetchOptions): (
  input: string | URL | Request,
  init: RequestInit | undefined,
  payment: TgbpPaymentContext,
) => Promise<TgbpPaidResponse> {
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account; create it with `account`')
  if (typeof guard?.authorize !== 'function') {
    throw new Error('Pass a spend guard: `guard: createSpendGuard({ policy, ledgerPath })`')
  }
  const payer = account.address
  const network = x402Network(token)
  const limit = penceToBaseUnits(maxPencePerRequest, token)

  const signer: ClientEvmSigner = {
    address: account.address,
    signTypedData: (message) => walletClient.signTypedData({ account, ...message } as never),
    // The permit needs the payer's token nonce and Permit2 allowance; without
    // readContract the x402 client silently skips the permit.
    readContract: (args) => publicClient.readContract(args as never),
  }
  // The explicit limit check below runs first and throws a TgbpKitError; the
  // library's own cap is a second guard on the same limit.
  const client = new x402Client().register(network, new ExactEvmScheme(signer)).setSpendControls({
    allowedAssets: [{ network, asset: token.address, maxAmountPerPayment: limit.toString() }],
  })
  const http = new x402HTTPClient(client)

  async function pay(
    input: string | URL | Request,
    init: RequestInit | undefined,
    payment: TgbpPaymentContext,
  ): Promise<TgbpPaidResponse> {
    // Before any request, so a forgotten reason never costs a round trip.
    if (typeof payment?.reason !== 'string' || payment.reason.trim() === '') {
      throw new RangeError('Pass { reason } as the third argument; the spend ledger records it')
    }
    const callLimit =
      payment.maxPence === undefined
        ? limit
        : minBigInt(limit, penceToBaseUnits(payment.maxPence, token))
    const request = new Request(input, init)
    const first = await sendFirst(request, fetchFn, guard.policy.x402?.services ?? [])
    if (first.status !== 402) return { response: first }

    const { url, paymentRequired, offer } = await readTerms(first, request, http, token, network)
    const amount = BigInt(offer.amount)
    if (amount > callLimit) {
      throw new TgbpKitError(
        'PAYMENT_OVER_LIMIT',
        `${url} asks ${amount} tGBP base units, above the limit of ${callLimit}`,
        { details: { url, amount, limit: callLimit } },
      )
    }
    const payTo = getAddress(offer.payTo)
    await assertCanTransfer(publicClient, token, payer, payTo, amount)
    if (paymentRequired.extensions?.eip2612GasSponsoring === undefined) {
      // Without the extension no permit is signed, so Permit2 must already hold an allowance.
      const allowance = await publicClient.readContract({
        address: token.address,
        abi: tgbpAbi,
        functionName: 'allowance',
        args: [payer, PERMIT2_ADDRESS],
      })
      if (allowance < amount) {
        throw new TgbpKitError(
          'PAYMENT_NOT_OFFERED',
          `${url} offers no gas sponsoring, and the payer has not approved Permit2 for tGBP`,
          { details: { url, allowance, amount } },
        )
      }
    }

    // A caller that gave up during the checks gets nothing signed and no ledger entry.
    request.signal.throwIfAborted()
    // Last, so the ledger never records a payment that the checks above refused.
    await guard.authorize({
      action: 'x402',
      chain: token.chain,
      destination: payTo,
      amount: formatAmount(amount, token.decimals),
      url: ledgerUrl(url),
      reason: payment.reason,
    })

    const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [offer] })
    const signed = {
      url,
      payer: payer,
      payTo,
      amount,
      network,
      // The window is the most the signature can live, so it bounds an unreadable deadline.
      deadline: signedDeadline(payload) ?? Math.floor(Date.now() / 1000) + offer.maxTimeoutSeconds,
    }

    const paid = new Request(url, {
      method: request.method,
      headers: request.headers,
      body: request.body === null ? null : await request.arrayBuffer(),
      // A redirect would carry the signed payment to wherever it points.
      redirect: 'error',
      // An abort after signing surfaces as PAYMENT_UNCONFIRMED below.
      signal: request.signal,
    })
    for (const [name, value] of Object.entries(http.encodePaymentSignatureHeader(payload))) {
      paid.headers.set(name, value)
    }
    let response: Response
    try {
      response = await fetchFn(paid)
    } catch (cause) {
      throw unconfirmed(`the paid request to ${url} failed`, signed, cause)
    }

    if (response.status === 402) {
      let reason: string | undefined
      let cause: unknown
      try {
        reason = http.getPaymentRequiredResponse(
          (name) => response.headers.get(name),
          await readJson(response),
        ).error
      } catch (error) {
        cause = error
      }
      // A settlement the facilitator rejected comes back as a 402 carrying a failed PAYMENT-RESPONSE.
      if (typeof reason !== 'string') {
        try {
          reason = http.getPaymentSettleResponse((name) => response.headers.get(name)).errorReason
        } catch {
          // No settlement header either; `cause` keeps the first parse error.
        }
      }
      throw new TgbpKitError(
        'PAYMENT_REFUSED',
        `${url} refused the tGBP payment: ${clip(reason) ?? 'no reason given'}`,
        { cause, details: { ...signed, reason: clip(reason), response } },
      )
    }
    if (!response.headers.has('PAYMENT-RESPONSE') && !response.headers.has('X-PAYMENT-RESPONSE')) {
      throw unconfirmed(
        `${url} answered ${response.status} with no settlement`,
        { ...signed, response },
        undefined,
      )
    }
    let settlement: SettleResponse
    try {
      settlement = http.getPaymentSettleResponse((name) => response.headers.get(name))
    } catch (cause) {
      throw unconfirmed(
        `${url} sent a settlement the client cannot read`,
        { ...signed, response },
        cause,
      )
    }
    if (
      settlement.success !== true ||
      settlement.network !== network ||
      (settlement.payer !== undefined &&
        (!isAddress(settlement.payer) || getAddress(settlement.payer) !== payer))
    ) {
      throw unconfirmed(
        `${url} reported a settlement that does not match this payment`,
        { ...signed, response, settlement },
        undefined,
      )
    }
    return { response, settlement, amount, payTo }
  }

  let queue: Promise<unknown> = Promise.resolve()
  return (input, init, payment) => {
    const result = queue.then(() => pay(input, init, payment))
    // The queue only orders calls; each caller still sees its own rejection.
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export interface TgbpPaymentQuoteOptions {
  /** Defaults to tGBP on Base Sepolia. */
  token?: EvmTokenDeployment
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** What an x402 route asks for, from `quoteTgbpPayment`. */
export type TgbpPaymentQuote =
  | { free: true; url: string; status: number }
  | {
      free: false
      /** The URL that asked for payment. */
      url: string
      /** The price, in tGBP base units. */
      amount: bigint
      payTo: Address
      network: string
    }

/**
 * Reads the price of an x402 route without paying it: it sends the request
 * once, and on a 402 picks the server's tGBP offer by the same rules as
 * `createTgbpPaymentFetch`. It signs nothing and asks no spend guard. A route
 * that does not answer 402 is free; its response is discarded.
 */
export async function quoteTgbpPayment(
  input: string | URL | Request,
  init?: RequestInit,
  { token = TGBP_BASE_SEPOLIA, fetch: fetchFn = globalThis.fetch }: TgbpPaymentQuoteOptions = {},
): Promise<TgbpPaymentQuote> {
  const request = new Request(input, init)
  const first = await fetchFn(request)
  if (first.status !== 402) {
    await first.body?.cancel()
    return { free: true, url: first.url || request.url, status: first.status }
  }
  const network = x402Network(token)
  const http = new x402HTTPClient(new x402Client())
  const { url, offer } = await readTerms(first, request, http, token, network)
  return { free: false, url, amount: BigInt(offer.amount), payTo: getAddress(offer.payTo), network }
}

/** The statuses a fetch follows as redirects; it returns any other 3xx as it is. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** As many redirects as a fetch follows before it fails. */
const MAX_REDIRECTS = 20
/** The headers a fetch drops with the body when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type']
/** The headers a fetch drops when a redirect changes origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

/**
 * Sends the unpaid first request and follows a redirect only to a URL on one
 * of `services`, so a listed service that redirects cannot lead the client to
 * a host the policy does not list. Each hop is fetched with
 * `redirect: 'manual'` and rewritten as a fetch would rewrite it.
 */
async function sendFirst(
  request: Request,
  fetchFn: typeof fetch,
  services: X402Service[],
): Promise<Response> {
  let url = request.url
  let method = request.method
  let body = request.body === null ? null : await request.clone().arrayBuffer()
  const headers = new Headers(request.headers)
  for (let hops = 0; ; hops += 1) {
    const response = await fetchFn(
      new Request(url, { method, headers, body, redirect: 'manual', signal: request.signal }),
    )
    // A spec fetch reports a manual redirect as status 0 and hides its target; Node's reports the 3xx.
    if (response.type === 'opaqueredirect' || response.status === 0) {
      throw new TgbpKitError(
        'PAYMENT_NOT_OFFERED',
        `${ledgerUrl(url)} answered with a redirect the client cannot read; it follows only a redirect to a listed x402 service`,
        { details: { url: ledgerUrl(url), status: response.status } },
      )
    }
    const location = response.headers.get('location')
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response
    await response.body?.cancel()

    let next: URL
    try {
      next = new URL(location, url)
    } catch (cause) {
      throw new TgbpKitError(
        'PAYMENT_NOT_OFFERED',
        `${ledgerUrl(url)} redirected to a location that is not a URL`,
        { cause, details: { url: ledgerUrl(url), status: response.status } },
      )
    }
    // Origin and path only, as the guard reports a URL: the query may carry secrets.
    const web = next.protocol === 'https:' || next.protocol === 'http:'
    if (!web || matchService(services, next.href) === undefined) {
      const to = web ? ledgerUrl(next.href) : next.protocol
      throw new TgbpKitError(
        'SPEND_POLICY_DENIED',
        `Spend policy refused x402: ${ledgerUrl(url)} redirected to ${to}, which is not an approved x402 service`,
        { details: { action: 'x402', url: to, redirectedFrom: ledgerUrl(url), rule: 'services' } },
      )
    }
    if (hops + 1 >= MAX_REDIRECTS) {
      throw new TgbpKitError(
        'PAYMENT_NOT_OFFERED',
        `${ledgerUrl(request.url)} redirected more than ${MAX_REDIRECTS} times`,
        { details: { url: ledgerUrl(request.url) } },
      )
    }

    // The rewrites a fetch makes when it follows a redirect.
    if (
      ((response.status === 301 || response.status === 302) && method === 'POST') ||
      (response.status === 303 && method !== 'GET' && method !== 'HEAD')
    ) {
      method = 'GET'
      body = null
      for (const name of BODY_HEADERS) headers.delete(name)
    }
    if (next.origin !== new URL(url).origin) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name)
    }
    url = next.href
  }
}

/** The x402 terms of a 402 answer to `request`, and the tGBP offer the client accepts. */
async function readTerms(
  first: Response,
  request: Request,
  http: x402HTTPClient,
  token: EvmTokenDeployment,
  network: string,
): Promise<{ url: string; paymentRequired: PaymentRequired; offer: PaymentRequirements }> {
  const url = first.url || request.url
  if (new URL(url).origin !== new URL(request.url).origin) {
    throw new TgbpKitError(
      'PAYMENT_NOT_OFFERED',
      `${request.url} redirected to ${url}, which asked for payment; the client pays only the origin it called`,
      { details: { url: request.url, redirectedTo: url } },
    )
  }
  let paymentRequired: PaymentRequired
  try {
    paymentRequired = http.getPaymentRequiredResponse(
      (name) => first.headers.get(name),
      await readJson(first),
    )
    if (!Array.isArray(paymentRequired?.accepts)) throw new TypeError('the terms list no offers')
  } catch (cause) {
    throw new TgbpKitError('PAYMENT_NOT_OFFERED', `${url} answered 402 without x402 terms`, {
      cause,
      details: { url },
    })
  }
  return { url, paymentRequired, offer: pickTgbpOffer(paymentRequired, token, network, url) }
}

function pickTgbpOffer(
  paymentRequired: PaymentRequired,
  token: EvmTokenDeployment,
  network: string,
  url: string,
): PaymentRequirements {
  // The terms are the server's unvalidated JSON, so every field the signature
  // depends on is checked by type, with no coercion.
  const offer = paymentRequired.accepts.find(
    (option) =>
      option.scheme === 'exact' &&
      option.network === network &&
      typeof option.asset === 'string' &&
      isAddress(option.asset) &&
      getAddress(option.asset) === getAddress(token.address) &&
      typeof option.amount === 'string' &&
      /^[1-9]\d*$/.test(option.amount) &&
      typeof option.payTo === 'string' &&
      isAddress(option.payTo) &&
      getAddress(option.payTo) !== zeroAddress &&
      Number.isInteger(option.maxTimeoutSeconds) &&
      option.maxTimeoutSeconds > 0 &&
      option.maxTimeoutSeconds <= MAX_PAYMENT_WINDOW_SECONDS &&
      option.extra?.assetTransferMethod === 'permit2' &&
      option.extra?.name === TGBP_EIP712_DOMAIN.name &&
      option.extra?.version === TGBP_EIP712_DOMAIN.version,
  )
  if (!offer) {
    throw new TgbpKitError(
      'PAYMENT_NOT_OFFERED',
      `${url} offers no tGBP payment on ${token.chain} the client accepts: the exact scheme's Permit2 method, the tGBP EIP-712 domain, a payee, and a window of at most ${MAX_PAYMENT_WINDOW_SECONDS}s`,
      { details: { url, chain: token.chain, offers: paymentRequired.accepts.length } },
    )
  }
  return offer
}

/** The URL as the ledger records it: credentials, query and fragment may carry secrets. */
function ledgerUrl(url: string): string {
  const { origin, pathname } = new URL(url)
  return `${origin}${pathname}`
}

/** The Unix time (seconds) after which the signed Permit2 transfer can no longer settle. */
function signedDeadline(payload: PaymentPayload): number | undefined {
  const authorization = (payload.payload as { permit2Authorization?: { deadline?: unknown } })
    .permit2Authorization
  const deadline = Number(authorization?.deadline)
  return Number.isSafeInteger(deadline) ? deadline : undefined
}

function unconfirmed(
  message: string,
  details: Record<string, unknown>,
  cause: unknown,
): TgbpKitError {
  return new TgbpKitError(
    'PAYMENT_UNCONFIRMED',
    `${message}; the signed payment may still settle until its deadline, so check the payer's balance before retrying`,
    { cause, details },
  )
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

/**
 * Caps a server-supplied reason, which lands in logs and in an agent's context.
 * The server's JSON is unvalidated, so anything but a string counts as no reason.
 */
function clip(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`
}

/** The terms travel in a header, so a body this size is plenty. */
const MAX_TERMS_BODY_BYTES = 64 * 1024

async function readJson(response: Response): Promise<unknown> {
  const { text, truncated } = await readCapped(response, MAX_TERMS_BODY_BYTES)
  if (truncated) return undefined
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    // The terms travel in the PAYMENT-REQUIRED header; a body that is not JSON is ignored.
    return undefined
  }
}
