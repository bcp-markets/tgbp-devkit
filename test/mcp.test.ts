/**
 * The MCP server end to end, through an MCP client: the tool list, refusals
 * that reach no API and sign nothing, and redemption approval by elicitation.
 * The chain helpers are mocked, so a call to them is a signature attempt.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { SpendPolicy } from '../src/agent/index.js'
import type { TgbpClient } from '../src/api/client.js'
import type { TgbpSwapClient } from '../src/api/swap.js'
import { TgbpKitError } from '../src/errors.js'
import {
  createTgbpMcpServer,
  TASKS_EXTENSION,
  TaskStore,
  type TgbpMcpServerOptions,
} from '../src/mcp/index.js'
import { TGBP_BASE_SEPOLIA, tgbpPaymentMiddleware, x402Network } from '../src/x402/server.js'
import { fakeFacilitator, SETTLE_HASH, serve } from './x402-fakes.js'

const chain = vi.hoisted(() => ({
  transfer: vi.fn(async () => ({ hash: '0xburn', receipt: {} })),
  getBalance: vi.fn(async () => ({ amount: 12_500_000_000_000_000_000n, decimals: 18 })),
}))
vi.mock('../src/evm/index.js', () => chain)

const AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const BURN = '0x000000000000000000000000000000000000dEaD'

const POLICY: SpendPolicy = {
  version: 1,
  expiresAt: '2026-12-31T23:59:59Z',
  actions: ['balance', 'transfer', 'mint', 'redeem', 'swap'],
  chains: ['sepolia'],
  destinations: [AGENT, 'bank_ok'],
  perTransferCap: '100',
  dailyCap: '500',
  redemptionApprovalAbove: '50',
}

const api = {
  mints: { create: vi.fn(async (_body?: unknown, _opts?: unknown): Promise<unknown> => minted()) },
  redemptions: {
    create: vi.fn(async (): Promise<unknown> => created()),
    get: vi.fn(async (): Promise<unknown> => ({ data: created().data })),
  },
}
function created(overrides: Record<string, unknown> = {}) {
  return {
    status: 'created',
    data: {
      redemptionId: 'red_1',
      status: 'pending',
      burnAddress: BURN,
      chain: 'sepolia',
      amount: { amount: '80.00', currency: 'GBP' },
      bankAccount: { id: 'bank_ok', name: 'Ops', type: 'gbp' },
      ...overrides,
    },
    idempotencyKey: 'key_1',
  }
}
function minted() {
  return { status: 'created', data: { mintId: 'mint_1', status: 'pending' }, idempotencyKey: 'k' }
}
const swap = { createConversion: vi.fn(async () => ({ data: {}, idempotencyKey: 'k' })) }
const evm = vi.fn(() => ({
  publicClient: {},
  walletClient: { account: { address: AGENT } },
}))

let dir: string
let clients: Client[] = []

beforeEach(async () => {
  vi.clearAllMocks()
  api.redemptions.create.mockImplementation(async () => created())
  dir = await mkdtemp(join(tmpdir(), 'tgbp-mcp-'))
})

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()))
  clients = []
  await rm(dir, { recursive: true, force: true })
})

type ElicitAnswer = 'approve' | 'decline' | 'never'

function createServer(options: Partial<TgbpMcpServerOptions> = {}) {
  return createTgbpMcpServer({
    policy: POLICY,
    ledgerPath: join(dir, 'ledger.jsonl'),
    api: api as unknown as TgbpClient,
    swap: swap as unknown as TgbpSwapClient,
    evm: evm as unknown as NonNullable<TgbpMcpServerOptions['evm']>,
    now: () => new Date('2026-10-21T12:00:00Z'),
    ...options,
  })
}

async function connect(
  options: { elicit?: ElicitAnswer; server?: Partial<TgbpMcpServerOptions> } = {},
) {
  const server = createServer(options.server)
  const client = new Client(
    { name: 'test', version: '0' },
    { capabilities: options.elicit ? { elicitation: {} } : {} },
  )
  const answer = options.elicit
  if (answer) {
    client.setRequestHandler('elicitation/create', async () => {
      if (answer === 'never') return new Promise(() => {})
      return answer === 'approve'
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' }
    })
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  clients.push(client)
  return client
}

/** A client pinned to protocol 2026-07-28, served over in-process HTTP as a remote host would serve it. */
async function connectModern(options: { elicit?: boolean } = {}) {
  const handler = createMcpHandler(() => createServer())
  const client = new Client(
    { name: 'test', version: '0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      capabilities: options.elicit ? { elicitation: {} } : {},
    },
  )
  if (options.elicit) {
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { approve: true },
    }))
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  )
  clients.push(client)
  return client
}

