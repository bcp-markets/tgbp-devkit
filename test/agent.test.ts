/**
 * The spend policy, its ledger and the guard: every rule refuses with
 * SPEND_POLICY_DENIED and names itself.
 */
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type Approver,
  createSpendGuard,
  isTgbpKitError,
  loadSpendPolicy,
  parseSpendPolicy,
  type SpendGuardOptions,
  type SpendPolicy,
  type SpendRequest,
} from '../src/agent/index.js'

const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const NOW = new Date('2026-10-21T12:00:00Z')
const MINUTE = 60_000

const POLICY: SpendPolicy = {
  version: 1,
  expiresAt: '2026-12-31T23:59:59Z',
  actions: ['balance', 'transfer', 'mint', 'redeem', 'swap', 'x402'],
  chains: ['sepolia'],
  destinations: [ALICE, 'bank_ok'],
  perTransferCap: '100',
  dailyCap: '150',
  redemptionApprovalAbove: '50',
  x402: {
    services: [
      { match: 'api.example.com', category: 'data' },
      { match: 'https://search.example.com/v1', category: 'search' },
    ],
    categoryBudgets: { data: '60', search: '1' },
    paymentsPerMinute: 3,
  },
}

const transfer = (amount: string, extra: Partial<SpendRequest> = {}): SpendRequest =>
  ({ action: 'transfer', chain: 'sepolia', destination: ALICE, amount, ...extra }) as SpendRequest
const x402 = (
  amount: string,
  reason = 'a weather report',
  url = 'https://api.example.com/weather',
): SpendRequest => ({
  action: 'x402',
  chain: 'sepolia',
  destination: ALICE,
  amount,
  url,
  reason,
})
const yes: Approver = async () => true
const redeem = (amount: string): SpendRequest => ({
  action: 'redeem',
  chain: 'sepolia',
  destination: 'bank_ok',
  amount,
})

let dir: string
let ledgerPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tgbp-agent-'))
  ledgerPath = join(dir, 'policy.ledger.jsonl')
})

afterEach(() => rm(dir, { recursive: true, force: true }))

function guard(options: Partial<SpendGuardOptions> = {}) {
  return createSpendGuard({ policy: POLICY, ledgerPath, now: () => NOW, ...options })
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!isTgbpKitError(error, 'SPEND_POLICY_DENIED')) {
    throw new Error(`expected SPEND_POLICY_DENIED, got ${String(error)}`)
  }
  return error.details.rule as string
}

describe('parseSpendPolicy', () => {
  it('accepts a complete policy', () => {
    expect(parseSpendPolicy(POLICY)).toEqual(POLICY)
  })

  it.each([
    ['a missing field', { ...POLICY, dailyCap: undefined }, 'missing field "dailyCap"'],
    ['an unknown field', { ...POLICY, dailyCaps: '5' }, 'unknown field "dailyCaps"'],
    ['an unknown action', { ...POLICY, actions: ['bridge'] }, 'unknown action "bridge"'],
    ['a numeric cap', { ...POLICY, perTransferCap: 100 }, '"perTransferCap" must be'],
    ['a negative cap', { ...POLICY, dailyCap: '-1' }, '"dailyCap" must be'],
    ['an expiry with no zone', { ...POLICY, expiresAt: '2026-12-31T23:59' }, '"expiresAt"'],
    ['another version', { ...POLICY, version: 2 }, '"version" must be 1'],
    [
      'x402 with no x402 rules',
      { ...POLICY, x402: undefined },
      'a policy that allows "x402" needs "x402" rules',
    ],
    [
      'an unknown x402 field',
      { ...POLICY, x402: { ...POLICY.x402, perService: 1 } },
      'unknown field "x402.perService"',
    ],
    [
      'a service whose category has no budget',
      { ...POLICY, x402: { ...POLICY.x402, categoryBudgets: { data: '60' } } },
      'spends from "search", which has no budget',
    ],
    [
      'a service that is neither a host nor a URL',
      { ...POLICY, x402: { ...POLICY.x402, services: [{ match: 'api.*', category: 'data' }] } },
      'is not a host name or a URL',
    ],
    [
      'a service URL with a query',
      {
        ...POLICY,
        x402: { ...POLICY.x402, services: [{ match: 'https://a.example/?k=1', category: 'data' }] },
      },
      'no credentials, query or fragment',
    ],
    [
      'a service listed twice',
      {
        ...POLICY,
        x402: {
          ...POLICY.x402,
          services: [
            { match: 'api.example.com', category: 'data' },
            { match: 'api.example.com', category: 'search' },
          ],
        },
      },
      'listed twice',
    ],
    [
      'a category named after an Object property',
      {
        ...POLICY,
        x402: {
          ...POLICY.x402,
          services: [{ match: 'api.example.com', category: 'constructor' }],
          categoryBudgets: {},
        },
      },
      'which has no budget',
    ],
    [
      'one service listed twice in different forms',
      {
        ...POLICY,
        x402: {
          ...POLICY.x402,
          services: [
            { match: 'API.example.com', category: 'data' },
            { match: 'api.example.com', category: 'search' },
          ],
        },
      },
      'listed twice',
    ],
    [
      'zero payments a minute',
      { ...POLICY, x402: { ...POLICY.x402, paymentsPerMinute: 0 } },
      '"x402.paymentsPerMinute" must be',
    ],
  ])('rejects %s', (_, input, message) => {
    expect(() => parseSpendPolicy(input)).toThrow(message)
  })

  it('loads a policy file', async () => {
    const path = join(dir, 'policy.json')
    await writeFile(path, JSON.stringify(POLICY))
    await expect(loadSpendPolicy(path)).resolves.toEqual(POLICY)
  })
})

