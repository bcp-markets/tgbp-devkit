import { x402Client, x402HTTPClient } from '@x402/core/client'
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types'
import type { ClientEvmSigner } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { getAddress, isAddress, type PublicClient, type WalletClient } from 'viem'

import { TgbpKitError } from '../errors.js'
import { tgbpAbi } from '../evm/abi.js'
import { assertClientChain, bannedError, insufficientError, pausedError } from '../evm/checks.js'
import type { EvmTokenDeployment } from '../registry/index.js'
import { penceToBaseUnits, TGBP_BASE_SEPOLIA, x402Network } from './token.js'

export {
  penceToBaseUnits,
  TGBP_BASE_SEPOLIA,
  TGBP_EIP712_DOMAIN,
  X402_ORG_FACILITATOR_URL,
  x402Network,
} from './token.js'

export interface TgbpPaymentFetchOptions {
  /** Reads pause and ban state, the payer's balance, and the permit nonce. */
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
   * The facilitator's settlement, when the client paid. `transaction` is the
   * on-chain transaction hash. Undefined when the route was free.
   */
  settlement?: SettleResponse
}

/**
 * Returns a `fetch` that pays x402 routes in tGBP. On a 402 it picks the
 * server's tGBP offer, checks it, signs a Permit2 transfer (plus an EIP-2612
 * permit for Permit2 when the server offers `eip2612GasSponsoring`, so the
 * payer needs no ETH), and retries the request with the payment.
 *
 * Before signing, it reads the token's pause state, the ban status of payer
 * and payee, and the payer's balance, so those failures throw a
 * `TgbpKitError` and nothing is signed. It refuses a price above
 * `maxPencePerRequest`.
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
  const network = x402Network(token)
  const limit = penceToBaseUnits(maxPencePerRequest, token)

  const signer: ClientEvmSigner = {
    address: account.address,
    signTypedData: (message) => walletClient.signTypedData({ account, ...message } as never),
    // The permit needs the payer's token nonce and Permit2 allowance; without
    // readContract the x402 client silently skips the permit.
    readContract: (args) => publicClient.readContract(args as never),
  }
  const client = new x402Client().register(network, new ExactEvmScheme(signer)).setSpendControls({
    allowedAssets: [{ network, asset: token.address, maxAmountPerPayment: limit.toString() }],
  })
  const http = new x402HTTPClient(client)

  return async (input, init) => {
    const request = new Request(input, init)
    const first = await fetchFn(request.clone())
    if (first.status !== 402) return { response: first }

    const paymentRequired = http.getPaymentRequiredResponse(
      (name) => first.headers.get(name),
      await readJson(first),
    )
    const offer = pickTgbpOffer(paymentRequired, token, network)
    const amount = BigInt(offer.amount)
    if (amount > limit) {
      throw new TgbpKitError(
        'PAYMENT_OVER_LIMIT',
        `${request.url} asks ${amount} tGBP base units, above the limit of ${limit}`,
        { details: { url: request.url, amount, limit } },
      )
    }
    await assertPayable(publicClient, token, account.address, offer.payTo, amount)

    const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [offer] })
    const paid = new Request(request)
    for (const [name, value] of Object.entries(http.encodePaymentSignatureHeader(payload))) {
      paid.headers.set(name, value)
    }
    const response = await fetchFn(paid)
    if (response.status === 402) {
      const refusal = http.getPaymentRequiredResponse(
        (name) => response.headers.get(name),
        await readJson(response),
      )
      throw new TgbpKitError(
        'PAYMENT_REFUSED',
        `${request.url} refused the tGBP payment: ${refusal.error ?? 'no reason given'}`,
        { details: { url: request.url, reason: refusal.error } },
      )
    }
    const header =
      response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE')
    return {
      response,
      ...(header === null
        ? {}
        : { settlement: http.getPaymentSettleResponse((name) => response.headers.get(name)) }),
    }
  }
}

function pickTgbpOffer(
  paymentRequired: PaymentRequired,
  token: EvmTokenDeployment,
  network: string,
): PaymentRequirements {
  const offer = paymentRequired.accepts.find(
    (option) =>
      option.scheme === 'exact' &&
      option.network === network &&
      isAddress(option.asset) &&
      getAddress(option.asset) === getAddress(token.address) &&
      option.extra?.assetTransferMethod === 'permit2',
  )
  if (!offer) {
    throw new TgbpKitError(
      'PAYMENT_NOT_OFFERED',
      `The server offers no tGBP payment on ${token.chain} through the exact scheme's Permit2 method`,
      { details: { chain: token.chain, accepts: paymentRequired.accepts } },
    )
  }
  if (!isAddress(offer.payTo)) {
    throw new TgbpKitError('WRONG_CHAIN_ADDRESS', `payTo "${offer.payTo}" is not an EVM address`, {
      details: { chain: token.chain, address: offer.payTo },
    })
  }
  return offer
}

async function assertPayable(
  publicClient: PublicClient,
  token: EvmTokenDeployment,
  payer: `0x${string}`,
  payTo: string,
  amount: bigint,
): Promise<void> {
  await assertClientChain(publicClient, token)
  const payee = getAddress(payTo)
  const contract = { address: token.address, abi: tgbpAbi } as const
  const [paused, payerBanned, payeeBanned, balance] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: 'paused' }),
    publicClient.readContract({ ...contract, functionName: 'isBanned', args: [payer] }),
    publicClient.readContract({ ...contract, functionName: 'isBanned', args: [payee] }),
    publicClient.readContract({ ...contract, functionName: 'balanceOf', args: [payer] }),
  ])
  if (payerBanned || payeeBanned) throw bannedError(token, payerBanned ? payer : payee)
  if (paused) throw pausedError(token)
  if (balance < amount) throw insufficientError(token, payer, balance, amount)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  } catch {
    // The payment terms travel in the PAYMENT-REQUIRED header; a body is optional.
    return undefined
  }
}