/** The tgbp-mcp entry point: serveStdio, here over an in-memory pipe in place of the process's stdio. */
async function connectStdio(options: { modern?: boolean } = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  serveStdio(() => createServer(), { transport: serverSide })
  const client = new Client(
    { name: 'test', version: '0' },
    {
      capabilities: { elicitation: {} },
      ...(options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' as const } } } : {}),
    },
  )
  client.setRequestHandler('elicitation/create', async () => ({
    action: 'accept',
    content: { approve: true },
  }))
  await client.connect(clientSide)
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const [first] = result.content as { type: string; text: string }[]
  return { isError: result.isError === true, body: JSON.parse(first?.text ?? 'null') }
}

/** Building a wallet client signs nothing; the chain helpers and the API are what count. */
function expectNothingSent() {
  expect(chain.transfer).not.toHaveBeenCalled()
  expect(chain.getBalance).not.toHaveBeenCalled()
  expect(api.mints.create).not.toHaveBeenCalled()
  expect(api.redemptions.create).not.toHaveBeenCalled()
  expect(swap.createConversion).not.toHaveBeenCalled()
}

describe('tgbp MCP server', () => {
  it('lists a tool for the policy, balance, transfer, mint, redeem, swap and x402', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'tgbp_balance',
      'tgbp_mint',
      'tgbp_policy',
      'tgbp_redeem',
      'tgbp_swap',
      'tgbp_transfer',
      'tgbp_x402_pay',
    ])
  })

  it('serves a client on protocol 2026-07-28 every tool', async () => {
    const client = await connectModern()
    expect(client.getProtocolEra()).toBe('modern')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'tgbp_balance',
      'tgbp_mint',
      'tgbp_policy',
      'tgbp_redeem',
      'tgbp_swap',
      'tgbp_transfer',
      'tgbp_x402_pay',
    ])
  })

  it('makes the client ask the human on every call to a tool that moves value', async () => {
    const { tools } = await (await connect()).listTools()
    const marked = tools
      .filter((t) => t._meta?.['anthropic/requiresUserInteraction'] === true)
      .map((t) => t.name)
      .sort()
    expect(marked).toEqual([
      'tgbp_mint',
      'tgbp_redeem',
      'tgbp_swap',
      'tgbp_transfer',
      'tgbp_x402_pay',
    ])
  })

  it('sends an allowed transfer', async () => {
    const { isError, body } = await call(await connect(), 'tgbp_transfer', {
      chain: 'sepolia',
      to: AGENT,
      amount: '25',
    })
    expect(isError).toBe(false)
    expect(body.hash).toBe('0xburn')
    expect(chain.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ to: AGENT, amount: 25_000_000_000_000_000_000n }),
    )
  })

  it('reads a balance as a decimal string', async () => {
    const { body } = await call(await connect(), 'tgbp_balance', { chain: 'sepolia' })
    expect(body).toEqual({ chain: 'sepolia', owner: AGENT, amount: '12.5' })
  })

  it.each([
    [
      'over-cap transfer',
      'tgbp_transfer',
      { chain: 'sepolia', to: AGENT, amount: '100.01' },
      'perTransferCap',
    ],
    [
      'non-allowlisted destination',
      'tgbp_mint',
      {
        chain: 'sepolia',
        destinationAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        amount: '10',
      },
      'destinations',
    ],
    [
      'disallowed chain',
      'tgbp_redeem',
      { chain: 'arbitrum-sepolia', bankId: 'bank_ok', amount: '10' },
      'chains',
    ],
    [
      'disallowed swap recipient',
      'tgbp_swap',
      { chain: 'sepolia', direction: 'TGBP_TO_USDC', amount: '10', recipient: BURN },
      'destinations',
    ],
  ])('refuses a %s before any signing or API call', async (_, tool, args, rule) => {
    const { isError, body } = await call(await connect(), tool, args)
    expect(isError).toBe(true)
    expect(body.code).toBe('SPEND_POLICY_DENIED')
    expect(body.details.rule).toBe(rule)
    expectNothingSent()
  })

  it('refuses every action on an expired policy before any signing or API call', async () => {
    const client = await connect({ server: { now: () => new Date('2027-01-01T00:00:00Z') } })
    const { body } = await call(client, 'tgbp_transfer', {
      chain: 'sepolia',
      to: AGENT,
      amount: '1',
    })
    expect(body.code).toBe('SPEND_POLICY_DENIED')
    expect(body.details.rule).toBe('expiresAt')
    expectNothingSent()
  })
})

