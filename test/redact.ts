/**
 * Strips what the API said from an error before the sandbox integration test
 * lets vitest print it.
 *
 * This repo's CI logs are public, and the sandbox API's error codes and
 * messages can name a banking provider (TGBP-6891). A list of names to mask
 * would itself disclose them, so this keeps only what the kit and this repo
 * wrote: the method, path, HTTP status and request id of a failed call, the
 * message of an error this repo threw, and every error's stack frames. It drops
 * the API's code and message, the error's details and cause, and an
 * assertion's message, whose text quotes the actual and expected values.
 *
 * The kit's own TgbpKitError stays unchanged for developers: only this repo's
 * CI output is redacted.
 */
import { isTgbpKitError } from '../src/errors.js'

export const REDACTED = '[API error text redacted from the public CI log]'

// The request id comes from the API too, so only an id-shaped one is printed.
const REQUEST_ID = /^[\w-]{1,64}$/

export function redactForPublicLog(error: unknown): Error {
  if (isTgbpKitError(error)) {
    const { method, path, status, requestId } = error.details
    const call =
      typeof method === 'string' && typeof path === 'string' ? ` on ${method} ${path}` : ''
    const http = typeof status === 'number' ? ` with ${status}` : ''
    const request =
      typeof requestId === 'string' && REQUEST_ID.test(requestId)
        ? ` (request id ${requestId})`
        : ''
    return rebuild('TgbpKitError', `${error.code}${call}${http}: ${REDACTED}${request}`, error)
  }
  if (error instanceof Error) {
    // expect.fail sets neither value, so its message is this repo's own text.
    const { actual, expected } = error as { actual?: unknown; expected?: unknown }
    const quotesValues = actual !== undefined || expected !== undefined
    return rebuild(error.name, quotesValues ? REDACTED : error.message, error)
  }
  return new Error(`non-Error thrown: ${REDACTED}`)
}

/** A plain Error with no cause or extra properties, keeping only the original's stack frames. */
function rebuild(name: string, message: string, original: Error): Error {
  const redacted = new Error(message)
  redacted.name = name
  const frames = (original.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
  redacted.stack = [`${name}: ${message}`, ...frames].join('\n')
  return redacted
}
