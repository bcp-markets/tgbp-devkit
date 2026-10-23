/**
 * Strips what the API said from an error before the sandbox integration test
 * lets vitest print it.
 *
 * This repo's CI logs are public, and the sandbox API's error codes and
 * messages can name a banking provider. A list of names to mask would itself
 * disclose them, so this keeps only what the kit and this repo wrote: the
 * method, path, HTTP status and request id of a failed call, and the message
 * and stack of any other error. It drops the API's code and message, the
 * error's details and cause, and an assertion's actual and expected values.
 *
 * The kit's own TgbpKitError stays unchanged for developers: only this repo's
 * CI output is redacted.
 */
import { isTgbpKitError } from '../src/errors.js'

export const REDACTED = '[API error text redacted from the public CI log]'

export function redactForPublicLog(error: unknown): Error {
  if (isTgbpKitError(error)) {
    const { method, path, status, requestId } = error.details
    const call =
      typeof method === 'string' && typeof path === 'string' ? ` on ${method} ${path}` : ''
    const http = typeof status === 'number' ? ` with ${status}` : ''
    const request = typeof requestId === 'string' ? ` (request id ${requestId})` : ''
    return rebuild('TgbpKitError', `${error.code}${call}${http}: ${REDACTED}${request}`, error)
  }
  if (error instanceof Error) return rebuild(error.name, error.message, error)
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
