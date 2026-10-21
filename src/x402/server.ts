import type { FacilitatorClient, RouteConfig } from '@x402/core/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import type { AssetAmount } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { paymentMiddleware } from '@x402/express'
import { declareEip2612GasSponsoringExtension } from '@x402/extensions'
import { getAddress, isAddress } from 'viem'

import type { EvmTokenDeployment } from '../registry/index.js'
import {
  penceToBaseUnits,
  TGBP_BASE_SEPOLIA,
  TGBP_EIP712_DOMAIN,
  X402_ORG_FACILITATOR_URL,
  x402Network,
} from './token.js'

export {
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
  /** How long a signed payment stays valid. Defaults to 300 seconds. */
  maxTimeoutSeconds?: number
}

export interface TgbpPaymentMiddlewareOptions {
  /** Paid routes, keyed like `'GET /quote'`. */
  routes: Record<string, TgbpRoutePrice>
  /** Defaults to tGBP on Base Sepolia. */
  token?: EvmTokenDeployment
  /** Defaults to the x402.org facilitator. */
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
 * signs an EIP-2612 permit for Permit2, and the facilitator submits it with
 * the payment, so the payer needs no ETH.
 */
export function tgbpPaymentMiddleware({
  routes,
  token = TGBP_BASE_SEPOLIA,
  facilitator = new HTTPFacilitatorClient({ url: X402_ORG_FACILITATOR_URL }),
  syncFacilitatorOnStart = true,
}: TgbpPaymentMiddlewareOptions) {
  const network = x402Network(token)
  const config: Record<string, RouteConfig> = {}
  for (const [route, { pence, payTo, description, mimeType, maxTimeoutSeconds }] of Object.entries(
    routes,
  )) {
    if (!isAddress(payTo)) throw new TypeError(`${route}: payTo "${payTo}" is not an EVM address`)
    config[route] = {
      accepts: {
        scheme: 'exact',
        network,
        payTo: getAddress(payTo),
        price: tgbpPrice(pence, token),
        maxTimeoutSeconds: maxTimeoutSeconds ?? 300,
      },
      ...(description === undefined ? {} : { description }),
      ...(mimeType === undefined ? {} : { mimeType }),
      extensions: declareEip2612GasSponsoringExtension(),
    }
  }
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme())
  return paymentMiddleware(config, server, undefined, undefined, syncFacilitatorOnStart)
}
