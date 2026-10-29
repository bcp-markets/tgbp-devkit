import type { FacilitatorClient, RouteConfig } from '@x402/core/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import type { AssetAmount } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { paymentMiddlewareFromHTTPServer } from '@x402/express'
import { declareEip2612GasSponsoringExtension } from '@x402/extensions'
import { getAddress, isAddress, zeroAddress } from 'viem'

import type { EvmTokenDeployment } from '../registry/index.js'
import { settleOnce, TgbpHTTPResourceServer } from './settlement.js'
import {
  MAX_PAYMENT_WINDOW_SECONDS,
  penceToBaseUnits,
  TGBP_BASE_SEPOLIA,
  TGBP_EIP712_DOMAIN,
  X402_ORG_FACILITATOR_URL,
  x402Network,
} from './token.js'

export {
  PAYMENT_ALREADY_SETTLED,
  SETTLEMENT_PENDING,
  SETTLEMENT_RETRY_AFTER_SECONDS,
} from './settlement.js'
export {
  MAX_PAYMENT_WINDOW_SECONDS,
  penceToBaseUnits,
  TGBP_BASE_SEPOLIA,
  TGBP_EIP712_DOMAIN,
  X402_ORG_FACILITATOR_URL,
  x402Network,
} from './token.js'

/**
 * An x402 price for `pence` of tGBP, as an explicit token amount. tGBP has
 * EIP-2612 `permit` but not EIP-3009, so the price selects the exact
 * scheme's Permit2 transfer method, and carries the EIP-712 domain the payer
 * signs the permit under.
 */
export function tgbpPrice(pence: number | bigint, token = TGBP_BASE_SEPOLIA): AssetAmount {
  return {
    asset: token.address,
    amount: penceToBaseUnits(pence, token).toString(),
    extra: { ...TGBP_EIP712_DOMAIN, assetTransferMethod: 'permit2' },
  }
}

export interface TgbpRoutePrice {
  /** Whole pence of tGBP per request. */
  pence: number | bigint
  /** The address that receives the payment. */
  payTo: string
  description?: string
  mimeType?: string
  /** How long a signed payment stays valid. Defaults to 300 seconds, at most 600. */
  maxTimeoutSeconds?: number
}

export interface TgbpPaymentMiddlewareOptions {
  /** Paid routes, keyed like `'GET /quote'`. */
  routes: Record<string, TgbpRoutePrice>
  /** Defaults to tGBP on Base Sepolia. */
  token?: EvmTokenDeployment
  /**
   * Verifies and settles payments. Defaults to the x402.org facilitator,
   * which serves testnets only, so a mainnet token needs one passed here.
   * The middleware trusts the facilitator's report that a payment settled.
   */
  facilitator?: FacilitatorClient
  /**
   * Ask the facilitator what it supports when the middleware is created.
   * Defaults to true; a failed call is retried on the next request.
   */
  syncFacilitatorOnStart?: boolean
}

/**
 * Express middleware that answers a paid route with HTTP 402 until the
 * request carries a tGBP payment, then has the facilitator verify and settle
 * it. The route also offers the `eip2612GasSponsoring` extension: the payer
 * signs an EIP-2612 permit for Permit2, and a facilitator that supports the
 * extension submits it with the payment, so the payer needs no ETH.
 *
 * The facilitator settles after the route handler succeeds, and the
 * handler's response goes out only once settlement confirms. A handler that
 * answers 4xx or 5xx cancels the settlement. While settlement is pending the
 * route answers 503 with `Retry-After`, and the buyer retries with the same
 * payment, not a new one. The handler runs again on each retry, so a paid
 * route must be safe to run more than once. Each payment settles at most once
 * and buys one response; a settled payment sent again gets 402
 * `payment_already_settled`.
 * The middleware remembers payments in its own process, so run one instance
 * per seller, or send a buyer's retries to the instance that took the payment.
 */
export function tgbpPaymentMiddleware({
  routes,
  token = TGBP_BASE_SEPOLIA,
  facilitator,
  syncFacilitatorOnStart = true,
}: TgbpPaymentMiddlewareOptions) {
  if (facilitator === undefined && token.network !== 'testnet') {
    throw new TypeError(`tGBP on ${token.chain} is a mainnet token; pass a mainnet facilitator`)
  }
  const network = x402Network(token)
  const config: Record<string, RouteConfig> = {}
  for (const [route, { pence, payTo, description, mimeType, maxTimeoutSeconds }] of Object.entries(
    routes,
  )) {
    if (!isAddress(payTo) || getAddress(payTo) === zeroAddress) {
      throw new TypeError(`${route}: payTo "${payTo}" is not a usable EVM address`)
    }
    const window = maxTimeoutSeconds ?? 300
    if (!Number.isInteger(window) || window <= 0 || window > MAX_PAYMENT_WINDOW_SECONDS) {
      throw new RangeError(
        `${route}: maxTimeoutSeconds must be a whole number from 1 to ${MAX_PAYMENT_WINDOW_SECONDS}`,
      )
    }
    config[route] = {
      accepts: {
        scheme: 'exact',
        network,
        payTo: getAddress(payTo),
        price: tgbpPrice(pence, token),
        maxTimeoutSeconds: window,
      },
      ...(description === undefined ? {} : { description }),
      ...(mimeType === undefined ? {} : { mimeType }),
      extensions: declareEip2612GasSponsoringExtension(),
    }
  }
  const server = new x402ResourceServer(
    settleOnce(facilitator ?? new HTTPFacilitatorClient({ url: X402_ORG_FACILITATOR_URL })),
  ).register(network, new ExactEvmScheme())
  return paymentMiddlewareFromHTTPServer(
    new TgbpHTTPResourceServer(server, config),
    undefined,
    undefined,
    syncFacilitatorOnStart,
  )
}
