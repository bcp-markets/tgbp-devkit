import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  createTgbpClient,
  createTgbpSwapClient,
  generateIdempotencyKey,
  isTgbpKitError,
  KIT_VERSION,
} from '../src/api/index.js'

interface Call {
  url: URL
  method: string
  headers: Headers
  body: unknown
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error

/** A fetch that records each call and answers from `replies` in order. */
function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('fakeFetch: no reply left')
    if (reply instanceof Error) throw reply
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

const MINT = {
  id: 'mint_1',
  status: 'pending',
  address: '0x1111111111111111111111111111111111111111',
  chain: 'sepolia',
}

const MINT_BODY = {
  customerId: 'customer_1',
  destinationAddress: '0x1111111111111111111111111111111111111111',
  chain: 'sepolia',
  amount: { currency: 'GBP' as const, value: 10 },
}

function client(fetch: typeof globalThis.fetch) {
  return createTgbpClient({
    apiKey: 'tgbp_sandbox_test',
    environment: 'sandbox',
    fetch,
    retry: { baseDelayMs: 0 },
  })
}

describe('generateIdempotencyKey', () => {
  it('fits the API key format: 1 to 18 of letters, digits, _ and -', () => {
    const keys = new Set(Array.from({ length: 200 }, generateIdempotencyKey))
    expect(keys.size).toBe(200)
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{18}$/)
  })
})

describe('request headers', () => {
  it('sends the API key and User-Agent: tgbp-kit/<version> on every request', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { data: MINT } })
    await client(fetch).mints.get('mint_1')

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(KIT_VERSION).toBe(pkg.version)
    expect(calls[0]?.headers.get('user-agent')).toBe(`tgbp-kit/${pkg.version}`)
    expect(calls[0]?.headers.get('x-api-key')).toBe('tgbp_sandbox_test')
    expect(calls[0]?.url.href).toBe('https://sandbox.tgbp.io/api/v1/mints/mint_1')
  })

  it('sends the User-Agent from the swap client too', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { data: [] } })
    await createTgbpSwapClient({ apiKey: 'k', fetch }).getSupportedNetworks()
    expect(calls[0]?.headers.get('user-agent')).toBe(`tgbp-kit/${KIT_VERSION}`)
    expect(calls[0]?.url.href).toBe('https://swap-api.tgbp.io/api/supported-networks')
  })

  it('refuses a plain-HTTP base URL, which would send the key in cleartext', () => {
    expect(() => createTgbpClient({ apiKey: 'k', baseUrl: 'http://sandbox.tgbp.io' })).toThrow(
      /https/,
    )
    expect(() => createTgbpClient({ apiKey: 'k', baseUrl: 'http://localhost:3000' })).not.toThrow()
  })

  it('encodes path parameters', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { data: MINT } })
    await client(fetch).mints.get('a/b?c')
    expect(calls[0]?.url.pathname).toBe('/api/v1/mints/a%2Fb%3Fc')
  })

  it('repeats an array query parameter', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { data: [], pagination: {} } })
    await client(fetch).mints.list({ status: ['pending', 'confirmed'], per_page: 5 })
    expect(calls[0]?.url.searchParams.getAll('status')).toEqual(['pending', 'confirmed'])
    expect(calls[0]?.url.searchParams.get('per_page')).toBe('5')
  })
})