describe('createSpendGuard', () => {
  it('allows an action within the policy and records it in the ledger', async () => {
    await guard().authorize(transfer('40'))
    const [line] = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
    expect(JSON.parse(line ?? '')).toMatchObject({
      day: '2026-10-21',
      action: 'transfer',
      destination: ALICE,
      amount: '40',
    })
  })

  it('refuses a transfer over the per-transfer cap', async () => {
    expect(await refusal(guard().authorize(transfer('100.01')))).toBe('perTransferCap')
  })

  it('refuses a destination that is not allowlisted', async () => {
    const other = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
    expect(await refusal(guard().authorize(transfer('1', { destination: other })))).toBe(
      'destinations',
    )
  })

  it('matches an EVM destination whatever its case', async () => {
    await expect(
      guard().authorize(transfer('1', { destination: ALICE.toLowerCase() })),
    ).resolves.toBeUndefined()
  })

  it('refuses a chain the policy does not allow', async () => {
    expect(await refusal(guard().authorize(transfer('1', { chain: 'base' })))).toBe('chains')
  })

  it('refuses an action the policy does not allow', async () => {
    const g = guard({ policy: { ...POLICY, actions: ['balance'] } })
    expect(await refusal(g.authorize(transfer('1')))).toBe('actions')
  })

  it('refuses everything once the policy has expired', async () => {
    const g = guard({ now: () => new Date('2027-01-01T00:00:00Z') })
    expect(await refusal(g.authorize({ action: 'balance', chain: 'sepolia' }))).toBe('expiresAt')
    expect(await refusal(g.authorize(transfer('1')))).toBe('expiresAt')
  })

  it('refuses a transfer that would pass the daily cap, and resets on the next UTC day', async () => {
    await guard().authorize(transfer('100'))
    expect(await refusal(guard().authorize(transfer('50.01')))).toBe('dailyCap')
    await guard().authorize(transfer('50'))
    const tomorrow = guard({ now: () => new Date('2026-10-22T00:00:00Z') })
    await expect(tomorrow.authorize(transfer('100'))).resolves.toBeUndefined()
  })

  it('never lets concurrent actions share out more than the daily cap', async () => {
    const g = guard()
    const results = await Promise.allSettled([1, 2, 3].map(() => g.authorize(transfer('60'))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
  })

  it('refuses when the ledger cannot be read', async () => {
    await mkdir(ledgerPath)
    expect(await refusal(guard().authorize(transfer('1')))).toBe('ledger')
  })

  it('refuses when the ledger holds a corrupt line, rather than counting it as zero', async () => {
    await writeFile(
      ledgerPath,
      `{"at":"${NOW.toISOString()}","day":"2026-10-21","amount":"lots"}\n`,
    )
    expect(await refusal(guard().authorize(transfer('1')))).toBe('ledger')
  })

  it('refuses, and never breaks the lock, while another process holds it', async () => {
    await writeFile(`${ledgerPath}.lock`, '')
    const old = new Date(Date.now() - 60_000)
    await utimes(`${ledgerPath}.lock`, old, old)
    expect(await refusal(guard({ ledgerLockWaitMs: 50 }).authorize(transfer('1')))).toBe('ledger')
    await expect(readFile(`${ledgerPath}.lock`)).resolves.toBeDefined()
    await expect(readFile(ledgerPath)).rejects.toThrow()
  })

  it('records an x402 payment with its URL, service, category, price in pence, payee, reason and time', async () => {
    await guard({ approver: yes }).authorize(x402('0.05'))
    const [line] = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
    expect(JSON.parse(line ?? '')).toEqual({
      at: NOW.toISOString(),
      day: '2026-10-21',
      action: 'x402',
      chain: 'sepolia',
      destination: ALICE,
      amount: '0.05',
      url: 'https://api.example.com/weather',
      pence: '5',
      reason: 'a weather report',
      service: 'api.example.com',
      category: 'data',
      firstPayment: true,
    })
  })

  it('counts x402 payments against the same daily cap as transfers', async () => {
    await guard().authorize(transfer('100'))
    await guard({ approver: yes }).authorize(x402('49.99'))
    expect(await refusal(guard().authorize(x402('0.02')))).toBe('dailyCap')
  })

  it('refuses an x402 payment with no reason, or one too long to record', async () => {
    await expect(guard().authorize(x402('0.05', ' '))).rejects.toThrow(RangeError)
    await expect(guard().authorize(x402('0.05', 'x'.repeat(501)))).rejects.toThrow(RangeError)
    await expect(readFile(ledgerPath)).rejects.toThrow()
  })

  it('leaves balance reads out of the ledger', async () => {
    await guard().authorize({ action: 'balance', chain: 'sepolia' })
    await expect(readFile(ledgerPath)).rejects.toThrow()
  })
})

describe('x402 services', () => {
  const at = (ms: number) => () => new Date(NOW.getTime() + ms)

  it('refuses a payment to a host no service lists, and records nothing', async () => {
    const g = guard({ approver: yes })
    expect(await refusal(g.authorize(x402('0.05', 'a quote', 'https://evil.example/quote')))).toBe(
      'services',
    )
    // A subdomain, and a lookalike path on a listed endpoint's host, are other services.
    for (const url of [
      'https://eu.api.example.com/weather',
      'https://search.example.com/v1x',
      'https://search.example.com/v2/find',
      'http://search.example.com/v1/find',
    ]) {
      expect(await refusal(g.authorize(x402('0.05', 'a quote', url)))).toBe('services')
    }
    await expect(readFile(ledgerPath)).rejects.toThrow()
  })

  it('matches a host rule only over https on the default port', async () => {
    const g = guard({ approver: yes })
    for (const url of ['http://api.example.com/weather', 'https://api.example.com:8443/weather']) {
      expect(await refusal(g.authorize(x402('0.05', 'a quote', url)))).toBe('services')
    }
    await g.authorize(x402('0.05', 'a quote', 'https://API.example.com:443/weather'))
  })

  it('refuses a policy built in code with rules the parser would reject', () => {
    const x402 = { ...POLICY.x402, paymentsPerMinute: Number.NaN }
    expect(() => guard({ policy: { ...POLICY, x402 } as SpendPolicy })).toThrow(
      '"x402.paymentsPerMinute" must be',
    )
  })

  it('pays a listed endpoint and the paths below it', async () => {
    const g = guard({ approver: yes })
    await g.authorize(x402('0.05', 'a search', 'https://search.example.com/v1'))
    await g.authorize(x402('0.05', 'a search', 'https://search.example.com/v1/find'))
  })

  it('files a URL under the most specific service: an endpoint over its host', async () => {
    const policy: SpendPolicy = {
      ...POLICY,
      x402: {
        services: [
          { match: 'api.example.com', category: 'data' },
          { match: 'https://api.example.com/premium', category: 'search' },
        ],
        categoryBudgets: { data: '60', search: '1' },
        paymentsPerMinute: 3,
      },
    }
    await guard({ policy, approver: yes }).authorize(
      x402('0.05', 'a premium quote', 'https://api.example.com/premium/gbp'),
    )
    const [line] = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
    expect(JSON.parse(line ?? '')).toMatchObject({
      service: 'https://api.example.com/premium',
      category: 'search',
    })
  })

  it('refuses x402 outright under a policy object with no x402 rules', async () => {
    const policy = { ...POLICY, x402: undefined }
    expect(await refusal(guard({ policy, approver: yes }).authorize(x402('0.05')))).toBe('services')
  })

  it('gives each category its own rolling 24-hour budget', async () => {
    const g = guard({ approver: yes })
    const search = (amount: string) => x402(amount, 'a search', 'https://search.example.com/v1')
    await g.authorize(search('0.60'))
    await g.authorize(search('0.40'))
    const error = await g.authorize(search('0.01')).catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'SPEND_POLICY_DENIED') && error.details).toMatchObject({
      rule: 'categoryBudgets',
      category: 'search',
      spentInCategory: '1',
    })
    // The search budget is spent; the data budget still pays.
    await g.authorize(x402('5'))
    // Moving the search service into another category moves its spend with it.
    const moved: SpendPolicy = {
      ...POLICY,
      x402: {
        services: [{ match: 'https://search.example.com/v1', category: 'lookups' }],
        categoryBudgets: { lookups: '1' },
        paymentsPerMinute: 10,
      },
    }
    expect(await refusal(guard({ policy: moved }).authorize(search('0.01')))).toBe(
      'categoryBudgets',
    )
    // A rolling window: not the next UTC day, but 24 hours after the spend.
    const nextDay = guard({ now: at(13 * 60 * 60_000) })
    expect(await refusal(nextDay.authorize(search('0.01')))).toBe('categoryBudgets')
    await guard({ now: at(24 * 60 * 60_000 + 1) }).authorize(search('0.01'))
  })

  it('asks the owner before the first payment to a service, then lets the budget decide', async () => {
    const asked: unknown[] = []
    let answer = false
    const approver: Approver = async (request) => {
      asked.push(request)
      return answer
    }
    const g = guard({ approver })
    const error = await g.authorize(x402('0.05')).catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'SPEND_POLICY_DENIED') && error.details).toMatchObject({
      rule: 'firstPayment',
      service: 'api.example.com',
    })
    expect((error as Error).message).toContain('approval required')
    await expect(readFile(ledgerPath)).rejects.toThrow()

    answer = true
    await g.authorize(x402('0.05'))
    const [approved] = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
    expect(JSON.parse(approved ?? '')).toMatchObject({ firstPayment: true })
    expect(asked).toEqual([
      expect.objectContaining({ action: 'x402', service: 'api.example.com', category: 'data' }),
      expect.objectContaining({
        action: 'x402',
        service: 'api.example.com',
        url: 'https://api.example.com/weather',
      }),
    ])

    // Paid once, so no more questions, even from a guard with no approver at all.
    await guard().authorize(x402('0.05'))
    await guard().authorize(x402('0.05', 'a forecast', 'https://api.example.com/forecast'))
    expect(asked).toHaveLength(2)
    // Another service is new again.
    const search = x402('0.05', 'a search', 'https://search.example.com/v1')
    expect(await refusal(guard({ now: at(MINUTE) }).authorize(search))).toBe('firstPayment')
  })

  it('refuses the first payment when no owner can be asked', async () => {
    expect(await refusal(guard().authorize(x402('0.05')))).toBe('firstPayment')
  })

  it('does not ask the owner about a payment a budget would refuse', async () => {
    let asked = false
    const g = guard({
      approver: async () => {
        asked = true
        return true
      },
    })
    expect(
      await refusal(g.authorize(x402('1.01', 'a search', 'https://search.example.com/v1'))),
    ).toBe('categoryBudgets')
    expect(asked).toBe(false)
  })

  it('allows at most paymentsPerMinute payments in any rolling minute', async () => {
    const g = guard({ approver: yes })
    for (let i = 0; i < 3; i++) await g.authorize(x402('0.01'))
    const error = await g.authorize(x402('0.01')).catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'SPEND_POLICY_DENIED') && error.details.rule).toBe(
      'paymentsPerMinute',
    )
    // Every service counts towards the same limit, and other actions do not.
    await guard().authorize(transfer('1'))
    expect(
      await refusal(
        guard({ approver: yes }).authorize(
          x402('0.01', 'a search', 'https://search.example.com/v1'),
        ),
      ),
    ).toBe('paymentsPerMinute')
    expect(await refusal(guard({ now: at(MINUTE - 1) }).authorize(x402('0.01')))).toBe(
      'paymentsPerMinute',
    )
    await guard({ now: at(MINUTE) }).authorize(x402('0.01'))
  })

  it('never lets concurrent payments pass the per-minute limit', async () => {
    await guard({ approver: yes }).authorize(x402('0.01'))
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => guard().authorize(x402('0.01'))),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
  })

  it('refuses when a ledger entry has no readable time, rather than leaving it out of a window', async () => {
    await writeFile(
      ledgerPath,
      '{"at":"soon","day":"2026-10-21","amount":"0.01","action":"x402"}\n',
    )
    expect(await refusal(guard({ approver: yes }).authorize(x402('0.01')))).toBe('ledger')
  })
})

