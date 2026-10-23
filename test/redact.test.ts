import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

import { createTgbpClient } from '../src/api/index.js'
import { REDACTED, redactForPublicLog } from './redact.js'

// The shape of a real staging error that reached a public log. The provider
// name and its code prefix are built from pieces so this file does not disclose them.
const PROVIDER = ['Ac', 'me'].join('')
const PREFIX = ['a', 'c'].join('')
const API_CODE = `${PREFIX}_account_requested`
const API_MESSAGE = `An ${PROVIDER} account has been requested for this customer`

function failingClient(body: unknown, status = 422) {
  return createTgbpClient({
    apiKey: 'tgbp_sandbox_test',
    environment: 'sandbox',
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch,
    retry: { baseDelayMs: 0 },
  })
}

/** Everything vitest could print: message, stack, and every own property. */
function printed(error: Error): string {
  return inspect(error, { depth: Infinity, showHidden: true })
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

describe('redactForPublicLog', () => {
  it('masks a provider-named API error and keeps the call, status and request id', async () => {
    const tgbp = failingClient({
      error: { code: API_CODE, message: API_MESSAGE, details: { request_id: 'req_1' } },
    })
    const error = await thrownBy(
      tgbp.mints.create({
        customerId: 'customer_1',
        destinationAddress: '0x1111111111111111111111111111111111111111',
        chain: 'sepolia',
        amount: { currency: 'GBP', value: 10 },
      }),
    )
    // The kit itself still passes the API's error through for developers.
    expect(printed(error as Error)).toContain(PROVIDER)

    const redacted = redactForPublicLog(error)
    expect(redacted.message).toBe(
      `API_ERROR on POST /api/v1/mints with 422: ${REDACTED} (request id req_1)`,
    )
    expect(redacted.name).toBe('TgbpKitError')
    const output = printed(redacted)
    expect(output).not.toContain(PROVIDER)
    expect(output).not.toContain(API_CODE)
    expect(output).not.toMatch(new RegExp(`\\b${PREFIX}_`))
    expect(output).not.toContain('account')
    expect(redacted.cause).toBeUndefined()
  })

  it('keeps the message and stack frames of an assertion, but not its values', () => {
    let failure: unknown
    try {
      expect({ reason: API_MESSAGE }).toEqual({ reason: 'none' })
    } catch (error) {
      failure = error
    }
    const redacted = redactForPublicLog(failure)
    expect(redacted.name).toBe('AssertionError')
    expect(redacted.stack).toMatch(/redact\.test\.ts/)
    expect(printed(redacted)).not.toContain(PROVIDER)
  })

  it('redacts a thrown non-Error value entirely', () => {
    expect(redactForPublicLog(API_MESSAGE).message).toBe(`non-Error thrown: ${REDACTED}`)
  })
})