describe('idempotency', () => {
  it('sends a generated Idempotency-Key on every money-moving call', async () => {
    const { fetch, calls } = fakeFetch(
      { status: 201, body: { data: MINT } },
      { status: 201, body: { data: { id: 'red_1' } } },
    )
    const tgbp = client(fetch)
    const mint = await tgbp.mints.create(MINT_BODY)
    await tgbp.redemptions.create({
      chain: 'sepolia',
      amount: { currency: 'GBP', value: 5 },
      bankId: 'bank_1',
    })

    const [mintKey, redemptionKey] = calls.map((c) => c.headers.get('idempotency-key'))
    expect(mintKey).toMatch(/^[A-Za-z0-9_-]{18}$/)
    expect(redemptionKey).toMatch(/^[A-Za-z0-9_-]{18}$/)
    expect(mintKey).not.toBe(redemptionKey)
    expect(mint.idempotencyKey).toBe(mintKey)
  })

  it('sends a generated Idempotency-Key on a conversion', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: { data: { id: 'conv_1' } } })
    const swap = createTgbpSwapClient({ apiKey: 'k', fetch })
    await swap.createConversion({ chainId: 'base', intentId: 'intent_1' })
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{18}$/)
  })

  it('gives a swap intent a generated id, the key the swap API dedupes intents on', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: { data: { id: 'x' } } })
    const swap = createTgbpSwapClient({ apiKey: 'k', fetch })
    const result = await swap.createSwapIntent({
      chainId: 'base',
      direction: 'USDC_TO_TGBP',
      recipientAddress: '0x1111111111111111111111111111111111111111',
      sourceAmount: '10',
      sourceRawAmount: '10000000',
    })
    const sent = calls[0]?.body as { id: string }
    expect(sent.id).toMatch(/^[A-Za-z0-9_-]{18}$/)
    expect(result.idempotencyKey).toBe(sent.id)
  })

  it('uses a caller-supplied key, and rejects one the API would refuse', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: { data: MINT } })
    const tgbp = client(fetch)
    await tgbp.mints.create(MINT_BODY, { idempotencyKey: 'order_42' })
    expect(calls[0]?.headers.get('idempotency-key')).toBe('order_42')

    await expect(tgbp.mints.create(MINT_BODY, { idempotencyKey: 'has spaces' })).rejects.toThrow(
      /idempotency key/i,
    )
    await expect(tgbp.mints.create(MINT_BODY, { idempotencyKey: 'x'.repeat(19) })).rejects.toThrow(
      /idempotency key/i,
    )
    expect(calls).toHaveLength(1)
  })

  it('reports a replay and an approval-gated create', async () => {
    const { fetch } = fakeFetch(
      { status: 200, body: { data: MINT } },
      { status: 202, body: { data: { approval_request_id: 'appr_1', status: 'pending' } } },
    )
    const tgbp = client(fetch)
    const replay = await tgbp.mints.create(MINT_BODY, { idempotencyKey: 'k1' })
    expect(replay).toMatchObject({ status: 'replayed', data: MINT, idempotencyKey: 'k1' })
    const gated = await tgbp.mints.create(MINT_BODY, { idempotencyKey: 'k2' })
    expect(gated).toEqual({
      status: 'pending_approval',
      approvalRequestId: 'appr_1',
      idempotencyKey: 'k2',
    })
  })
})