describe('budget', () => {
  it('reports what is left under the daily cap, before and after spending', async () => {
    const g = guard()
    await expect(g.budget()).resolves.toEqual({
      day: '2026-10-21',
      dailyCap: '150',
      spent: '0',
      remaining: '150',
    })
    await g.authorize(transfer('40'))
    await guard({ approver: yes }).authorize(x402('0.05'))
    await expect(g.budget()).resolves.toMatchObject({ spent: '40.05', remaining: '109.95' })
  })

  it('reports nothing left once the policy has expired', async () => {
    const g = guard({ now: () => new Date('2027-01-01T00:00:00Z') })
    await expect(g.budget()).resolves.toMatchObject({ remaining: '0' })
  })

  it('throws SPEND_POLICY_DENIED when the ledger cannot be read', async () => {
    await mkdir(ledgerPath)
    expect(await refusal(guard().budget())).toBe('ledger')
  })
})

describe('redemption approval', () => {
  it('lets a redemption at the threshold through without asking', async () => {
    let asked = false
    const approver: Approver = async () => {
      asked = true
      return true
    }
    await guard({ approver }).authorize(redeem('50'))
    expect(asked).toBe(false)
  })

  it('refuses a redemption over the threshold when no human can be asked', async () => {
    expect(await refusal(guard().authorize(redeem('50.01')))).toBe('redemptionApprovalAbove')
  })

  it('allows it once a human approves', async () => {
    await expect(guard({ approver: async () => true }).authorize(redeem('80'))).resolves.toBe(
      undefined,
    )
  })

  it('refuses it when the human says no', async () => {
    const g = guard({ approver: async () => false })
    expect(await refusal(g.authorize(redeem('80')))).toBe('redemptionApprovalAbove')
  })

  it('refuses on timeout, aborts the request, and ignores a late yes', async () => {
    let aborted = false
    const approver: Approver = (_, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        setTimeout(() => resolve(true), 100)
      })
    const g = guard({ approver, approvalTimeoutMs: 20 })
    expect(await refusal(g.authorize(redeem('80')))).toBe('redemptionApprovalAbove')
    expect(aborted).toBe(true)
    // Let the late yes arrive; it must change nothing.
    await new Promise((resolve) => setTimeout(resolve, 120))
    await expect(readFile(ledgerPath)).rejects.toThrow()
  })

  it('refuses when the approver fails or answers anything but true', async () => {
    const failing = guard({ approver: () => Promise.reject(new Error('client gone')) })
    expect(await refusal(failing.authorize(redeem('80')))).toBe('redemptionApprovalAbove')
    const vague = guard({ approver: async () => 'yes' as unknown as boolean })
    expect(await refusal(vague.authorize(redeem('80')))).toBe('redemptionApprovalAbove')
  })

  it('does not ask a human about a redemption the daily cap would refuse', async () => {
    let asked = false
    await guard().authorize(transfer('100'))
    const g = guard({
      approver: async () => {
        asked = true
        return true
      },
    })
    expect(await refusal(g.authorize(redeem('80')))).toBe('dailyCap')
    expect(asked).toBe(false)
  })
})
