import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

import { createTgbpClient } from '../src/api/index.js'
import { REDACTED, redactForPublicLog } from './redact.js'

// The shape of a sandbox error that names a provider: a provider-prefixed code
// and a message with the provider's name. Acme is a stand-in.
const PROVIDER = 'Acme'
const PREFIX = 'ac'
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

/**
 * Whether `output` holds API text. A boolean, not toContain: a failing
 * toContain would quote the output, and the name with it, into the public log.
 */
function leaks(output: string): boolean {
  return (
    output.includes(PROVIDER) ||
    output.includes(API_CODE) ||
    new RegExp(`\\b${PREFIX}_`).test(output) ||
    output.includes(API_MESSAGE)
  )
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

function assertionFrom(check: () => void): unknown {
  try {
    check()
  } catch (error) {
    return error
  }
  throw new Error('expected the assertion to fail')
}

const MINT_BODY = {
  customerId: 'customer_1',
  destinationAddress: '0x1111111111111111111111111111111111111111',
  chain: 'sepolia',
  amount: { currency: 'GBP' as const, value: 10 },
}

describe('redactForPublicLog', () => {
  it('masks a provider-named API error and keeps the call, status and request id', async () => {
    const tgbp = failingClient({
      error: { code: API_CODE, message: API_MESSAGE, details: { request_id: 'req_1' } },
    })
    const error = await thrownBy(tgbp.mints.create(MINT_BODY))
    // The kit itself still passes the API's error through for developers.
    expect(leaks(printed(error as Error))).toBe(true)

    const redacted = redactForPublicLog(error)
    expect(redacted.message).toBe(
      `API_ERROR on POST /api/v1/mints with 422: ${REDACTED} (request id req_1)`,
    )
    expect(redacted.name).toBe('TgbpKitError')
    expect(leaks(printed(redacted))).toBe(false)
  })

  it('drops a request id that is not id-shaped', async () => {
    const tgbp = failingClient({
      error: { code: API_CODE, message: API_MESSAGE, details: { request_id: API_MESSAGE } },
    })
    const redacted = redactForPublicLog(await thrownBy(tgbp.mints.create(MINT_BODY)))
    expect(redacted.message).toBe(`API_ERROR on POST /api/v1/mints with 422: ${REDACTED}`)
  })

  it('masks an unreachable API, which has a call but no status', async () => {
    const tgbp = createTgbpClient({
      apiKey: 'tgbp_sandbox_test',
      environment: 'sandbox',
      fetch: (async () => {
        throw new TypeError(API_MESSAGE)
      }) as typeof globalThis.fetch,
      retry: { maxRetries: 0, baseDelayMs: 0 },
    })
    const redacted = redactForPublicLog(await thrownBy(tgbp.mints.create(MINT_BODY)))
    expect(redacted.message).toBe(`API_UNREACHABLE on POST /api/v1/mints: ${REDACTED}`)
    expect(leaks(printed(redacted))).toBe(false)
  })

  it('drops the message of an assertion, which quotes its values, but keeps its stack frames', () => {
    const failure = assertionFrom(() => expect(API_CODE).toBe('created'))
    // The control: vitest's own message quotes the actual value.
    expect(leaks(printed(failure as Error))).toBe(true)

    const redacted = redactForPublicLog(failure)
    expect(redacted.name).toBe('AssertionError')
    expect(redacted.message).toBe(REDACTED)
    expect(redacted.stack).toMatch(/redact\.test\.ts/)
    expect(leaks(printed(redacted))).toBe(false)
  })

  it("keeps the message of expect.fail, which is this repo's own text", () => {
    const failure = assertionFrom(() => expect.fail('the sandbox account requires dual approval'))
    expect(redactForPublicLog(failure).message).toBe('the sandbox account requires dual approval')
  })

  it('redacts a thrown non-Error value entirely', () => {
    expect(redactForPublicLog(API_MESSAGE).message).toBe(`non-Error thrown: ${REDACTED}`)
  })
})