describe('retries', () => {
  it('retries a network error and a 5xx with the same idempotency key', async () => {
    const { fetch, calls } = fakeFetch(
      new TypeError('fetch failed'),
      { status: 503, body: { error: { code: 'service_unavailable' } } },
      { status: 201, body: { data: MINT } },
    )
    const result = await client(fetch).mints.create(MINT_BODY)
    expect(result.status).toBe('created')
    expect(calls).toHaveLength(3)
    const keys = new Set(calls.map((c) => c.headers.get('idempotency-key')))
    expect(keys.size).toBe(1)
    expect(calls.map((c) => c.body)).toEqual([MINT_BODY, MINT_BODY, MINT_BODY])
  })

  it('does not retry a 4xx, including 429', async () => {
    for (const status of [400, 401, 404, 409, 422, 429]) {
      const { fetch, calls } = fakeFetch({
        status,
        body: { error: { code: 'nope', message: 'No.', details: { request_id: 'req_1' } } },
      })
      const error = await client(fetch)
        .mints.create(MINT_BODY, { idempotencyKey: 'k' })
        .catch((e: unknown) => e)
      expect(isTgbpKitError(error, 'API_ERROR'), String(status)).toBe(true)
      expect(error).toMatchObject({
        details: { status, apiCode: 'nope', requestId: 'req_1', idempotencyKey: 'k' },
      })
      // Only a 409 duplicate_request means the first request with this key is
      // still in progress; these all carry another code.
      const hinted = /retry only with the same idempotency key \(k\)/.test(String(error))
      expect(hinted, String(status)).toBe(false)
      expect(error).toMatchObject({ details: { mayHaveTakenEffect: false } })
      expect(calls, String(status)).toHaveLength(1)
    }
  })

  it('tells the caller to keep the key after a 409 on a create', async () => {
    const { fetch } = fakeFetch({
      status: 409,
      body: { error: { code: 'duplicate_request', message: 'In progress.' } },
    })
    const error = await client(fetch)
      .mints.create(MINT_BODY, { idempotencyKey: 'mint_0409' })
      .catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_ERROR')).toBe(true)
    expect((error as Error).message).toMatch(/same idempotency key \(mint_0409\)/)
    expect(error).toMatchObject({ details: { status: 409, mayHaveTakenEffect: true } })
  })

  it('does not tell the caller to keep the key after a 409 that created nothing', async () => {
    const { fetch } = fakeFetch({
      status: 409,
      body: { error: { code: 'duplicate_active_mint', message: 'Already active.' } },
    })
    const error = await client(fetch)
      .mints.create(MINT_BODY, { idempotencyKey: 'mint_0410' })
      .catch((e: unknown) => e)
    expect((error as Error).message).not.toMatch(/same idempotency key/)
    expect(error).toMatchObject({
      details: { apiCode: 'duplicate_active_mint', mayHaveTakenEffect: false },
    })
  })

  it('gives up after maxRetries and names the key to retry with', async () => {
    const { fetch, calls } = fakeFetch(
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    )
    const tgbp = createTgbpClient({
      apiKey: 'k',
      environment: 'sandbox',
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 0 },
    })
    const error = await tgbp.mints
      .create(MINT_BODY, { idempotencyKey: 'mint_0001' })
      .catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_UNREACHABLE')).toBe(true)
    expect(error).toMatchObject({
      details: { idempotencyKey: 'mint_0001', mayHaveTakenEffect: true },
    })
    expect((error as Error).message).toMatch(/got no response \(TypeError: fetch failed\)/)
    expect(calls).toHaveLength(3)
  })

  it('says a timeout timed out, and how long it waited', async () => {
    const fetch = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof globalThis.fetch
    const tgbp = createTgbpClient({
      apiKey: 'k',
      environment: 'sandbox',
      fetch,
      timeoutMs: 1234,
      retry: { maxRetries: 0 },
    })
    const error = await tgbp.mints.get('mint_1').catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_UNREACHABLE')).toBe(true)
    expect((error as Error).message).toMatch(/got no response \(timed out after 1234ms\)/)
    expect(error).toMatchObject({ details: { mayHaveTakenEffect: false } })
  })

  it('names the swap intent id when a swap intent create gets no response', async () => {
    const { fetch, calls } = fakeFetch(new TypeError('fetch failed'), new TypeError('fetch failed'))
    const swap = createTgbpSwapClient({
      apiKey: 'k',
      fetch,
      retry: { maxRetries: 1, baseDelayMs: 0 },
    })
    const error = await swap
      .createSwapIntent({
        chainId: 'base',
        direction: 'USDC_TO_TGBP',
        recipientAddress: '0x1111111111111111111111111111111111111111',
        sourceAmount: '10',
        sourceRawAmount: '10000000',
      })
      .catch((e: unknown) => e)
    const sent = calls[0]?.body as { id: string }
    expect(isTgbpKitError(error, 'API_UNREACHABLE')).toBe(true)
    expect(error).toMatchObject({ details: { swapIntentId: sent.id, mayHaveTakenEffect: true } })
    expect((error as Error).message).toContain(`retry only with the same swapIntentId (${sent.id})`)
    expect(calls).toHaveLength(2)
  })

  it('surfaces the last 5xx once retries run out', async () => {
    const { fetch, calls } = fakeFetch(
      { status: 500, body: { error: { code: 'internal_server_error' } } },
      { status: 502 },
    )
    const tgbp = createTgbpClient({
      apiKey: 'k',
      environment: 'sandbox',
      fetch,
      retry: { maxRetries: 1, baseDelayMs: 0 },
    })
    const error = await tgbp.mints.get('mint_1').catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_ERROR')).toBe(true)
    expect(error).toMatchObject({ details: { status: 502 } })
    expect(calls).toHaveLength(2)
  })

  it('never retries a call that has no idempotency key and is not safe to repeat', async () => {
    const { fetch, calls } = fakeFetch({ status: 500 })
    const error = await client(fetch)
      .mints.simulatePayin('mint_1')
      .catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_ERROR')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('retries reads', async () => {
    const { fetch, calls } = fakeFetch(new TypeError('fetch failed'), {
      status: 200,
      body: { data: { chainId: 'base' } },
    })
    const swap = createTgbpSwapClient({ apiKey: 'k', fetch, retry: { baseDelayMs: 0 } })
    await expect(swap.getDepositBalance({ chainId: 'base' })).resolves.toEqual({
      data: { chainId: 'base' },
    })
    expect(calls).toHaveLength(2)
  })
})