describe('redemption over the approval threshold', () => {
  const redeem = { chain: 'sepolia', bankId: 'bank_ok', amount: '80' }

  it('is refused before any signing or API call when the client cannot ask a human', async () => {
    const { body } = await call(await connect(), 'tgbp_redeem', redeem)
    expect(body.code).toBe('SPEND_POLICY_DENIED')
    expect(body.details.rule).toBe('redemptionApprovalAbove')
    expectNothingSent()
  })

  it.each([
    ['cannot ask', false],
    ['can ask', true],
  ])(
    'is refused before any signing or API call on a 2026-07-28 connection whose client %s',
    async (_, elicit) => {
      const { body } = await call(await connectModern({ elicit }), 'tgbp_redeem', redeem)
      expect(body.code).toBe('SPEND_POLICY_DENIED')
      expect(body.details.rule).toBe('redemptionApprovalAbove')
      if (elicit) expect(body.details.approverError).toMatch(/cannot carry the question/)
      expectNothingSent()
    },
  )

  it('is refused when the human declines', async () => {
    const { body } = await call(await connect({ elicit: 'decline' }), 'tgbp_redeem', redeem)
    expect(body.details.rule).toBe('redemptionApprovalAbove')
    expectNothingSent()
  })

  it('is refused, never approved, when the human does not answer in time', async () => {
    const client = await connect({ elicit: 'never', server: { approvalTimeoutMs: 50 } })
    const { body } = await call(client, 'tgbp_redeem', redeem)
    expect(body.details.rule).toBe('redemptionApprovalAbove')
    expectNothingSent()
  })

  it('creates the redemption and burns to its burn address once the human approves', async () => {
    const { isError, body } = await call(
      await connect({ elicit: 'approve' }),
      'tgbp_redeem',
      redeem,
    )
    expect(isError).toBe(false)
    expect(body.burnHash).toBe('0xburn')
    expect(api.redemptions.create).toHaveBeenCalledWith(
      { chain: 'sepolia', bankId: 'bank_ok', amount: { currency: 'GBP', value: 80 } },
      { idempotencyKey: expect.any(String) },
    )
    expect(chain.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ to: BURN, amount: 80_000_000_000_000_000_000n }),
    )
  })

  it('asks the human over stdio on a 2025-era connection', async () => {
    const client = await connectStdio()
    expect(client.getProtocolEra()).toBe('legacy')
    const { isError, body } = await call(client, 'tgbp_redeem', redeem)
    expect(isError).toBe(false)
    expect(body.burnHash).toBe('0xburn')
  })

  it('is refused over stdio on a 2026-07-28 connection, and says why', async () => {
    const client = await connectStdio({ modern: true })
    expect(client.getProtocolEra()).toBe('modern')
    const { body } = await call(client, 'tgbp_redeem', redeem)
    expect(body.code).toBe('SPEND_POLICY_DENIED')
    expect(body.details.approverError).toMatch(/cannot carry the question/)
    expectNothingSent()
  })
})

