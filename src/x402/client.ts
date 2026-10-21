import { x402Client, x402HTTPClient } from '@x402/core/client'
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types'
import { type ClientEvmSigner, PERMIT2_ADDRESS } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { getAddress, isAddress, type PublicClient, type WalletClient, zeroAddress } from 'viem'

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
  /** Defaults to tGBP on Base Sepolia. */
  token?: EvmTokenDeployment
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
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
}

/**
 * Returns a `fetch` that pays x402 routes in tGBP. On a 402 it picks the
 * server's tGBP offer, checks it, signs a Permit2 transfer, and sends the
 * request again with the payment. When the server offers
 * `eip2612GasSponsoring`, it also signs an EIP-2612 permit for Permit2, and
 * the facilitator pays the gas, so the payer needs no ETH.
 *
 * Before signing it reads the token's pause state, the ban status of payer
 * and payee, and the payer's balance, and throws a `TgbpKitError` without
 * signing when one fails. These checks are best effort: the state can change
 * before the facilitator settles. It refuses a price above
 * `maxPencePerRequest`, and an offer whose signature would stay valid longer
 * than `MAX_PAYMENT_WINDOW_SECONDS`.
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
  fetch: fetchFn = globalThis.fetch,
}: TgbpPaymentFetchOptions): (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<TgbpPaidResponse> {
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account; create it with `account`')
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

  async function pay(input: string | URL | Request, init?: RequestInit): Promise<TgbpPaidResponse> {
    const request = new Request(input, init)
    const first = await fetchFn(request.clone())
    if (first.status !== 402) return { response: first }

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
    } catch (cause) {
      throw new TgbpKitError('PAYMENT_NOT_OFFERED', `${url} answered 402 without x402 terms`, {
        cause,
        details: { url },
      })
    }
    const offer = pickTgbpOffer(paymentRequired, token, network, url)
    const amount = BigInt(offer.amount)
    if (amount > limit) {
      throw new TgbpKitError(
        'PAYMENT_OVER_LIMIT',
        `${url} asks ${amount} tGBP base units, above the limit of ${limit}`,
        { details: { url, amount, limit } },
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

    const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [offer] })
    const signed = {
      url,
      payer: payer,
      payTo,
      amount,
      network,
      deadline: signedDeadline(payload),
    }

    const paid = new Request(url, {
      method: request.method,
      headers: request.headers,
      body: request.body === null ? null : await request.arrayBuffer(),
      // A redirect would carry the signed payment to wherever it points.
      redirect: 'error',
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
    return { response, settlement }
  }

  let queue: Promise<unknown> = Promise.resolve()
  return (input, init) => {
    const result = queue.then(() => pay(input, init))
    // The queue only orders calls; each caller still sees its own rejection.
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
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

/** Caps a server-supplied reason, which lands in logs and in an agent's context. */
function clip(text: string | undefined): string | undefined {
  return text === undefined || text.length <= 200 ? text : `${text.slice(0, 200)}…`
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    // The terms travel in the PAYMENT-REQUIRED header; a body that is not JSON is ignored.
    return undefined
  }
}
