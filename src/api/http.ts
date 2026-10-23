/**
 * The one place the API clients talk HTTP. It sets the headers every request
 * carries, sends the idempotency key, and owns the retry rule: retry only a
 * network error or a 5xx, and only when the call is safe to repeat. A call
 * that creates a record is safe to repeat only because it resends the same
 * idempotency key, so a retry returns the first record instead of a second
 * mint or redemption.
 */
import { TgbpKitError } from '../errors.js'
import { KIT_VERSION } from '../version.js'

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number
  /** First backoff delay; each retry doubles it, with jitter. Default 500. */
  baseDelayMs?: number
}

export interface HttpOptions {
  /** Your tGBP API key, sent as `X-API-Key`. */
  apiKey: string
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Per-attempt timeout. A timeout counts as a network error. Default 30000. */
  timeoutMs?: number
  retry?: RetryOptions
}

export interface HttpConfig extends HttpOptions {
  baseUrl: string
}

type QueryValue = string | number | boolean | readonly (string | number)[] | undefined

export interface HttpRequest {
  method: 'GET' | 'POST'
  /** Path template, such as `/api/v1/mints/{mintId}`. */
  path: string
  pathParams?: Record<string, string>
  query?: Record<string, QueryValue>
  body?: unknown
  idempotencyKey?: string
  /**
   * A key the API dedupes on that travels in the body, such as a swap intent's
   * id. Errors name it so a caller retries with it, as with an idempotency key.
   */
  dedupeKey?: { name: string; value: string }
  /** True only when repeating the call cannot create or move anything twice. */
  retry: boolean
}

interface RequestContext {
  method: string
  path: string
  idempotencyKey?: string | undefined
  dedupeKey?: { name: string; value: string } | undefined
  attempts?: number
}

export interface HttpResponse<T> {
  status: number
  body: T
}

/** The format the tGBP API accepts: 1 to 18 letters, digits, `_` and `-`. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,18}$/
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

/**
 * A random 18-character key (108 bits). Store it with your order before you
 * call, so a retry after a crash can reuse it.
 */
export function generateIdempotencyKey(): string {
  // 64 symbols divide 256 evenly, so `byte & 63` is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return Array.from(bytes, (byte) => KEY_ALPHABET[byte & 63]).join('')
}

export function assertIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new RangeError(
      `Invalid idempotency key "${key}": use 1 to 18 letters, digits, "_" or "-"`,
    )
  }
}

/** Refuses plain HTTP, which would send the API key in cleartext, except to this machine. */
export function normaliseBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new RangeError(`baseUrl must use https: ${baseUrl}`)
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new RangeError(`baseUrl must not carry a query, fragment or credentials: ${baseUrl}`)
  }
  return url.href.replace(/\/+$/, '')
}

/** Fails at construction, so a bad option never turns into an endless loop or an instant timeout. */
export function assertHttpOptions(options: HttpOptions): void {
  const { maxRetries, baseDelayMs } = options.retry ?? {}
  if (maxRetries !== undefined && !(Number.isInteger(maxRetries) && maxRetries >= 0)) {
    throw new RangeError(`retry.maxRetries must be a non-negative integer: ${maxRetries}`)
  }
  if (baseDelayMs !== undefined && !(Number.isFinite(baseDelayMs) && baseDelayMs >= 0)) {
    throw new RangeError(`retry.baseDelayMs must be a finite number >= 0: ${baseDelayMs}`)
  }
  const { timeoutMs } = options
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new RangeError(`timeoutMs must be a finite number > 0: ${timeoutMs}`)
  }
}

export async function request<T>(config: HttpConfig, req: HttpRequest): Promise<HttpResponse<T>> {
  const fetchFn = config.fetch ?? globalThis.fetch
  const maxRetries = req.retry ? (config.retry?.maxRetries ?? 3) : 0
  const baseDelayMs = config.retry?.baseDelayMs ?? 500
  const url = buildUrl(config.baseUrl, req)
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': `tgbp-kit/${KIT_VERSION}`,
    'x-api-key': config.apiKey,
  }
  if (req.body !== undefined) headers['content-type'] = 'application/json'
  if (req.idempotencyKey !== undefined) headers['idempotency-key'] = req.idempotencyKey
  const body = req.body === undefined ? undefined : JSON.stringify(req.body)
  const timeoutMs = config.timeoutMs ?? 30_000
  const context: RequestContext = {
    method: req.method,
    path: req.path,
    idempotencyKey: req.idempotencyKey,
    dedupeKey: req.dedupeKey,
  }

  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await sleep(backoff(baseDelayMs, attempt))
    let response: Response
    let text: string
    // A failure anywhere before the whole body arrives, timeout included, is a network error.
    try {
      response = await fetchFn(url, {
        method: req.method,
        headers,
        body,
        // A redirect would carry X-API-Key to wherever it points.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status >= 500 && attempt < maxRetries) {
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      text = await response.text()
    } catch (cause) {
      if (attempt < maxRetries) continue
      throw new TgbpKitError(
        'API_UNREACHABLE',
        `${req.method} ${req.path} got no response (${describeCause(cause, timeoutMs)})${retryHint(context)}`,
        {
          cause,
          details: {
            ...contextDetails(context),
            attempts: attempt + 1,
            mayHaveTakenEffect: req.method !== 'GET',
          },
        },
      )
    }
    const parsed = parseJson(text)
    const errorContext = { ...context, attempts: attempt + 1 }
    // Keep a proxy's HTML or plain-text error, capped, so the caller can see what answered.
    const errorBody = parsed === NOT_JSON ? text.slice(0, 2000) : parsed
    if (!response.ok) throw apiError(response, errorBody, errorContext)
    if (parsed === NOT_JSON) {
      throw apiError(response, errorBody, errorContext, 'the response was not JSON')
    }
    // Every success the API documents carries a body, so an empty one is a broken answer.
    if (parsed === undefined) {
      throw apiError(response, undefined, errorContext, 'the response body was empty')
    }
    return { status: response.status, body: parsed as T }
  }
}