describe('redemption checks after the API answers', () => {
  const redeem = { chain: 'sepolia', bankId: 'bank_ok', amount: '50' }

  it('burns nothing when the API needs a second approver', async () => {
    api.redemptions.create.mockResolvedValueOnce({
      status: 'pending_approval',
      approvalRequestId: 'apr_1',
      idempotencyKey: 'key_1',
    })
    const { isError, body } = await call(await connect(), 'tgbp_redeem', redeem)
    expect(isError).toBe(false)
    expect(body.redemption.status).toBe('pending_approval')
    expect(chain.transfer).not.toHaveBeenCalled()
  })

  it.each([
    ['amount', { amount: { amount: '5000.00', currency: 'GBP' } }],
    ['chain', { chain: 'base' }],
    ['bank', { bankAccount: { id: 'bank_other', name: 'x', type: 'gbp' } }],
    ['burn address', { burnAddress: 'not-an-address' }],
    ['status failed', { status: 'failed' }],
    ['bank', { bankAccount: null }],
  ])(
    'burns nothing when the redemption does not match the request (%s)',
    async (field, overrides) => {
      api.redemptions.create.mockResolvedValueOnce(
        created({ amount: { amount: '50.00', currency: 'GBP' }, ...overrides }),
      )
      const { isError, body } = await call(await connect(), 'tgbp_redeem', redeem)
      expect(isError).toBe(true)
      expect(body.message).toContain(`(${field})`)
      expect(chain.transfer).not.toHaveBeenCalled()
    },
  )

  it('names the redemption when its burn fails', async () => {
    api.redemptions.create.mockResolvedValueOnce(
      created({ amount: { amount: '50.00', currency: 'GBP' } }),
    )
    const { TgbpKitError } = await import('../src/errors.js')
    chain.transfer.mockRejectedValueOnce(new TgbpKitError('INSUFFICIENT_BALANCE', 'too little'))
    const { body } = await call(await connect(), 'tgbp_redeem', redeem)
    expect(body.code).toBe('INSUFFICIENT_BALANCE')
    expect(body.details.redemptionId).toBe('red_1')
    expect(body.message).toContain('nothing was burned')
  })

  it('never says nothing was burned when the burn may have been sent', async () => {
    api.redemptions.create.mockResolvedValueOnce(
      created({ amount: { amount: '50.00', currency: 'GBP' } }),
    )
    const { TgbpKitError } = await import('../src/errors.js')
    chain.transfer.mockRejectedValueOnce(
      new TgbpKitError('TRANSFER_UNCONFIRMED', 'not confirmed', { details: { hash: '0xabc' } }),
    )
    const { body } = await call(await connect(), 'tgbp_redeem', redeem)
    expect(body.details).toMatchObject({ redemptionId: 'red_1', hash: '0xabc' })
    expect(body.message).toContain('may have been sent')
    expect(body.message).not.toContain('nothing was burned')
  })
})

describe('swap and mint input', () => {
  it('refuses a chain the swap API does not serve before asking the policy', async () => {
    const { body } = await call(await connect(), 'tgbp_swap', {
      chain: 'arbitrum-sepolia',
      direction: 'TGBP_TO_USDC',
      amount: '10',
      recipient: AGENT,
    })
    expect(body.code).toBe('UNKNOWN_CHAIN')
    expectNothingSent()
  })

  it('sends the canonical amount and passes the idempotency key back to the API', async () => {
    await call(await connect(), 'tgbp_swap', {
      chain: 'sepolia',
      direction: 'TGBP_TO_USDC',
      amount: ' 010.50 ',
      recipient: AGENT,
      idempotencyKey: 'retry_1',
    })
    expect(swap.createConversion).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 'sepolia', tgbpAmount: '10.5' }),
      { idempotencyKey: 'retry_1' },
    )
  })
})

