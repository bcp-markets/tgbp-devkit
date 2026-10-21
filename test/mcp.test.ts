/**
 * The MCP server end to end, through an MCP client: the tool list, refusals
 * that reach no API and sign nothing, and redemption approval by elicitation.
 * The chain helpers are mocked, so a call to them is a signature attempt.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpendPolicy } from '../src/agent/index.js'
import type { TgbpClient } from '../src/api/client.js'
import type { TgbpSwapClient } from '../src/api/swap.js'
import { createTgbpMcpServer, type TgbpMcpServerOptions } from '../src/mcp/index.js'

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
    create: vi.fn(async () => ({
      status: 'created',
      data: { redemptionId: 'red_1', burnAddress: BURN },
      idempotencyKey: 'key_1',
    })),
  },
}
const swap = { createConversion: vi.fn() }
const evm = vi.fn(() => ({
  publicClient: {},
  walletClient: { account: { address: AGENT } },
}))

let dir: string

beforeEach(async () => {
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'tgbp-mcp-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

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
  it('lists a tool for the policy, balance, transfer, mint, redeem and swap', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'tgbp_balance',
      'tgbp_mint',
      'tgbp_policy',
      'tgbp_redeem',
      'tgbp_swap',
      'tgbp_transfer',
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