/** Names what went wrong without a response: a timeout, a reset, a DNS failure. */
function describeCause(cause: unknown, timeoutMs: number): string {
  const { name, message } = (cause ?? {}) as { name?: unknown; message?: unknown }
  if (name === 'TimeoutError') return `timed out after ${timeoutMs}ms`
  return `${typeof name === 'string' && name !== '' ? name : 'error'}: ${String(message ?? cause)}`
}

function buildUrl(baseUrl: string, req: HttpRequest): string {
  const path = req.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = req.pathParams?.[name]
    if (value === undefined) throw new RangeError(`Missing path parameter ${name}`)
    // URL parsing would resolve these as dot segments and call a different endpoint.
    if (value === '' || value === '.' || value === '..') {
      throw new RangeError(`Invalid path parameter ${name}: "${value}"`)
    }
    return encodeURIComponent(value)
  })
  const url = new URL(baseUrl + path)
  for (const [name, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item))
    }
  }
  return url.href
}

/** Exponential backoff with jitter: 0.5x to 1x of base * 2^(attempt - 1). */
function backoff(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2)
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

const NOT_JSON = Symbol('not JSON')

function parseJson(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return NOT_JSON
  }
}

/** The key a retry must resend: the idempotency key, or a dedupe key carried in the body. */
function retryKey(context: RequestContext): { name: string; value: string } | undefined {
  if (context.idempotencyKey !== undefined) {
    return { name: 'idempotency key', value: context.idempotencyKey }
  }
  return context.dedupeKey
}

function retryHint(context: RequestContext): string {
  const key = retryKey(context)
  if (key !== undefined) {
    return `; it may have taken effect, so retry only with the same ${key.name} (${key.value})`
  }
  return context.method === 'GET' ? '' : '; it may have taken effect, so read the record first'
}

/** The context as error details, with a dedupe key under its own name. */
function contextDetails({ dedupeKey, ...rest }: RequestContext): Record<string, unknown> {
  return dedupeKey === undefined ? rest : { ...rest, [dedupeKey.name]: dedupeKey.value }
}

export function apiError(
  response: Response,
  body: unknown,
  context: RequestContext,
  reason?: string,
) {
  const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } })
    ?.error
  const details = (error?.details ?? {}) as { request_id?: unknown }
  const apiCode = typeof error?.code === 'string' ? error.code : undefined
  const requestId =
    typeof details.request_id === 'string'
      ? details.request_id
      : (response.headers.get('x-request-id') ?? undefined)
  const message =
    reason ?? (typeof error?.message === 'string' ? error.message : response.statusText)
  // A 409 duplicate_request on a keyed create means an earlier request with that
  // key is still creating the record; resending under a new key would create a
  // second one. Other 409s, such as duplicate_active_mint, created nothing.
  const keyed409 =
    response.status === 409 && apiCode === 'duplicate_request' && retryKey(context) !== undefined
  const hint = response.ok || response.status >= 500 || keyed409 ? retryHint(context) : ''
  return new TgbpKitError(
    'API_ERROR',
    `${context.method} ${context.path} failed with ${response.status}${apiCode ? ` ${apiCode}` : ''}: ${message}${hint}`,
    {
      details: {
        ...contextDetails(context),
        status: response.status,
        apiCode,
        requestId,
        contentType: response.headers.get('content-type') ?? undefined,
        mayHaveTakenEffect: hint !== '',
        body,
      },
    },
  )
}

/**
 * A create answered 2xx without the record it promised. The call may still
 * have created it, so the error carries the key to retry with.
 */
export function incompleteCreate(
  path: string,
  status: number,
  body: unknown,
  idempotencyKey: string,
  missing: string,
): TgbpKitError {
  return new TgbpKitError(
    'API_ERROR',
    `POST ${path} returned ${status} without ${missing}${retryHint({ method: 'POST', path, idempotencyKey })}`,
    { details: { method: 'POST', path, idempotencyKey, status, body } },
  )
}