describe('tgbp_x402_pay', () => {
  const PAY_TO = '0x1111111111111111111111111111111111111111'
  /** Pays the local test service, an http endpoint on a random port. */
  const x402Policy = (): SpendPolicy => ({
    ...POLICY,
    actions: [...POLICY.actions, 'x402'],
    chains: [...POLICY.chains, 'base-sepolia'],
    destinations: [...POLICY.destinations, PAY_TO],
    x402: {
      services: [{ match: paid.url, category: 'quotes' }],
      categoryBudgets: { quotes: '1' },
      paymentsPerMinute: 10,
    },
  })

  let fake: ReturnType<typeof fakeFacilitator>
  let paid: Awaited<ReturnType<typeof serve>>
  const signTypedData = vi.fn(async () => `0x${'11'.repeat(65)}`)
  /** The wallet the tool pays from: every read passes, and a signature is a payment attempt. */
  const x402Evm = () => ({
    publicClient: {
      getChainId: async () => TGBP_BASE_SEPOLIA.chainId,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'paused' || functionName === 'isBanned') return false
        if (functionName === 'balanceOf') return 10n ** 18n
        return 0n
      }),
    },
    walletClient: { account: { address: AGENT, type: 'local' }, signTypedData },
  })

  beforeEach(async () => {
    fake = fakeFacilitator(x402Network(TGBP_BASE_SEPOLIA))
    const app = express()
    app.use(
      tgbpPaymentMiddleware({
        routes: {
          'GET /quote': { pence: 5, payTo: PAY_TO },
          'GET /big': { pence: 5, payTo: PAY_TO },
        },
        token: TGBP_BASE_SEPOLIA,
        facilitator: fake.facilitator,
      }),
    )
    app.get('/quote', (_req, res) => res.json({ quote: 'paid' }))
    app.get('/big', (_req, res) => res.type('text').send('x'.repeat(30_000)))
    app.get('/free', (_req, res) => res.json({ quote: 'free' }))
    paid = await serve(app)
  })

  afterEach(() => paid.close())

  /** The owner approves the first payment to the service unless `elicit` says otherwise. */
  const connectX402 = (policy: SpendPolicy = x402Policy(), elicit: ElicitAnswer = 'approve') =>
    connect({
      elicit,
      server: {
        policy,
        evm: x402Evm as unknown as NonNullable<TgbpMcpServerOptions['evm']>,
      },
    })

  const ledger = () => readFile(join(dir, 'ledger.jsonl'), 'utf8').catch(() => '')

  it('pays the URL and returns the service response with the settlement', async () => {
    const { isError, body } = await call(await connectX402(), 'tgbp_x402_pay', {
      url: `${paid.url}/quote`,
      maxPence: 5,
      reason: 'a quote for the user',
    })
    expect(isError).toBe(false)
    expect(body).toMatchObject({
      status: 200,
      body: JSON.stringify({ quote: 'paid' }),
      truncated: false,
      paid: { amount: '0.05', payTo: PAY_TO, transaction: SETTLE_HASH },
    })
    expect(fake.calls.settle).toHaveLength(1)
    const [entry] = (await ledger()).trim().split('\n')
    expect(JSON.parse(entry ?? '{}')).toMatchObject({
      action: 'x402',
      amount: '0.05',
      reason: 'a quote for the user',
    })
  })

  it('returns the first 20 kB of a large paid response, with the settlement', async () => {
    const { body } = await call(await connectX402(), 'tgbp_x402_pay', {
      url: `${paid.url}/big`,
      maxPence: 5,
      reason: 'a large answer',
    })
    expect(body.body).toHaveLength(20_000)
    expect(body.truncated).toBe(true)
    expect(body.paid.transaction).toBe(SETTLE_HASH)
  })

  it('returns only the status of a URL that does not ask for payment', async () => {
    const { isError, body } = await call(await connectX402(), 'tgbp_x402_pay', {
      url: `${paid.url}/free`,
      maxPence: 5,
      reason: 'a free answer',
    })
    expect(isError).toBe(false)
    expect(body).toEqual({
      url: `${paid.url}/free`,
      status: 200,
      paid: null,
      message: 'The URL did not ask for payment; nothing was paid.',
    })
    expect(signTypedData).not.toHaveBeenCalled()
    expect(await ledger()).toBe('')
  })

  it('returns the price with estimate: true and signs nothing', async () => {
    const { isError, body } = await call(await connectX402(), 'tgbp_x402_pay', {
      url: `${paid.url}/quote`,
      maxPence: 4,
      estimate: true,
    })
    expect(isError).toBe(false)
    expect(body).toEqual({
      estimate: true,
      free: false,
      url: `${paid.url}/quote`,
      amount: '0.05',
      payTo: PAY_TO,
      network: x402Network(TGBP_BASE_SEPOLIA),
      maxPence: 4,
      withinMax: false,
    })
    expect(signTypedData).not.toHaveBeenCalled()
    expect(fake.calls.verify).toHaveLength(0)
    expect(await ledger()).toBe('')
  })

  it('says a route is free with estimate: true', async () => {
    const { body } = await call(await connectX402(), 'tgbp_x402_pay', {
      url: `${paid.url}/free`,
      maxPence: 5,
      estimate: true,
    })
    expect(body).toMatchObject({ estimate: true, free: true, status: 200 })
  })

  it('refuses a price above maxPence without signing', async () => {
    const { isError, body } = await call(await connectX402(), 'tgbp_x402_pay', {
      url: `${paid.url}/quote`,
      maxPence: 4,
      reason: 'a quote for the user',
    })
    expect(isError).toBe(true)
    expect(body.code).toBe('PAYMENT_OVER_LIMIT')
    expect(signTypedData).not.toHaveBeenCalled()
    expect(await ledger()).toBe('')
  })

  it('returns the spend guard refusal and signs nothing', async () => {
    const policy = { ...x402Policy(), destinations: POLICY.destinations }
    const { isError, body } = await call(await connectX402(policy), 'tgbp_x402_pay', {
      url: `${paid.url}/quote`,
      maxPence: 5,
      reason: 'a quote for the user',
    })
    expect(isError).toBe(true)
    expect(body.code).toBe('SPEND_POLICY_DENIED')
    expect(body.details.rule).toBe('destinations')
    expect(body.message).toContain(PAY_TO)
    expect(signTypedData).not.toHaveBeenCalled()
    expect(fake.calls.verify).toHaveLength(0)
  })

  it.each([
    ['the human says no', 'decline' as const],
    ['the client cannot ask', undefined],
    ['nobody answers in time', 'never' as const],
  ])('refuses the first payment to a service when %s, and signs nothing', async (_, elicit) => {
    const client = await connect({
      ...(elicit ? { elicit } : {}),
      server: {
        policy: x402Policy(),
        approvalTimeoutMs: 50,
        evm: x402Evm as unknown as NonNullable<TgbpMcpServerOptions['evm']>,
      },
    })
    const { isError, body } = await call(client, 'tgbp_x402_pay', {
      url: `${paid.url}/quote`,
      maxPence: 5,
      reason: 'a quote for the user',
    })
    expect(isError).toBe(true)
    expect(body.details.rule).toBe('firstPayment')
    expect(body.message).toContain('approval required')
    expect(signTypedData).not.toHaveBeenCalled()
    expect(await ledger()).toBe('')
  })

  it('asks only before the first payment to a service', async () => {
    const quote = { url: `${paid.url}/quote`, maxPence: 5, reason: 'a quote for the user' }
    expect((await call(await connectX402(), 'tgbp_x402_pay', quote)).isError).toBe(false)
    // A client that would say no is never asked: the service is approved.
    const declining = await connectX402(x402Policy(), 'decline')
    expect((await call(declining, 'tgbp_x402_pay', quote)).isError).toBe(false)
    const [first, second] = (await ledger())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(first).toMatchObject({ firstPayment: true, category: 'quotes' })
    expect(second.firstPayment).toBeUndefined()
  })

  it('refuses a URL on no listed service, and signs nothing', async () => {
    const policy = x402Policy()
    const x402 = { ...policy.x402, services: [{ match: 'quotes.example.com', category: 'quotes' }] }
    const { body } = await call(
      await connectX402({ ...policy, x402 } as SpendPolicy),
      'tgbp_x402_pay',
      { url: `${paid.url}/quote`, maxPence: 5, reason: 'a quote for the user' },
    )
    expect(body.details.rule).toBe('services')
    expect(signTypedData).not.toHaveBeenCalled()
  })

  it('refuses a payment with no reason before any request', async () => {
    const { isError, body } = await call(await connectX402(), 'tgbp_x402_pay', {
      url: `${paid.url}/quote`,
      maxPence: 5,
    })
    expect(isError).toBe(true)
    expect(body.message).toMatch(/reason/)
    expect(signTypedData).not.toHaveBeenCalled()
  })

  it('refuses a URL that is not http or https', async () => {
    const client = await connectX402()
    const result = await client.callTool({
      name: 'tgbp_x402_pay',
      arguments: { url: 'file:///etc/passwd', maxPence: 5, estimate: true },
    })
    expect(result.isError).toBe(true)
  })
})

