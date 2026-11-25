import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SUBMISSION_KEY_LIFETIME_MS, SubmissionJournal } from '../src/agent/submissions.js'

let dir: string
let now: Date
const journal = () => new SubmissionJournal(join(dir, 'submissions.jsonl'), () => now)
const inputs = { chain: 'sepolia', amount: '10.00', destinationAddress: '0xabc' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tgbp-submissions-'))
  now = new Date('2026-11-25T12:00:00Z')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('submission journal', () => {
  it('returns the open key for the same inputs, in any field order', async () => {
    const first = await journal().open('mint', inputs)
    const again = await journal().open('mint', {
      destinationAddress: '0xabc',
      amount: '10.00',
      chain: 'sepolia',
      customerId: undefined,
    })
    expect(first.resumed).toBe(false)
    expect(again).toEqual({ idempotencyKey: first.idempotencyKey, resumed: true })
  })

  it('keys other inputs and other tools apart', async () => {
    const mint = await journal().open('mint', inputs)
    const other = await journal().open('mint', { ...inputs, amount: '10.01' })
    const swap = await journal().open('swap', inputs)
    expect(new Set([mint, other, swap].map((s) => s.idempotencyKey)).size).toBe(3)
  })

  it('starts a new key once the open one closes, or outlives the API keeping it', async () => {
    const first = await journal().open('mint', inputs)
    await journal().close('mint', inputs, first.idempotencyKey)
    const second = await journal().open('mint', inputs)
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    now = new Date(now.getTime() + SUBMISSION_KEY_LIFETIME_MS + 1)
    const third = await journal().open('mint', inputs)
    expect(third.idempotencyKey).not.toBe(second.idempotencyKey)
  })

  it('uses a new explicit key, and resumes with the open one', async () => {
    const first = await journal().open('swap', inputs)
    expect((await journal().open('swap', inputs, first.idempotencyKey)).resumed).toBe(true)
    const named = await journal().open('swap', inputs, 'my_key')
    expect(named).toEqual({ idempotencyKey: 'my_key', resumed: false })
  })

  it('lets only one attempt burn a redemption, and refuses a retry after it', async () => {
    const { idempotencyKey } = await journal().open('redeem', inputs)
    await journal().burning(inputs, idempotencyKey, 'red_1', '0xdead')
    await expect(journal().burning(inputs, idempotencyKey, 'red_1', '0xdead')).rejects.toThrow(
      /no longer holds/,
    )
    await expect(journal().open('redeem', inputs)).rejects.toThrow(/red_1 .*may have been sent/)
  })

  it('keeps refusing a redemption whose burn may have been sent, at any age', async () => {
    const { idempotencyKey } = await journal().open('redeem', inputs)
    await journal().burning(inputs, idempotencyKey, 'red_1', '0xdead')
    now = new Date(now.getTime() + 30 * SUBMISSION_KEY_LIFETIME_MS)
    await expect(journal().open('redeem', inputs)).rejects.toThrow(/red_1/)
    await expect(journal().assertNotBurning(inputs)).rejects.toThrow(/to 0xdead .*ask a human/)
  })

  it('ignores a close from a slower attempt once a newer submission is open', async () => {
    const first = await journal().open('mint', inputs)
    await journal().close('mint', inputs, first.idempotencyKey)
    const second = await journal().open('mint', inputs)
    await journal().close('mint', inputs, first.idempotencyKey)
    expect(await journal().open('mint', inputs)).toEqual({
      idempotencyKey: second.idempotencyKey,
      resumed: true,
    })
  })

  it('refuses an invalid explicit key without saving it', async () => {
    await expect(journal().open('mint', inputs, 'not a key!')).rejects.toThrow(RangeError)
    expect((await journal().open('mint', inputs)).resumed).toBe(false)
  })
})