describe('review hardening', () => {
  it('throws on a 202 with no approval request id, keeping the key', async () => {
    const { fetch } = fakeFetch({ status: 202, body: { data: {} } })
    const error = await client(fetch)
      .mints.create(MINT_BODY, { idempotencyKey: 'k3' })
      .catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_ERROR')).toBe(true)
    expect(error).toMatchObject({ details: { status: 202, idempotencyKey: 'k3' } })
  })

  it('throws when a create answers 2xx without the record', async () => {
    const { fetch } = fakeFetch({ status: 201, body: {} }, { status: 201, body: { data: null } })
    const tgbp = client(fetch)
    await expect(tgbp.mints.create(MINT_BODY)).rejects.toThrow(/without the created record/)
    const swap = createTgbpSwapClient({ apiKey: 'k', fetch })
    await expect(swap.createConversion({ chainId: 'base', intentId: 'intent_1' })).rejects.toThrow(
      /without the created record/,
    )
  })

  it('treats a non-JSON 2xx as an error, not a success, and keeps the text', async () => {
    const fetch = (async () =>
      new Response('<html>proxy</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof globalThis.fetch
    const error = await client(fetch)
      .mints.get('mint_1')
      .catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_ERROR')).toBe(true)
    expect(error).toMatchObject({
      details: { body: '<html>proxy</html>', contentType: 'text/html' },
    })
  })

  it('keeps a non-JSON error body, capped at 2000 characters', async () => {
    const text = `Bad gateway ${'x'.repeat(3000)}`
    const fetch = (async () =>
      new Response(text, {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      })) as unknown as typeof globalThis.fetch
    const error = await client(fetch)
      .mints.get('mint_1')
      .catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_ERROR')).toBe(true)
    expect(error).toMatchObject({
      details: { status: 403, body: text.slice(0, 2000), contentType: 'text/plain' },
    })
  })

  it('treats an empty 2xx body as an error', async () => {
    const { fetch } = fakeFetch({ status: 200 })
    await expect(client(fetch).mints.get('mint_1')).rejects.toThrow(/the response body was empty/)
  })

  it('accepts only 200, 201 and 202 on a create', async () => {
    const { fetch } = fakeFetch({ status: 206, body: { data: MINT } }, { status: 204 })
    const tgbp = client(fetch)
    const error = await tgbp.mints
      .create(MINT_BODY, { idempotencyKey: 'k206' })
      .catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'API_ERROR')).toBe(true)
    expect((error as Error).message).toMatch(/without a recognised status \(200, 201 or 202\)/)
    expect(error).toMatchObject({ details: { status: 206, idempotencyKey: 'k206' } })
    // A 204 cannot carry a body, so it fails earlier, as an empty success, keeping the key.
    await expect(tgbp.mints.create(MINT_BODY, { idempotencyKey: 'k204' })).rejects.toMatchObject({
      code: 'API_ERROR',
      details: { status: 204, idempotencyKey: 'k204', mayHaveTakenEffect: true },
    })
  })

  it('rejects retry and timeout options that cannot work', () => {
    expect(() =>
      createTgbpClient({ apiKey: 'k', environment: 'sandbox', retry: { maxRetries: Infinity } }),
    ).toThrow(RangeError)
    expect(() => createTgbpSwapClient({ apiKey: 'k', timeoutMs: 0 })).toThrow(RangeError)
    expect(() =>
      createTgbpSwapClient({ apiKey: 'k', retry: { maxRetries: 1.5, baseDelayMs: -1 } }),
    ).toThrow(RangeError)
  })

  it('retries when the body fails to arrive, with the same key', async () => {
    let calls = 0
    const keys: (string | null)[] = []
    const fetch = (async (_: unknown, init?: RequestInit) => {
      calls++
      keys.push(new Headers(init?.headers).get('idempotency-key'))
      if (calls === 1) {
        const body = new ReadableStream({ start: (c) => c.error(new TypeError('reset')) })
        return new Response(body, { status: 201 })
      }
      return Response.json({ data: MINT }, { status: 201 })
    }) as unknown as typeof globalThis.fetch
    await expect(client(fetch).mints.create(MINT_BODY)).resolves.toMatchObject({
      status: 'created',
    })
    expect(calls).toBe(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('never follows a redirect, which would carry the API key elsewhere', async () => {
    let redirect: RequestRedirect | undefined
    const fetch = (async (_: unknown, init?: RequestInit) => {
      redirect = init?.redirect
      return Response.json({ data: MINT })
    }) as unknown as typeof globalThis.fetch
    await client(fetch).mints.get('mint_1')
    expect(redirect).toBe('error')
  })

  it('rejects dot-segment ids and a base URL with a query', async () => {
    const { fetch, calls } = fakeFetch()
    await expect(client(fetch).mints.get('..')).rejects.toThrow(RangeError)
    await expect(client(fetch).mints.cancel('.')).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(0)
    expect(() =>
      createTgbpClient({ apiKey: 'k', baseUrl: 'https://sandbox.tgbp.io/?x=1' }),
    ).toThrow(/query/)
  })

  it('rejects a swap intent id outside the API format', async () => {
    const { fetch, calls } = fakeFetch()
    const swap = createTgbpSwapClient({ apiKey: 'k', fetch })
    await expect(
      swap.createSwapIntent({
        id: 'abc',
        chainId: 'base',
        direction: 'USDC_TO_TGBP',
        recipientAddress: '0x1111111111111111111111111111111111111111',
        sourceAmount: '10',
        sourceRawAmount: '10000000',
      }),
    ).rejects.toThrow(/swap intent id/)
    expect(calls).toHaveLength(0)
  })
})