/**
 * A 2026-07-28 client that declares the tasks extension. The SDK client
 * refuses a `tools/call` answered with a task, so the test reads the raw
 * responses the server sent.
 */
async function connectTasks(options: { tasks?: boolean } = {}) {
  const store = new TaskStore()
  const handler = createMcpHandler(() => createServer({ taskStore: store }))
  const responses: unknown[] = []
  const client = new Client(
    { name: 'test', version: '0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      capabilities: {
        elicitation: {},
        ...(options.tasks === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } }),
      },
    },
  )
  client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' }))
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: async (url, init) => {
        const res = await handler.fetch(new Request(url, init))
        responses.push(...parseMessages(await res.clone().text()))
        return res
      },
    }),
  )
  clients.push(client)
  return { client, responses }
}

/** A response body is one JSON-RPC message, or a stream of `data:` lines. */
function parseMessages(text: string): unknown[] {
  if (text.trim() === '') return []
  if (text.trimStart().startsWith('{')) return [JSON.parse(text)]
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data.startsWith('{'))
    .map((data) => JSON.parse(data))
}

const TaskSchema = z.looseObject({
  taskId: z.string(),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  result: z.looseObject({ content: z.array(z.looseObject({ text: z.string() })) }).optional(),
  error: z.looseObject({ code: z.number(), message: z.string(), data: z.any() }).optional(),
})

/** Calls a tool that answers with a task, then polls the task until it finishes. */
async function callTask(
  { client, responses }: Awaited<ReturnType<typeof connectTasks>>,
  name: string,
  args: Record<string, unknown>,
) {
  await expect(client.callTool({ name, arguments: args })).rejects.toThrow()
  const handle = responses
    .map((message) => (message as { result?: Record<string, unknown> }).result)
    .find((result) => result?.resultType === 'task')
  expect(handle).toMatchObject({ status: 'working', ttlMs: expect.any(Number) })
  const taskId = String(handle?.taskId)
  return vi.waitFor(async () => {
    const task = await client.request({ method: 'tasks/get', params: { taskId } }, TaskSchema)
    if (task.status === 'working') throw new Error('still working')
    return task
  })
}

