import type { Address, Hash } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  DAILY_DRIP_LIMIT,
  type DripDeps,
  DripNotSent,
  drip,
  type FaucetStorage,
  ipBucket,
  MAY_HAVE_SENT,
  RATE_LIMIT_WINDOW_MS,
} from '../site/worker/faucet.js'
import { isTgbpKitError, TgbpKitError } from '../src/errors.js'
import { type FaucetResponse, requestTestTgbp } from '../src/faucet/index.js'

const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'
const HASH = `0x${'ab'.repeat(32)}` as Hash
const NOW = Date.parse('2026-10-29T12:00:00Z')

function memoryStorage(): FaucetStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => {
      data.set(key, value)
    },
    delete: async (key) => data.delete(key),
  }
}

function faucet(overrides: Partial<DripDeps> = {}) {
  const storage = memoryStorage()
  const send = vi.fn(async (_to: Address) => HASH)
  const deps: DripDeps = {
    storage,
    send,
    explorerUrl: 'https://sepolia.basescan.org',
    now: () => NOW,
    ...overrides,
  }
  return { storage, send, deps }
}

describe('faucet drip', () => {
  it('sends a fixed amount to a valid address', async () => {
    const { send, deps } = faucet()
    const result = await drip({ address: ALICE, chainId: 84532, ip: '203.0.113.1' }, deps)
    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        hash: HASH,
        amount: '10',
        confirmed: true,
        explorerUrl: `https://sepolia.basescan.org/tx/${HASH}`,
      },
    })
    expect(send).toHaveBeenCalledWith(ALICE)
  })

  it('refuses a second request for the same address inside the window', async () => {
    const { send, deps } = faucet()
    await drip({ address: ALICE, ip: '203.0.113.1' }, deps)
    const second = await drip(
      { address: ALICE.toUpperCase().replace('0X', '0x'), ip: '198.51.100.7' },
      deps,
    )
    expect(second.status).toBe(429)
    expect(second.body).toEqual({
      ok: false,
      reason: 'rate_limited',
      message: 'This address had test tGBP in the last 24 hours. Try again in 24 hours.',
      retryAfterSeconds: 86_400,
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('refuses a second request from the same IP inside the window', async () => {
    const { send, deps } = faucet()
    await drip({ address: ALICE, ip: '203.0.113.1' }, deps)
    const second = await drip({ address: BOB, ip: '203.0.113.1' }, deps)
    expect(second.status).toBe(429)
    expect(second.body).toMatchObject({
      ok: false,
      reason: 'rate_limited',
      message: expect.stringMatching(/^Your network had test tGBP in the last 24 hours/),
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('counts every IPv6 address in one /64 as the same network', async () => {
    const { deps } = faucet()
    await drip({ address: ALICE, ip: '2001:db8:1:2::1' }, deps)
    const second = await drip({ address: BOB, ip: '2001:0db8:0001:0002:ffff::9' }, deps)
    expect(second.body).toMatchObject({ reason: 'rate_limited' })
  })

  it('sends again once the window has passed', async () => {
    const { storage, send } = faucet()
    const base = { storage, send, explorerUrl: 'https://sepolia.basescan.org' }
    await drip({ address: ALICE, ip: '203.0.113.1' }, { ...base, now: () => NOW })
    const later = await drip(
      { address: ALICE, ip: '203.0.113.1' },
      { ...base, now: () => NOW + RATE_LIMIT_WINDOW_MS },
    )
    expect(later.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('refuses Base mainnet and any other chain id', async () => {
    const { send, deps } = faucet()
    for (const chainId of [8453, 1, '84532', null]) {
      const result = await drip({ address: ALICE, chainId, ip: '203.0.113.1' }, deps)
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ ok: false, reason: 'wrong_chain' })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a malformed or zero address', async () => {
    const { send, deps } = faucet()
    for (const address of [undefined, 42, '0x123', `0x${'0'.repeat(40)}`]) {
      const result = await drip({ address, ip: '203.0.113.1' }, deps)
      expect(result.body).toMatchObject({ ok: false, reason: 'invalid_request' })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('stops at the daily total until midnight UTC', async () => {
    const { storage, send, deps } = faucet()
    storage.data.set('day:2026-10-29', DAILY_DRIP_LIMIT)
    const result = await drip({ address: ALICE, ip: '203.0.113.1' }, deps)
    expect(result.status).toBe(429)
    expect(result.body).toMatchObject({ reason: 'daily_limit', retryAfterSeconds: 12 * 3600 })
    expect(send).not.toHaveBeenCalled()
  })

  it('gives the claim back when nothing was signed', async () => {
    const send = vi.fn(async (_to: Address): Promise<Hash> => {
      throw new DripNotSent(new TgbpKitError('INSUFFICIENT_BALANCE', 'empty'))
    })
    const { storage, deps } = faucet({ send })
    const result = await drip({ address: ALICE, ip: '203.0.113.1' }, deps)
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({
      ok: false,
      reason: 'unavailable',
      message: expect.stringMatching(/nothing was sent/),
    })
    expect([...storage.data]).toEqual([['day:2026-10-29', 0]])
  })

  it.each([
    ['an error after signing', new Error('socket hang up')],
    [
      'a mined revert',
      new TgbpKitError('TRANSFER_REVERTED', 'reverted', { details: { hash: HASH } }),
    ],
  ])('keeps the claim on %s, and never says nothing was sent', async (_name, failure) => {
    const send = vi.fn(async (_to: Address): Promise<Hash> => {
      throw failure
    })
    const { deps } = faucet({ send })
    const first = await drip({ address: ALICE, ip: '203.0.113.1' }, deps)
    expect(first.status).toBe(503)
    expect(first.body).toMatchObject({ ok: false, reason: 'unavailable', message: MAY_HAVE_SENT })
    const second = await drip({ address: ALICE, ip: '198.51.100.7' }, deps)
    expect(second.body).toMatchObject({ reason: 'rate_limited' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the claim when the drip was broadcast but not confirmed', async () => {
    const send = vi.fn(async (_to: Address): Promise<Hash> => {
      throw new TgbpKitError('TRANSFER_UNCONFIRMED', 'slow', { details: { hash: HASH } })
    })
    const { deps } = faucet({ send })
    const first = await drip({ address: ALICE, ip: '203.0.113.1' }, deps)
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ ok: true, hash: HASH, confirmed: false })
    const second = await drip({ address: ALICE, ip: '198.51.100.7' }, deps)
    expect(second.body).toMatchObject({ reason: 'rate_limited' })
  })
})

describe('ipBucket', () => {
  it('keeps IPv4 and reduces IPv6 to its /64', () => {
    expect(ipBucket('203.0.113.1')).toBe('203.0.113.1')
    expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:DB8::1')).toBe('2001:db8:0:0::/64')
    expect(ipBucket('::1')).toBe('0:0:0:0::/64')
    expect(ipBucket('::ffff:203.0.113.1')).toBe('203.0.113.1')
    expect(ipBucket('1:2:3:4:5:6:7:8::9')).toBe('1:2:3:4::/64')
  })
})

describe('requestTestTgbp', () => {
  const respond = (status: number, body: FaucetResponse) =>
    vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    )

  it('posts the address and returns the drip', async () => {
    const fetch = respond(200, {
      ok: true,
      hash: HASH,
      amount: '10',
      confirmed: true,
      explorerUrl: `https://sepolia.basescan.org/tx/${HASH}`,
    })
    const result = await requestTestTgbp({ address: ALICE, url: 'https://faucet.test', fetch })
    expect(result.hash).toBe(HASH)
    expect(fetch).toHaveBeenCalledWith(
      'https://faucet.test',
      expect.objectContaining({ method: 'POST' }),
    )
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined
    expect(JSON.parse(String(init?.body))).toEqual({ address: ALICE, chainId: 84532 })
  })

  it('refuses Base mainnet before sending anything', async () => {
    const fetch = vi.fn()
    const error = await requestTestTgbp({ address: ALICE, chainId: 8453, fetch }).catch((e) => e)
    expect(isTgbpKitError(error, 'FAUCET_REFUSED')).toBe(true)
    expect(error.details).toEqual({ reason: 'wrong_chain' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws a rate limit as FAUCET_REFUSED with the retry time', async () => {
    const fetch = respond(429, {
      ok: false,
      reason: 'rate_limited',
      message: 'This address had test tGBP in the last 24 hours. Try again in 3 hours.',
      retryAfterSeconds: 9000,
    })
    const error = await requestTestTgbp({ address: ALICE, fetch }).catch((e) => e)
    expect(isTgbpKitError(error, 'FAUCET_REFUSED')).toBe(true)
    expect(error.message).toMatch(/Try again in 3 hours/)
    expect(error.details).toEqual({ reason: 'rate_limited', retryAfterSeconds: 9000 })
  })

  it('reports a JSON body that is not a faucet response', async () => {
    const fetch = vi.fn(async () => new Response('null', { status: 200 }))
    await expect(
      requestTestTgbp({ address: ALICE, url: 'https://faucet.test', fetch }),
    ).rejects.toThrow('The faucet at https://faucet.test answered 200 without a faucet response')
  })

  it('reports a response that is not the faucet', async () => {
    const fetch = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(requestTestTgbp({ address: ALICE, fetch })).rejects.toThrow(
      'answered 502 without a faucet response',
    )
  })
})
