/**
 * The x402 facilitator Worker's rules (facilitator/worker/facilitator.ts),
 * with the real x402 facilitator and schemes on a fake signer. The end-to-end
 * settlement runs against a fork of Base; see facilitator/README.md.
 */
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import type { FacilitatorEvmSigner } from '@x402/evm'
import { EIP2612_GAS_SPONSORING as LIBRARY_EIP2612_GAS_SPONSORING } from '@x402/extensions'
import { parseEther } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import {
  ALERT_INTERVAL_MS,
  checkGas,
  createTgbpFacilitator,
  EIP2612_GAS_SPONSORING,
  type Facilitator,
  type FacilitatorStorage,
  type HandleDeps,
  handle,
  NotConfigured,
  PENDING_TTL_MS,
  StoragePendingSettlements,
  StorageSettledPayments,
} from '../facilitator/worker/facilitator.js'
import { getEvmToken } from '../src/registry/index.js'

const BASE = getEvmToken('base')
const GAS_KEY = '0x00000000000000000000000000000000000000A1' as const
const TOKEN = 'secret-token'

function memoryStorage(): FacilitatorStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    async get<T>(key: string) {
      return map.get(key) as T | undefined
    },
    async put<T>(key: string, value: T) {
      map.set(key, value)
    },
    async delete(key: string) {
      return map.delete(key)
    },
  }
}

const fakeSigner: FacilitatorEvmSigner = {
  getAddresses: () => [GAS_KEY],
  readContract: async () => {
    throw new Error('not on chain')
  },
  verifyTypedData: async () => false,
  writeContract: async () => {
    throw new Error('not on chain')
  },
  sendTransaction: async () => {
    throw new Error('not on chain')
  },
  waitForTransactionReceipt: async () => ({ status: 'success' }),
  getCode: async () => undefined,
}

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: BASE.address,
    amount: '10000000000000000',
    payTo: '0x00000000000000000000000000000000000000b0',
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  } as PaymentRequirements
}

const payload = { x402Version: 2, payload: {} } as unknown as PaymentPayload

function fakeFacilitator(signers: Record<string, string[]> = {}): Facilitator & {
  verify: ReturnType<typeof vi.fn>
  settle: ReturnType<typeof vi.fn>
} {
  return {
    getSupported: () => ({ kinds: [], extensions: [], signers }),
    verify: vi.fn(async () => ({ isValid: true, payer: '0xpayer' })),
    settle: vi.fn(async () => ({
      success: true,
      transaction: '0xabc',
      network: 'eip155:8453' as const,
    })),
  }
}

function deps(overrides: Partial<HandleDeps> = {}, facilitator = fakeFacilitator()): HandleDeps {
  return {
    facilitator: async () => facilitator,
    authToken: TOKEN,
    token: BASE,
    serialize: (run) => run(),
    settled: new StorageSettledPayments(memoryStorage()),
    ...overrides,
  }
}