describe('tasks on a 2026-07-28 connection', () => {
  const tools: [string, Record<string, unknown>, () => unknown][] = [
    [
      'tgbp_mint',
      { chain: 'sepolia', destinationAddress: AGENT, amount: '10' },
      () => api.mints.create,
    ],
    [
      'tgbp_redeem',
      { chain: 'sepolia', bankId: 'bank_ok', amount: '50' },
      () => api.redemptions.create,
    ],
    [
      'tgbp_swap',
      { chain: 'sepolia', direction: 'TGBP_TO_USDC', amount: '10', recipient: AGENT },
      () => swap.createConversion,
    ],
  ]

  it.each(tools)('returns a task from %s that completes with the result', async (name, args) => {
    api.redemptions.create.mockImplementation(async () =>
      created({ amount: { amount: '50.00', currency: 'GBP' } }),
    )
    const task = await callTask(await connectTasks(), name, args)
    expect(task.status).toBe('completed')
    // The same payload a client without tasks gets on the call itself.
    const blocking = await call(await connect(), name, args)
    expect(JSON.parse(task.result?.content[0]?.text ?? 'null')).toEqual(blocking.body)
  })

  it('answers on the call itself when the client does not declare tasks', async () => {
    const { client, responses } = await connectTasks({ tasks: false })
    const { isError, body } = await call(client, 'tgbp_mint', {
      chain: 'sepolia',
      destinationAddress: AGENT,
      amount: '10',
    })
    expect(isError).toBe(false)
    expect(body.data.mintId).toBe('mint_1')
    expect(JSON.stringify(responses)).not.toContain('"resultType":"task"')
  })

  it('fails a task with the API reference and the idempotency key', async () => {
    api.mints.create.mockImplementationOnce(async (_body: unknown, opts: unknown) => {
      const { idempotencyKey } = opts as { idempotencyKey: string }
      throw new TgbpKitError('API_ERROR', 'POST /api/v1/mints returned 502', {
        details: { status: 502, requestId: 'req_123', idempotencyKey },
      })
    })
    const task = await callTask(await connectTasks(), 'tgbp_mint', {
      chain: 'sepolia',
      destinationAddress: AGENT,
      amount: '10',
    })
    const [, opts] = api.mints.create.mock.calls[0] as unknown as [
      unknown,
      { idempotencyKey: string },
    ]
    expect(task.status).toBe('failed')
    expect(task.error?.data).toMatchObject({
      code: 'API_ERROR',
      details: { requestId: 'req_123' },
      idempotencyKey: opts.idempotencyKey,
    })
  })

  it('settles approval before any task starts, and sends nothing without it', async () => {
    const { client, responses } = await connectTasks()
    const { body } = await call(client, 'tgbp_redeem', {
      chain: 'sepolia',
      bankId: 'bank_ok',
      amount: '80',
    })
    expect(body.code).toBe('SPEND_POLICY_DENIED')
    expect(body.details.rule).toBe('redemptionApprovalAbove')
    expect(JSON.stringify(responses)).not.toContain('"resultType":"task"')
    expectNothingSent()
  })

  it('refuses to cancel a submitted task', async () => {
    let answer = (_value: unknown) => {}
    api.mints.create.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const tasks = await connectTasks()
    await expect(
      tasks.client.callTool({
        name: 'tgbp_mint',
        arguments: { chain: 'sepolia', destinationAddress: AGENT, amount: '10' },
      }),
    ).rejects.toThrow()
    const handle = tasks.responses
      .map((message) => (message as { result?: Record<string, unknown> }).result)
      .find((result) => result?.resultType === 'task')
    await expect(
      tasks.client.request(
        { method: 'tasks/cancel', params: { taskId: String(handle?.taskId) } },
        z.looseObject({}),
      ),
    ).rejects.toThrow(/cannot be cancelled/)
    answer(minted())
  })
})

