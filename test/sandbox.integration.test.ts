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
 * The mint runs to completion: create, replay with the same key, simulate
 * the bank transfer, then wait for the tGBP to be minted. The redemption is
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

const MINT_TIMEOUT_MS = 10 * 60_000
const FINAL_MINT_STATUSES = new Set<Mint['status']>(['confirmed', 'failed', 'cancelled'])

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
        amount: { currency: 'GBP', value: 1 },
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
      expect(mint.status, mint.failureReason ?? undefined).toBe('confirmed')

      const redemption = await tgbp.redemptions.create({
        chain: env.chain,
        amount: { currency: 'GBP', value: 1 },
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
