/**
 * Mints and redeems test tGBP against sandbox.tgbp.io with a staging API key.
 *
 * Runs only when TGBP_SANDBOX_API_KEY is set, unless TGBP_REQUIRE_SANDBOX=1
 * makes missing config a failure (CI's sandbox job sets it). The other
 * variables name records the key's account already owns, on a testnet:
 *
 *   TGBP_SANDBOX_CUSTOMER_ID     a verified customer
 *   TGBP_SANDBOX_ADDRESS         an approved recipient address for that customer
 *   TGBP_SANDBOX_BANK_ID         an approved bank account to redeem to
 *   TGBP_SANDBOX_CHAIN           optional, default sepolia
 *
 * The mint runs as far as the sandbox takes it: create, replay with the same
 * key, simulate the bank transfer, then wait for the tGBP to be minted. The
 * sandbox simulates only the first bank leg, so a mint can stop at
 * in_transit; the test accepts that until the sandbox simulates the rest. The redemption is
 * created and then cancelled. Completing it needs an on-chain burn signed by
 * the recipient wallet, and this test holds no wallet key.
 */
import { describe, expect, it } from 'vitest'

import { createTgbpClient, type Mint } from '../src/api/index.js'

const REQUIRED_VARS = [
  'TGBP_SANDBOX_API_KEY',
  'TGBP_SANDBOX_CUSTOMER_ID',
  'TGBP_SANDBOX_ADDRESS',
  'TGBP_SANDBOX_BANK_ID',
]
const missing = REQUIRED_VARS.filter((name) => !process.env[name])
const env = {
  apiKey: process.env.TGBP_SANDBOX_API_KEY,
  customerId: process.env.TGBP_SANDBOX_CUSTOMER_ID,
  address: process.env.TGBP_SANDBOX_ADDRESS,
  bankId: process.env.TGBP_SANDBOX_BANK_ID,
  chain: process.env.TGBP_SANDBOX_CHAIN || 'sepolia',
}
const configured = Boolean(env.apiKey)
const required = process.env.TGBP_REQUIRE_SANDBOX === '1'

// The API's minimum for both mints and redemptions.
const MIN_AMOUNT_GBP = 5
// The API refuses a second active mint to the same address for the same
// amount, and a sandbox mint can stay active at in_transit. So each run mints
// a random amount from 5.00 to 104.99.
// Whole pence, divided once, so the value serialises with at most two decimals.
const MINT_AMOUNT_GBP = (MIN_AMOUNT_GBP * 100 + Math.floor(Math.random() * 10_000)) / 100
const MINT_TIMEOUT_MS = 10 * 60_000
// in_transit is the furthest the sandbox gets on its own after a simulated pay-in.
const SANDBOX_STOP: Mint['status'] = 'in_transit'
const FINAL_MINT_STATUSES = new Set<Mint['status']>([
  'confirmed',
  'failed',
  'cancelled',
  SANDBOX_STOP,
])

describe('sandbox mint and redeem', () => {
  it.runIf(required && missing.length > 0)('has the sandbox config it requires', () => {
    expect.fail(`TGBP_REQUIRE_SANDBOX=1 but these are unset: ${missing.join(', ')}`)
  })

  it.runIf(configured && missing.length === 0)(
    'mints test tGBP, then creates and cancels a redemption',
    async () => {
      const tgbp = createTgbpClient({ apiKey: env.apiKey as string, environment: 'sandbox' })
      const mintBody = {
        customerId: env.customerId as string,
        destinationAddress: env.address as string,
        chain: env.chain,
        amount: { currency: 'GBP', value: MINT_AMOUNT_GBP },
      }

      const created = await tgbp.mints.create(mintBody)
      if (created.status === 'pending_approval') {
        expect.fail('the sandbox account requires dual approval; use one that does not')
      }
      expect(created.status).toBe('created')
      const mintId = created.data.id

      const replay = await tgbp.mints.create(mintBody, { idempotencyKey: created.idempotencyKey })
      expect(replay).toMatchObject({ status: 'replayed', data: { id: mintId } })

      await tgbp.mints.simulatePayin(mintId)
      const mint = await waitForMint(tgbp, mintId)
      expect(['confirmed', SANDBOX_STOP], mint.failureReason ?? undefined).toContain(mint.status)

      const redemption = await tgbp.redemptions.create({
        chain: env.chain,
        amount: { currency: 'GBP', value: MIN_AMOUNT_GBP },
        bankId: env.bankId as string,
      })
      if (redemption.status === 'pending_approval') {
        expect.fail('the sandbox account requires dual approval; use one that does not')
      }
      expect(redemption.status).toBe('created')
      try {
        expect(redemption.data.burnAddress).toMatch(/\S/)
      } finally {
        const cancelled = await tgbp.redemptions.cancel(redemption.data.redemptionId, {
          reason: 'tgbp-devkit integration test',
        })
        expect(cancelled.data.status).toBe('cancelled')
      }
    },
    MINT_TIMEOUT_MS + 60_000,
  )
})

async function waitForMint(tgbp: ReturnType<typeof createTgbpClient>, mintId: string) {
  const deadline = Date.now() + MINT_TIMEOUT_MS
  for (;;) {
    const { data } = await tgbp.mints.get(mintId)
    if (FINAL_MINT_STATUSES.has(data.status)) return data
    if (Date.now() > deadline)
      throw new Error(`mint ${mintId} still ${data.status} after 10 minutes`)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}