describe('a retry after the server dies mid-call', () => {
  /** Starts a call whose upstream request never answers, then closes the connection. */
  async function dieDuring(name: string, args: Record<string, unknown>, upstream: () => void) {
    const client = await connect({ elicit: 'approve' })
    const pending = client.callTool({ name, arguments: args }).catch(() => undefined)
    await vi.waitFor(upstream)
    await client.close()
    await pending
  }

  it.each([
    [
      'tgbp_mint',
      { chain: 'sepolia', destinationAddress: AGENT, amount: '10' },
      api.mints.create,
      minted,
    ],
    [
      'tgbp_swap',
      { chain: 'sepolia', direction: 'TGBP_TO_USDC', amount: '10', recipient: AGENT },
      swap.createConversion,
      () => ({ data: {}, idempotencyKey: 'k' }),
    ],
    [
      'tgbp_redeem',
      { chain: 'sepolia', bankId: 'bank_ok', amount: '50' },
      api.redemptions.create,
      () => created({ amount: { amount: '50.00', currency: 'GBP' } }),
    ],
  ] as const)(
    'resends the saved key for %s, so the API submits it once',
    async (name, args, create, answer) => {
      // The API: a key it has seen returns the first record instead of a second.
      const submitted = new Set<string>()
      const mock = create as unknown as ReturnType<typeof vi.fn>
      mock
        .mockImplementationOnce(async (_body: unknown, opts: { idempotencyKey: string }) => {
          submitted.add(opts.idempotencyKey)
          return new Promise(() => {})
        })
        .mockImplementationOnce(async (_body: unknown, opts: { idempotencyKey: string }) => {
          submitted.add(opts.idempotencyKey)
          return answer()
        })
      await dieDuring(name, args, () => expect(mock).toHaveBeenCalledTimes(1))

      const { isError } = await call(await connect({ elicit: 'approve' }), name, args)
      expect(isError).toBe(false)
      const keys = mock.mock.calls.map(
        ([, opts]) => (opts as { idempotencyKey: string }).idempotencyKey,
      )
      expect(keys).toHaveLength(2)
      expect(keys[1]).toBe(keys[0])
      expect(submitted.size).toBe(1)
    },
  )

  it('never burns a second time when it died during the burn', async () => {
    const redeem = { chain: 'sepolia', bankId: 'bank_ok', amount: '50' }
    api.redemptions.create.mockResolvedValueOnce(
      created({ amount: { amount: '50.00', currency: 'GBP' } }),
    )
    chain.transfer.mockReturnValueOnce(new Promise(() => {}))
    await dieDuring('tgbp_redeem', redeem, () => expect(chain.transfer).toHaveBeenCalledTimes(1))

    const { isError, body } = await call(await connect(), 'tgbp_redeem', redeem)
    expect(isError).toBe(true)
    expect(body.message).toMatch(/red_1 .*burn may have been sent/)
    expect(chain.transfer).toHaveBeenCalledTimes(1)
    expect(api.redemptions.create).toHaveBeenCalledTimes(1)
  })

  it('burns nothing for a replayed redemption that is no longer pending', async () => {
    api.redemptions.create.mockResolvedValueOnce({
      ...created({ amount: { amount: '50.00', currency: 'GBP' } }),
      status: 'replayed',
    })
    api.redemptions.get.mockResolvedValueOnce({
      data: created({ amount: { amount: '50.00', currency: 'GBP' }, status: 'cancelled' }).data,
    })
    const { isError, body } = await call(await connect(), 'tgbp_redeem', {
      chain: 'sepolia',
      bankId: 'bank_ok',
      amount: '50',
    })
    expect(isError).toBe(true)
    expect(body.message).toContain('(status cancelled)')
    expect(api.redemptions.get).toHaveBeenCalledWith('red_1')
    expect(chain.transfer).not.toHaveBeenCalled()
  })

  it('sends a new key after the API refused the first request', async () => {
    api.mints.create.mockRejectedValueOnce(
      new TgbpKitError('API_ERROR', 'POST /api/v1/mints returned 422', {
        details: { status: 422, requestId: 'req_1' },
      }),
    )
    const args = { chain: 'sepolia', destinationAddress: AGENT, amount: '10' }
    const client = await connect()
    expect((await call(client, 'tgbp_mint', args)).isError).toBe(true)
    expect((await call(client, 'tgbp_mint', args)).isError).toBe(false)
    const keys = api.mints.create.mock.calls.map(
      (callArgs) =>
        (callArgs as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey,
    )
    expect(new Set(keys).size).toBe(2)
  })

  it('starts a new submission with a new key once the first one answered', async () => {
    const args = { chain: 'sepolia', destinationAddress: AGENT, amount: '10' }
    const client = await connect()
    await call(client, 'tgbp_mint', args)
    await call(client, 'tgbp_mint', args)
    const keys = api.mints.create.mock.calls.map(
      (callArgs) =>
        (callArgs as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey,
    )
    expect(new Set(keys).size).toBe(2)
  })
})
