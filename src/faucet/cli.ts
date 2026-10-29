#!/usr/bin/env node
/**
 * tgbp-faucet: sends 10 test tGBP on Base Sepolia to an address.
 *
 *   tgbp-faucet <address>
 *
 * TGBP_FAUCET_URL points it at another faucet endpoint, such as a local
 * `wrangler dev`. Exits 1 when the faucet refuses or cannot be reached.
 */
import { requestTestTgbp, TEST_TGBP_FAUCET_URL } from './index.js'

const USAGE = 'Usage: tgbp-faucet <address>  (sends 10 test tGBP on Base Sepolia, once a day)'

async function main(): Promise<void> {
  const address = process.argv[2]
  if (address === '--help' || address === '-h') {
    console.log(USAGE)
    return
  }
  if (!address || process.argv.length > 3) throw new Error(USAGE)
  const drip = await requestTestTgbp({
    address,
    url: process.env.TGBP_FAUCET_URL || TEST_TGBP_FAUCET_URL,
  })
  console.log(
    drip.confirmed
      ? `Sent ${drip.amount} test tGBP to ${address} on Base Sepolia.`
      : `Sent ${drip.amount} test tGBP to ${address} on Base Sepolia; it is not confirmed yet.`,
  )
  console.log(drip.explorerUrl)
}

main().catch((error: unknown) => {
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  console.error(`${error instanceof Error ? error.message : String(error)}${cause}`)
  process.exitCode = 1
})
