/**
 * A paid API that charges 5p of test tGBP per call over x402 on Base Sepolia.
 * The x402 demo's buyer pays this seller.
 *
 *   pnpm x402:seller --pay-to <address>      # listens on port 4021
 *   pnpm x402:seller --pay-to <address> --port 8080
 *
 * The seller holds no key: the facilitator settles each payment to `--pay-to`.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import express from 'express'
import { getAddress, isAddress } from 'viem'

import { type TgbpPaymentMiddlewareOptions, tgbpPaymentMiddleware } from '../../src/x402/server.js'

/** The price of one quote, in whole pence of tGBP. */
export const QUOTE_PENCE = 5

export interface SellerOptions {
  /** The address that receives each payment. */
  payTo: string
  /** Defaults to tGBP on Base Sepolia. */
  token?: TgbpPaymentMiddlewareOptions['token']
  /** Defaults to the x402.org facilitator. */
  facilitator?: TgbpPaymentMiddlewareOptions['facilitator']
  /** The price of a quote in whole pence. Defaults to `QUOTE_PENCE`. */
  pence?: number
}

/**
 * The seller's Express app: `GET /quote` costs 5p (or `pence`) and `GET /health` is free.
 *
 * The route's response goes out only after the payment settles. While the
 * facilitator reports the settlement pending, the buyer gets 503 with
 * `Retry-After` and retries with the same payment; a payment that has
 * already bought a quote gets 402.
 */
export function sellerApp({
  payTo,
  token,
  facilitator,
  pence = QUOTE_PENCE,
}: SellerOptions): express.Express {
  const tgbp = token?.network === 'mainnet' ? 'tGBP' : 'test tGBP'
  const app = express()
  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })
  app.use(
    tgbpPaymentMiddleware({
      routes: {
        'GET /quote': {
          pence,
          payTo,
          description: 'A sterling quote',
          mimeType: 'application/json',
        },
      },
      ...(token === undefined ? {} : { token }),
      ...(facilitator === undefined ? {} : { facilitator }),
    }),
  )
  app.get('/quote', (_req, res) => {
    res.json({
      quote: 'GBP is the currency of the United Kingdom',
      paidWith: `${pence}p of ${tgbp}`,
    })
  })
  return app
}

function main(): void {
  const { values } = parseArgs({
    options: { 'pay-to': { type: 'string' }, port: { type: 'string', default: '4021' } },
  })
  const payTo = values['pay-to']
  if (payTo === undefined) throw new Error('pass --pay-to <address>')
  if (!isAddress(payTo)) throw new Error(`--pay-to ${payTo} is not an EVM address`)
  const port = Number(values.port)
  if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
    throw new Error('--port must be 1-65535')
  }
  const server = sellerApp({ payTo: getAddress(payTo) }).listen(port, '127.0.0.1', () => {
    console.log(
      `Seller listening on http://127.0.0.1:${port}; GET /quote costs 5p, paid to ${payTo}`,
    )
  })
  server.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
}

// Run as a script, not when the demo imports the app.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