function post(path: string, body: unknown, auth = `Bearer ${TOKEN}`): Request {
  return new Request(`https://facilitator${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('createTgbpFacilitator', () => {
  it("keeps the extension key @x402/extensions' constant uses", () => {
    expect(EIP2612_GAS_SPONSORING).toEqual(LIBRARY_EIP2612_GAS_SPONSORING)
  })

  it('supports exact and upto with EIP-2612 gas sponsoring on Base mainnet only', () => {
    const supported = createTgbpFacilitator(
      fakeSigner,
      BASE,
      new StoragePendingSettlements(memoryStorage()),
    ).getSupported()
    expect(supported.kinds.map(({ scheme, network }) => `${scheme} ${network}`).sort()).toEqual([
      'exact eip155:8453',
      'upto eip155:8453',
    ])
    expect(supported.extensions).toContain('eip2612GasSponsoring')
    expect(Object.values(supported.signers).flat()).toEqual([GAS_KEY])
  })
})

describe('handle', () => {
  it('serves /supported to anyone', async () => {
    const response = await handle(new Request('https://facilitator/supported'), deps())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ kinds: [], extensions: [], signers: {} })
  })

  it('needs the bearer token for /verify and /settle', async () => {
    const facilitator = fakeFacilitator()
    const body = { paymentPayload: payload, paymentRequirements: requirements() }
    for (const path of ['/verify', '/settle']) {
      expect((await handle(post(path, body, ''), deps({}, facilitator))).status).toBe(401)
      expect((await handle(post(path, body, 'Bearer nope'), deps({}, facilitator))).status).toBe(
        401,
      )
      expect((await handle(post(path, body, TOKEN), deps({}, facilitator))).status).toBe(401)
    }
    expect(facilitator.verify).not.toHaveBeenCalled()
    expect(facilitator.settle).not.toHaveBeenCalled()
  })

  it('answers 503 for /verify and /settle when no token is configured', async () => {
    const body = { paymentPayload: payload, paymentRequirements: requirements() }
    for (const authToken of [undefined, '']) {
      const response = await handle(post('/settle', body, 'Bearer '), deps({ authToken }))
      expect(response.status).toBe(503)
    }
  })

  it('verifies and settles tGBP on its chain, settling through serialize', async () => {
    const facilitator = fakeFacilitator()
    const serialize = vi.fn((run: () => Promise<unknown>) => run()) as HandleDeps['serialize']
    const body = { paymentPayload: payload, paymentRequirements: requirements({ scheme: 'upto' }) }

    const verified = await handle(post('/verify', body), deps({ serialize }, facilitator))
    expect(await verified.json()).toEqual({ isValid: true, payer: '0xpayer' })
    expect(serialize).not.toHaveBeenCalled()

    const settled = await handle(post('/settle', body), deps({ serialize }, facilitator))
    expect(await settled.json()).toEqual({
      success: true,
      transaction: '0xabc',
      network: 'eip155:8453',
    })
    expect(serialize).toHaveBeenCalledOnce()
    expect(facilitator.settle).toHaveBeenCalledWith(payload, body.paymentRequirements)
  })

  it.each([
    ['another chain', { network: 'eip155:84532' as const }, 'invalid_network'],
    ['another asset', { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, 'unsupported_asset'],
    ['no asset', { asset: undefined as unknown as string }, 'unsupported_asset'],
    ['another scheme', { scheme: 'batch-settlement' }, 'unsupported_scheme'],
    ['a payTo that is not an address', { payTo: 'nope' }, 'invalid_pay_to'],
  ])('refuses %s without asking the facilitator', async (_, overrides, reason) => {
    const facilitator = fakeFacilitator()
    const body = { paymentPayload: payload, paymentRequirements: requirements(overrides) }

    const verified = await handle(post('/verify', body), deps({}, facilitator))
    expect(await verified.json()).toEqual({ isValid: false, invalidReason: reason })
    const settled = await handle(post('/settle', body), deps({}, facilitator))
    expect(await settled.json()).toMatchObject({ success: false, errorReason: reason })

    expect(facilitator.verify).not.toHaveBeenCalled()
    expect(facilitator.settle).not.toHaveBeenCalled()
  })

  it('refuses a payTo that is the gas key, in any letter case', async () => {
    const facilitator = fakeFacilitator({ 'eip155:*': [GAS_KEY] })
    const body = {
      paymentPayload: payload,
      paymentRequirements: requirements({ payTo: GAS_KEY.toLowerCase() }),
    }

    const verified = await handle(post('/verify', body), deps({}, facilitator))
    expect(await verified.json()).toEqual({ isValid: false, invalidReason: 'invalid_pay_to' })
    const settled = await handle(post('/settle', body), deps({}, facilitator))
    expect(await settled.json()).toMatchObject({ success: false, errorReason: 'invalid_pay_to' })

    expect(facilitator.verify).not.toHaveBeenCalled()
    expect(facilitator.settle).not.toHaveBeenCalled()
  })

  it('answers a retry of a settled payment with the same success, without settling again', async () => {
    const facilitator = fakeFacilitator()
    const shared = deps({}, facilitator)
    const body = { paymentPayload: payload, paymentRequirements: requirements() }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const first = await (await handle(post('/settle', body), shared)).json()
    const retry = await (await handle(post('/settle', body), shared)).json()
    expect(retry).toEqual(first)
    expect(retry).toMatchObject({ success: true, transaction: '0xabc' })
    expect(facilitator.settle).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenLastCalledWith('settlement', expect.stringContaining('"cached":true'))
    log.mockRestore()
  })

  it('settles again after a failed settlement, which it does not remember', async () => {
    const facilitator = fakeFacilitator()
    facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: 'transaction_failed',
      transaction: '',
      network: 'eip155:8453',
    })
    const shared = deps({}, facilitator)
    const body = { paymentPayload: payload, paymentRequirements: requirements() }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(await (await handle(post('/settle', body), shared)).json()).toMatchObject({
      success: false,
    })
    expect(await (await handle(post('/settle', body), shared)).json()).toMatchObject({
      success: true,
    })
    expect(facilitator.settle).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })

  it('takes URLs, and the RPC key in them, out of library messages', async () => {
    const facilitator = fakeFacilitator()
    const message = 'HTTP request failed. URL: https://rpc.example/v2/key-123 Status: 429'
    facilitator.verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'unexpected_verify_error',
      invalidMessage: message,
    })
    facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: 'unexpected_settle_error',
      errorMessage: message,
      transaction: '',
      network: 'eip155:8453',
    })
    const body = { paymentPayload: payload, paymentRequirements: requirements() }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const verified = await handle(post('/verify', body), deps({}, facilitator))
    expect(await verified.json()).toMatchObject({
      invalidMessage: 'HTTP request failed. URL: <url> Status: 429',
    })
    const settled = await handle(post('/settle', body), deps({}, facilitator))
    expect(await settled.json()).toMatchObject({
      errorMessage: 'HTTP request failed. URL: <url> Status: 429',
    })
    log.mockRestore()
  })

  it('takes the asset address in any letter case', async () => {
    const facilitator = fakeFacilitator()
    const body = {
      paymentPayload: payload,
      paymentRequirements: requirements({ asset: BASE.address.toLowerCase() }),
    }
    await handle(post('/verify', body), deps({}, facilitator))
    expect(facilitator.verify).toHaveBeenCalledOnce()
  })

  it.each([
    ['not JSON', '{'],
    ['no requirements', { paymentPayload: payload }],
    ['an array', [payload]],
    [
      'too large',
      { paymentPayload: payload, paymentRequirements: requirements(), pad: 'x'.repeat(20_000) },
    ],
  ])('answers 400 for a body that is %s', async (_, body) => {
    expect((await handle(post('/verify', body), deps())).status).toBe(400)
  })

  it('answers 503 when a secret is missing, and 500 with no detail on any other failure', async () => {
    const body = { paymentPayload: payload, paymentRequirements: requirements() }
    const missing = await handle(
      post('/settle', body),
      deps({
        facilitator: async () => {
          throw new NotConfigured('FACILITATOR_PRIVATE_KEY is not set')
        },
      }),
    )
    expect(missing.status).toBe(503)

    const facilitator = fakeFacilitator()
    facilitator.settle.mockRejectedValueOnce(new Error('https://rpc.example/key-123 failed'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failed = await handle(post('/settle', body), deps({}, facilitator))
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('key-123')
    error.mockRestore()
  })

  it('answers 404 and 405 for other paths and methods', async () => {
    expect((await handle(new Request('https://facilitator/'), deps())).status).toBe(404)
    expect((await handle(new Request('https://facilitator/settle'), deps())).status).toBe(405)
    expect((await handle(post('/supported', {}), deps())).status).toBe(405)
  })
})

describe('StoragePendingSettlements', () => {
  it('finds a pending settlement again after a restart, until its TTL passes', async () => {
    const storage = memoryStorage()
    let now = 1_000
    await new StoragePendingSettlements(storage, () => now).set('payment-1', '0xhash')

    // A new instance on the same storage is what a restarted Durable Object sees.
    const restarted = new StoragePendingSettlements(storage, () => now)
    now += PENDING_TTL_MS
    expect(await restarted.get('payment-1')).toBe('0xhash')
    now += 1
    expect(await restarted.get('payment-1')).toBeUndefined()
    expect(storage.map.size).toBe(0)
  })

  it('forgets a settlement once it is deleted', async () => {
    const store = new StoragePendingSettlements(memoryStorage())
    await store.set('payment-1', '0xhash')
    await store.delete('payment-1')
    expect(await store.get('payment-1')).toBeUndefined()
  })
})

describe('StorageSettledPayments', () => {
  it('remembers a settlement until the TTL passes, then forgets it', async () => {
    const storage = memoryStorage()
    let now = 1_000
    const store = new StorageSettledPayments(storage, () => now)
    const result = { success: true, transaction: '0xabc', network: 'eip155:8453' as const }
    await store.set('payment-1', result)

    now += PENDING_TTL_MS
    expect(await store.get('payment-1')).toEqual(result)
    now += 1
    expect(await store.get('payment-1')).toBeUndefined()
    expect(storage.map.size).toBe(0)
  })
})

describe('checkGas', () => {
  const threshold = parseEther('0.001')

  function gas(balance: bigint, storage = memoryStorage(), now = () => 0) {
    const notify = vi.fn(async (_text: string) => undefined)
    return {
      notify,
      storage,
      run: () =>
        checkGas({
          storage,
          address: GAS_KEY,
          balance: async () => balance,
          threshold,
          notify,
          now,
        }),
    }
  }

  it('stays quiet at or above the threshold', async () => {
    const { run, notify } = gas(threshold)
    expect(await run()).toBe('ok')
    expect(notify).not.toHaveBeenCalled()
  })

  it('alerts below the threshold with the address and balance, once per interval', async () => {
    const storage = memoryStorage()
    let now = 0
    const low = gas(parseEther('0.0004'), storage, () => now)
    expect(await low.run()).toBe('alerted')
    expect(low.notify).toHaveBeenCalledWith(expect.stringContaining(GAS_KEY))
    expect(low.notify.mock.calls[0]?.[0]).toContain('0.0004 ETH, below the 0.001 ETH')

    now = ALERT_INTERVAL_MS - 1
    expect(await low.run()).toBe('already-alerted')
    now = ALERT_INTERVAL_MS
    expect(await low.run()).toBe('alerted')
    expect(low.notify).toHaveBeenCalledTimes(2)
  })

  it('alerts again at once after a top-up and a new drop', async () => {
    const storage = memoryStorage()
    expect(await gas(0n, storage).run()).toBe('alerted')
    expect(await gas(threshold, storage).run()).toBe('ok')
    expect(await gas(0n, storage).run()).toBe('alerted')
  })

  it('retries on the next check when the alert could not be sent', async () => {
    const storage = memoryStorage()
    const failing = gas(0n, storage)
    failing.notify.mockRejectedValueOnce(new Error('webhook answered 500'))
    await expect(failing.run()).rejects.toThrow('webhook answered 500')
    expect(await failing.run()).toBe('alerted')
  })
})
