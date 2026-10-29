/**
 * The MCP server end to end, through an MCP client: the tool list, refusals
 * that reach no API and sign nothing, and redemption approval by elicitation.
 * The chain helpers are mocked, so a call to them is a signature attempt.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpendPolicy } from '../src/agent/index.js'
import type { TgbpClient } from '../src/api/client.js'
import type { TgbpSwapClient } from '../src/api/swap.js'
import { createTgbpMcpServer, type TgbpMcpServerOptions } from '../src/mcp/index.js'
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
  mints: { create: vi.fn() },
  redemptions: {
    create: vi.fn(async (): Promise<unknown> => created()),
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
const swap = { createConversion: vi.fn(async () => ({ data: {}, idempotencyKey: 'k' })) }
const evm = vi.fn(() => ({
  publicClient: {},
  walletClient: { account: { address: AGENT } },
}))

let dir: string
let clients: Client[] = []

beforeEach(async () => {
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'tgbp-mcp-'))
})

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()))
  clients = []
  await rm(dir, { recursive: true, force: true })
})

type ElicitAnswer = 'approve' | 'decline' | 'never'

async function connect(
  options: { elicit?: ElicitAnswer; server?: Partial<TgbpMcpServerOptions> } = {},
) {
  const server = createTgbpMcpServer({
    policy: POLICY,
    ledgerPath: join(dir, 'ledger.jsonl'),
    api: api as unknown as TgbpClient,
    swap: swap as unknown as TgbpSwapClient,
    evm: evm as unknown as NonNullable<TgbpMcpServerOptions['evm']>,
    now: () => new Date('2026-10-21T12:00:00Z'),
    ...options.server,
  })
  const client = new Client(
    { name: 'test', version: '0' },
    { capabilities: options.elicit ? { elicitation: {} } : {} },
  )
  const answer = options.elicit
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
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
    expect(api.redemptions.create).toHaveBeenCalledWith({
      chain: 'sepolia',
      bankId: 'bank_ok',
      amount: { currency: 'GBP', value: 80 },
    })
    expect(chain.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ to: BURN, amount: 80_000_000_000_000_000_000n }),
    )
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
  const X402_POLICY: SpendPolicy = {
    ...POLICY,
    actions: [...POLICY.actions, 'x402'],
    chains: [...POLICY.chains, 'base-sepolia'],
    destinations: [...POLICY.destinations, PAY_TO],
  }

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

  const connectX402 = (policy: SpendPolicy = X402_POLICY) =>
    connect({
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
    const policy = { ...X402_POLICY, destinations: POLICY.destinations }
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
