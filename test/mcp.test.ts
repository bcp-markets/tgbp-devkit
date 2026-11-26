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
import { SKILLS_EXTENSION_ID, SkillsClient } from '@modelcontextprotocol/client/ext/skills'
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
import { SKILL_FILES } from '../src/mcp/skills.generated.js'
import { TGBP_BASE_SEPOLIA, tgbpPaymentMiddleware, x402Network } from '../src/x402/server.js'
import { fakeFacilitator, SETTLE_HASH, serve } from './x402-fakes.js'

const chain = vi.hoisted(() => ({
  transfer: vi.fn(async () => ({ hash: '0xburn', receipt: {} })),
  getBalance: vi.fn(async () => ({ amount: 12_500_000_000_000_000_000n, decimals: 18 })),
}))
vi.mock('../src/evm/index.js', () => chain)
/** The x402 wallet's signer: a signature is a payment attempt. */
const signTypedData = vi.fn(async () => `0x${'11'.repeat(65)}`)

const AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const BURN = '0x000000000000000000000000000000000000dEaD'
const DEPOSIT = '0x2222222222222222222222222222222222222222'

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
/**
 * The swap API's dedupe: an intent's id returns that intent, and each intent
 * converts at most once. `converted` holds the intents that have a conversion.
 */
const intents = new Map<string, Record<string, unknown>>()
const converted = new Set<string>()
type IntentBody = { id: string } & Record<string, unknown>
/** The intent the swap API returns for `body`: the request's details and a firm quote. */
function intent(body: IntentBody, overrides: Record<string, unknown> = {}) {
  const { destinationChainId: _, ...details } = body
  return {
    ...details,
    status: 'active',
    targetAmount: '12.5',
    targetRawAmount: '12500000',
    fillBy: '2999-01-01T00:00:00Z',
    ...overrides,
  }
}
const swap = {
  createSwapIntent: vi.fn(async (body: IntentBody) => {
    const found = intents.get(body.id) ?? intent(body)
    intents.set(body.id, found)
    return { data: found, idempotencyKey: body.id }
  }),
  cancelSwapIntent: vi.fn(async (id: string) => {
    // The swap API withdraws an intent it cancels.
    intents.set(id, { ...intents.get(id), status: 'withdrawn' })
    return { data: intents.get(id) }
  }),
  getDepositSession: vi.fn(async () => ({ data: { depositAddress: DEPOSIT } })),
  createConversion: vi.fn(async (body: { intentId: string }, _opts?: unknown): Promise<unknown> => {
    converted.add(body.intentId)
    return { data: { id: 'conv_1', status: 'sweep_pending' }, idempotencyKey: 'k' }
  }),
}
const evm = vi.fn(() => ({
  publicClient: {},
  walletClient: { account: { address: AGENT } },
}))

let dir: string
let clients: Client[] = []

beforeEach(async () => {
  vi.clearAllMocks()
  api.redemptions.create.mockImplementation(async () => created())
  intents.clear()
  converted.clear()
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

/** How a 2026-07-28 test client's human answers an approval question. */
type ModernAnswer = 'approve' | 'decline' | 'cancel'

/** What the server had done when the human was asked: nothing may be sent, signed or recorded yet. */
interface AskedAt {
  message: string
  apiCalls: number
  transfers: number
  signatures: number
  ledger: string
}

/**
 * Answers the server's approval questions, and notes what it had done by
 * each one, in `asked`.
 */
function answering(client: Client, answer: ModernAnswer, asked: AskedAt[]) {
  client.setRequestHandler('elicitation/create', async (request) => {
    asked.push({
      message: String((request.params as { message?: unknown }).message),
      apiCalls: api.redemptions.create.mock.calls.length + api.mints.create.mock.calls.length,
      transfers: chain.transfer.mock.calls.length,
      signatures: signTypedData.mock.calls.length,
      ledger: await readFile(join(dir, 'ledger.jsonl'), 'utf8').catch(() => ''),
    })
    if (answer === 'approve') return { action: 'accept', content: { approve: true } }
    return { action: answer }
  })
}

/** A client pinned to protocol 2026-07-28, served over in-process HTTP as a remote host would serve it. */
async function connectModern(
  options: { answer?: ModernAnswer; server?: Partial<TgbpMcpServerOptions> } = {},
) {
  const handler = createMcpHandler(() => createServer(options.server))
  const responses: unknown[] = []
  const asked: AskedAt[] = []
  const client = new Client(
    { name: 'test', version: '0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      capabilities: options.answer ? { elicitation: {} } : {},
    },
  )
  if (options.answer) answering(client, options.answer, asked)
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
  return Object.assign(client, { responses, asked })
}

/** The tgbp-mcp entry point: serveStdio, here over an in-memory pipe in place of the process's stdio. */
async function connectStdio(options: { modern?: boolean; answer?: ModernAnswer } = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  serveStdio(() => createServer(), { transport: serverSide })
  const asked: AskedAt[] = []
  const client = new Client(
    { name: 'test', version: '0' },
    {
      capabilities: { elicitation: {} },
      ...(options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' as const } } } : {}),
    },
  )
  answering(client, options.answer ?? 'approve', asked)
  await client.connect(clientSide)
  clients.push(client)
  return Object.assign(client, { asked })
}

/** One `tgbp_redeem` round by hand; with `requestState`, it answers yes to the approval question. */
async function round(
  client: Client,
  args: Record<string, unknown>,
  requestState?: string,
  answer: unknown = { action: 'accept', content: { approve: true } },
  name = 'tgbp_redeem',
) {
  const params = {
    name,
    arguments: args,
    ...(requestState === undefined
      ? {}
      : {
          requestState,
          inputResponses: { approval: answer },
        }),
  }
  // The SDK types no inputResponses on callTool; the manual multi-round path still sends them.
  const result = await client.callTool(params as Parameters<Client['callTool']>[0], {
    allowInputRequired: true,
  })
  return result as typeof result & { resultType?: string; requestState?: string }
}

/** A tool result's JSON body. */
function textOf(result: { content?: unknown }) {
  const [first] = (result.content ?? []) as { text: string }[]
  return { body: JSON.parse(first?.text ?? 'null') }
}

/** The `input_required` results the server sent. */
function inputRequiredResults(responses: unknown[]) {
  return responses
    .map((message) => (message as { result?: Record<string, unknown> }).result)
    .filter((result) => result?.resultType === 'input_required')
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
  expect(swap.createSwapIntent).not.toHaveBeenCalled()
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

describe('agent skills', () => {
  const INTEGRATION = 'skill://tgbp-build-integration/SKILL.md'

  it('declares the skills extension and lists the integration skill', async () => {
    const client = await connect()
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(SKILLS_EXTENSION_ID)
    const { skills, invalid } = await new SkillsClient(client).list()
    expect(invalid).toEqual([])
    expect(skills.map((skill) => [skill.uri, skill.frontmatter.name])).toEqual([
      [INTEGRATION, 'tgbp-build-integration'],
    ])
  })

  it.each([
    ['2025-11-25', connect],
    ['2026-07-28', connectModern],
  ])(
    'serves the integration skill identical to the vendored file on protocol %s',
    async (_, open) => {
      const skills = new SkillsClient(await open())
      const { skill } = await skills.get(INTEGRATION)
      const file = await skills.read(skill)
      expect(file.verified).toBe(true)
      expect(file.text).toBe(SKILL_FILES['tgbp-build-integration/SKILL.md'])
    },
  )

  it('reads no file outside the served skills', async () => {
    const client = await connect()
    for (const uri of ['skill://constructor', 'skill://tgbp-build-integration/README.md']) {
      await expect(client.readResource({ uri })).rejects.toThrow(/not found/i)
    }
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

  it('is refused before any signing or API call on a 2026-07-28 connection whose client cannot ask', async () => {
    const client = await connectModern()
    const { body } = await call(client, 'tgbp_redeem', redeem)
    expect(body.code).toBe('SPEND_POLICY_DENIED')
    expect(body.details.rule).toBe('redemptionApprovalAbove')
    expect(body.details.approverError).toMatch(/does not declare elicitation/)
    expect(inputRequiredResults(client.responses)).toEqual([])
    expectNothingSent()
  })

  it('asks through input_required on a 2026-07-28 connection, and redeems once the human approves', async () => {
    const client = await connectModern({ answer: 'approve' })
    const { isError, body } = await call(client, 'tgbp_redeem', redeem)
    expect(isError).toBe(false)
    expect(body.burnHash).toBe('0xburn')
    const [question] = inputRequiredResults(client.responses)
    expect(question).toMatchObject({
      inputRequests: { approval: { method: 'elicitation/create' } },
      requestState: expect.any(String),
    })
    // Asked once, before anything was sent, burned or recorded.
    expect(client.asked).toEqual([
      {
        message: expect.stringContaining('redeem 80 tGBP'),
        apiCalls: 0,
        transfers: 0,
        signatures: 0,
        ledger: '',
      },
    ])
    expect(api.redemptions.create).toHaveBeenCalledTimes(1)
    expect(chain.transfer).toHaveBeenCalledTimes(1)
    expect((await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it.each(['decline', 'cancel'] as const)(
    'is refused on a 2026-07-28 connection when the human answers %s',
    async (answer) => {
      const client = await connectModern({ answer })
      const { body } = await call(client, 'tgbp_redeem', redeem)
      expect(body.code).toBe('SPEND_POLICY_DENIED')
      expect(body.details.rule).toBe('redemptionApprovalAbove')
      expect(client.asked).toHaveLength(1)
      expectNothingSent()
      expect(await readFile(join(dir, 'ledger.jsonl'), 'utf8').catch(() => '')).toBe('')
    },
  )

  it('counts an approval once: the same answer sent again asks again', async () => {
    const client = await connectModern({ answer: 'approve' })
    const first = await round(client, redeem)
    expect(first.resultType).toBe('input_required')
    const approved = await round(client, redeem, first.requestState)
    expect(approved.isError).toBeFalsy()
    const replayed = await round(client, redeem, first.requestState)
    expect(replayed.resultType).toBe('input_required')
    expect(api.redemptions.create).toHaveBeenCalledTimes(1)
  })

  it('asks again when the answer was to a different redemption', async () => {
    const client = await connectModern({ answer: 'approve' })
    const first = await round(client, { ...redeem, amount: '60' })
    const other = await round(client, redeem, first.requestState)
    expect(other.resultType).toBe('input_required')
    expectNothingSent()
  })

  it('refuses an answer to a question this server never asked', async () => {
    const client = await connectModern({ answer: 'approve' })
    const { body } = textOf(await round(client, redeem, 'forged'))
    expect(body.details.rule).toBe('redemptionApprovalAbove')
    expect(body.details.approverError).toMatch(/not to a question this server asked/)
    expectNothingSent()
  })

  it('refuses a malformed answer as a broken client, never as a no, and keeps the question open', async () => {
    const client = await connectModern({ answer: 'approve' })
    const first = await round(client, redeem)
    const broken = textOf(await round(client, redeem, first.requestState, { action: 'accept' }))
    expect(broken.body.details.approverError).toMatch(/something other than the approval form/)
    expectNothingSent()
    // The broken answer did not use the question up: a real answer to it still counts.
    const approved = await round(client, redeem, first.requestState)
    expect(approved.isError).toBeFalsy()
    expect(api.redemptions.create).toHaveBeenCalledTimes(1)
  })

  it('refuses an answer sent without its requestState', async () => {
    const client = await connectModern({ answer: 'approve' })
    const params = {
      name: 'tgbp_redeem',
      arguments: redeem,
      inputResponses: { approval: { action: 'accept', content: { approve: true } } },
    }
    const result = await client.callTool(params as Parameters<Client['callTool']>[0], {
      allowInputRequired: true,
    })
    expect(textOf(result).body.details.approverError).toMatch(/without its question's requestState/)
    expectNothingSent()
  })

  it('refuses an answer that comes back after the approval timeout', async () => {
    const client = await connectModern({ answer: 'approve', server: { approvalTimeoutMs: 1000 } })
    const first = await round(client, redeem)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5_000 })
    try {
      const { body } = textOf(await round(client, redeem, first.requestState))
      expect(body.details.approverError).toMatch(/^no answer before the timeout/)
    } finally {
      vi.useRealTimers()
    }
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

  it('asks over stdio on a 2026-07-28 connection, and redeems once the human approves', async () => {
    const client = await connectStdio({ modern: true })
    expect(client.getProtocolEra()).toBe('modern')
    const { isError, body } = await call(client, 'tgbp_redeem', redeem)
    expect(isError).toBe(false)
    expect(body.burnHash).toBe('0xburn')
    expect(client.asked).toEqual([
      {
        message: expect.stringContaining('redeem 80 tGBP'),
        apiCalls: 0,
        transfers: 0,
        signatures: 0,
        ledger: '',
      },
    ])
  })

  it('keeps two calls apart on one 2026-07-28 stdio connection: each asks, each redeems once', async () => {
    const client = await connectStdio({ modern: true })
    const results = await Promise.all([
      call(client, 'tgbp_redeem', { ...redeem, reference: 'first' }),
      call(client, 'tgbp_redeem', { ...redeem, reference: 'second' }),
    ])
    expect(results.map((r) => r.isError)).toEqual([false, false])
    expect(client.asked).toHaveLength(2)
    expect(api.redemptions.create).toHaveBeenCalledTimes(2)
    expect(chain.transfer).toHaveBeenCalledTimes(2)
    expect((await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it.each(['decline', 'cancel'] as const)(
    'is refused over stdio on a 2026-07-28 connection when the human answers %s',
    async (answer) => {
      const client = await connectStdio({ modern: true, answer })
      const { body } = await call(client, 'tgbp_redeem', redeem)
      expect(body.details.rule).toBe('redemptionApprovalAbove')
      expect(client.asked).toHaveLength(1)
      expectNothingSent()
      expect(await readFile(join(dir, 'ledger.jsonl'), 'utf8').catch(() => '')).toBe('')
    },
  )
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

  it('registers the swap intent under the key, then converts that intent', async () => {
    const { isError, body } = await call(await connect(), 'tgbp_swap', {
      chain: 'sepolia',
      direction: 'TGBP_TO_USDC',
      amount: ' 010.50 ',
      recipient: AGENT,
      idempotencyKey: 'retry_1',
    })
    expect(isError).toBe(false)
    expect(swap.createSwapIntent).toHaveBeenCalledWith({
      id: 'retry_1',
      chainId: 'sepolia',
      destinationChainId: 'sepolia',
      direction: 'TGBP_TO_USDC',
      recipientAddress: AGENT,
      sourceRawAmount: '10500000000000000000',
    })
    expect(swap.createConversion).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 'sepolia', intentId: 'retry_1', tgbpAmount: '10.5' }),
      { idempotencyKey: 'retry_1' },
    )
    expect(body).toMatchObject({ intentId: 'retry_1', idempotencyKey: 'retry_1' })
  })

  it('refuses a key too short to be a swap intent id before asking the policy', async () => {
    const { isError } = await call(await connect(), 'tgbp_swap', {
      chain: 'sepolia',
      direction: 'TGBP_TO_USDC',
      amount: '10',
      recipient: AGENT,
      idempotencyKey: 'abc',
    })
    expect(isError).toBe(true)
    expectNothingSent()
  })
})

describe('swap intents', () => {
  const args = { chain: 'sepolia', direction: 'TGBP_TO_USDC', amount: '10', recipient: AGENT }
  const intentIds = () => swap.createSwapIntent.mock.calls.map(([body]) => body.id)

  it('says how to fund an intent no deposit fills yet, and converts that intent on the retry', async () => {
    swap.createConversion.mockRejectedValueOnce(
      new TgbpKitError('API_ERROR', 'POST /api/conversions failed with 409', {
        details: { status: 409, apiCode: 'confirmed_deposit_required' },
      }),
    )
    const client = await connect()
    const first = await call(client, 'tgbp_swap', args)
    expect(first.isError).toBe(true)
    expect(first.body.message).toContain(
      `Send exactly 10 tGBP from ${AGENT} to the swap deposit address ${DEPOSIT}, mined before 2999-01-01T00:00:00Z`,
    )
    const [id] = intentIds()
    expect(first.body.message).toContain(`idempotencyKey ${id}`)
    expect(first.body.details).toMatchObject({
      intentId: id,
      apiCode: 'confirmed_deposit_required',
    })

    expect((await call(client, 'tgbp_swap', args)).isError).toBe(false)
    expect(intentIds()).toEqual([id, id])
    expect([...converted]).toEqual([id])
  })

  it('tells a resumed swap to wait for a deposit already sent, never to send a second', async () => {
    const noDeposit = () =>
      new TgbpKitError('API_ERROR', 'POST /api/conversions failed with 409', {
        details: { status: 409, apiCode: 'confirmed_deposit_required' },
      })
    swap.createConversion.mockRejectedValueOnce(noDeposit()).mockRejectedValueOnce(noDeposit())
    const client = await connect()
    await call(client, 'tgbp_swap', args)
    const { body } = await call(client, 'tgbp_swap', args)
    expect(body.message).toContain('If its deposit was already sent, send nothing more')
    expect(new Set(intentIds()).size).toBe(1)
  })

  it('cancels an intent whose firm quote pays less than minOut, and converts nothing', async () => {
    const client = await connect()
    const { isError, body } = await call(client, 'tgbp_swap', { ...args, minOut: '12.6' })
    expect(isError).toBe(true)
    expect(body.message).toContain('pays 12.5, less than minOut 12.6; nothing was converted')
    const [id] = intentIds()
    expect(swap.cancelSwapIntent).toHaveBeenCalledWith(id)
    expect(swap.createConversion).not.toHaveBeenCalled()
    // The cancelled intent is closed, so the same inputs ask for a fresh quote.
    await call(client, 'tgbp_swap', { ...args, minOut: '12.6' })
    expect(new Set(intentIds()).size).toBe(2)
  })

  it('never cancels a resumed intent, whose deposit may be on the way', async () => {
    swap.createConversion.mockRejectedValueOnce(
      new TgbpKitError('API_ERROR', 'POST /api/conversions failed with 409', {
        details: { status: 409, apiCode: 'confirmed_deposit_required' },
      }),
    )
    const client = await connect()
    await call(client, 'tgbp_swap', args)
    const { body } = await call(client, 'tgbp_swap', { ...args, minOut: '13' })
    expect(body.message).toContain('do not fund it: an earlier call may have asked for its deposit')
    expect(swap.cancelSwapIntent).not.toHaveBeenCalled()
  })

  it('converts an intent whose firm quote pays at least minOut', async () => {
    const { isError } = await call(await connect(), 'tgbp_swap', { ...args, minOut: '12.5' })
    expect(isError).toBe(false)
    expect(swap.cancelSwapIntent).not.toHaveBeenCalled()
    expect(converted.size).toBe(1)
  })

  it('keeps a refused intent open when it cannot be cancelled, so a retry finds it again', async () => {
    swap.cancelSwapIntent.mockRejectedValueOnce(new Error('cancel failed'))
    const client = await connect()
    const { body } = await call(client, 'tgbp_swap', { ...args, minOut: '13' })
    expect(body.message).toContain('Cancelling it failed, so do not fund it: cancel failed')
    await call(client, 'tgbp_swap', { ...args, minOut: '13' })
    expect(new Set(intentIds()).size).toBe(1)
    expect(swap.createConversion).not.toHaveBeenCalled()
  })

  it('keeps a refused intent open when the swap API does not confirm the cancel', async () => {
    swap.cancelSwapIntent.mockResolvedValueOnce({ data: { status: 'converted' } } as never)
    const client = await connect()
    const { body } = await call(client, 'tgbp_swap', { ...args, minOut: '13' })
    expect(body.message).toContain('Cancelling it failed, so do not fund it')
    await call(client, 'tgbp_swap', { ...args, minOut: '13' })
    expect(new Set(intentIds()).size).toBe(1)
  })

  it('starts a new intent once the saved one expired', async () => {
    swap.createSwapIntent.mockImplementationOnce(async (body: IntentBody) => ({
      data: intent(body, { status: 'expired' }),
      idempotencyKey: body.id,
    }))
    const client = await connect()
    const first = await call(client, 'tgbp_swap', args)
    expect(first.isError).toBe(true)
    expect(first.body.message).toMatch(/is expired; nothing was converted/)
    expect((await call(client, 'tgbp_swap', args)).isError).toBe(false)
    const [expired, fresh] = intentIds()
    expect(fresh).not.toBe(expired)
    expect([...converted]).toEqual([fresh])
  })

  it('keeps a failed intent, which may hold a deposit, and never registers a second one', async () => {
    const failed = async (body: IntentBody) => ({
      data: intent(body, { status: 'failed', failureReason: 'bridge_failed' }),
      idempotencyKey: body.id,
    })
    swap.createSwapIntent.mockImplementationOnce(failed).mockImplementationOnce(failed)
    const client = await connect()
    for (const _ of [1, 2]) {
      const { isError, body } = await call(client, 'tgbp_swap', args)
      expect(isError).toBe(true)
      expect(body.message).toContain('a deposit for it may already have arrived. Send nothing more')
    }
    expect(new Set(intentIds()).size).toBe(1)
    expect(swap.createConversion).not.toHaveBeenCalled()
  })

  it('refuses an intent that does not match the request, and converts nothing', async () => {
    swap.createSwapIntent.mockImplementationOnce(async (body: IntentBody) => ({
      data: intent(body, { sourceRawAmount: '20000000000000000000' }),
      idempotencyKey: body.id,
    }))
    const { isError, body } = await call(await connect(), 'tgbp_swap', args)
    expect(isError).toBe(true)
    expect(body.message).toContain('does not match the request (amount); nothing was converted')
    expect(swap.createConversion).not.toHaveBeenCalled()
  })

  it('says to send nothing once the intent deadline has passed', async () => {
    swap.createSwapIntent.mockImplementationOnce(async (body: IntentBody) => ({
      data: intent(body, { fillBy: '2020-01-01T00:00:00Z' }),
      idempotencyKey: body.id,
    }))
    swap.createConversion.mockRejectedValueOnce(
      new TgbpKitError('API_ERROR', 'POST /api/conversions failed with 409', {
        details: { status: 409, apiCode: 'confirmed_deposit_required' },
      }),
    )
    const { body } = await call(await connect(), 'tgbp_swap', args)
    expect(body.message).toContain('has passed; nothing was converted. Send nothing for it.')
    expect(body.message).not.toContain('Send exactly')
  })

  it('asks again for the conversion of an intent the swap API already converted', async () => {
    swap.createSwapIntent.mockImplementationOnce(async (body: IntentBody) => ({
      data: intent(body, { status: 'converted' }),
      idempotencyKey: body.id,
    }))
    const { isError, body } = await call(await connect(), 'tgbp_swap', { ...args, minOut: '99' })
    // Its quote was accepted when it converted; the repeat returns that conversion.
    expect(isError).toBe(false)
    expect(body.replayed).toBe(true)
    expect(swap.cancelSwapIntent).not.toHaveBeenCalled()
    expect(converted.size).toBe(1)
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

  /** A server the policy does not list, counting the requests that reach it. */
  const unlistedServer = async () => {
    const counted = { hits: 0 }
    const app = express()
    app.use((_req, res) => {
      counted.hits += 1
      res.status(402).end()
    })
    return Object.assign(counted, await serve(app))
  }

  it.each([
    ['an estimate', { estimate: true }],
    ['a payment', { reason: 'a quote for the user' }],
  ])('refuses %s for a URL on no listed service before any request', async (_, args) => {
    const unlisted = await unlistedServer()
    try {
      const { isError, body } = await call(await connectX402(), 'tgbp_x402_pay', {
        url: `${unlisted.url}/quote?key=secret`,
        maxPence: 5,
        ...args,
      })
      expect(isError).toBe(true)
      expect(body.code).toBe('SPEND_POLICY_DENIED')
      expect(body.details).toMatchObject({ rule: 'services', url: `${unlisted.url}/quote` })
      expect(body.message).not.toMatch(/secret/)
      expect(unlisted.hits).toBe(0)
      expect(signTypedData).not.toHaveBeenCalled()
    } finally {
      await unlisted.close()
    }
  })

  it('refuses an estimate that a listed service redirects elsewhere', async () => {
    const unlisted = await unlistedServer()
    const app = express()
    app.use((_req, res) => res.redirect(302, `${unlisted.url}/quote`))
    const listed = await serve(app)
    try {
      const policy = x402Policy()
      const x402 = { ...policy.x402, services: [{ match: listed.url, category: 'quotes' }] }
      const { isError, body } = await call(
        await connectX402({ ...policy, x402 } as SpendPolicy),
        'tgbp_x402_pay',
        { url: `${listed.url}/quote`, maxPence: 5, estimate: true },
      )
      expect(isError).toBe(true)
      expect(body.code).toBe('PAYMENT_NOT_OFFERED')
      expect(body.details).toMatchObject({ status: 302 })
      expect(unlisted.hits).toBe(0)
    } finally {
      await listed.close()
      await unlisted.close()
    }
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

  /** A 2026-07-28 client whose human answers the first-payment question with `answer`. */
  const connectX402Modern = (answer: ModernAnswer) =>
    connectModern({
      answer,
      server: {
        policy: x402Policy(),
        evm: x402Evm as unknown as NonNullable<TgbpMcpServerOptions['evm']>,
      },
    })
  const quote = () => ({ url: `${paid.url}/quote`, maxPence: 5, reason: 'a quote for the user' })

  it('asks through input_required on a 2026-07-28 connection, and pays once the human approves', async () => {
    const client = await connectX402Modern('approve')
    const { isError, body } = await call(client, 'tgbp_x402_pay', quote())
    expect(isError).toBe(false)
    expect(body.paid.transaction).toBe(SETTLE_HASH)
    expect(inputRequiredResults(client.responses)).toHaveLength(1)
    // Asked once, before anything was signed or recorded.
    expect(client.asked).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('its first payment to the x402 service'),
        signatures: 0,
        ledger: '',
      }),
    ])
    expect(fake.calls.settle).toHaveLength(1)
    const entries = (await ledger()).trim().split('\n')
    expect(entries).toHaveLength(1)
    expect(JSON.parse(entries[0] ?? '{}')).toMatchObject({ firstPayment: true })
  })

  it.each(['decline', 'cancel'] as const)(
    'refuses the first payment on a 2026-07-28 connection when the human answers %s, and signs nothing',
    async (answer) => {
      const client = await connectX402Modern(answer)
      const { isError, body } = await call(client, 'tgbp_x402_pay', quote())
      expect(isError).toBe(true)
      expect(body.details.rule).toBe('firstPayment')
      expect(client.asked).toHaveLength(1)
      expect(signTypedData).not.toHaveBeenCalled()
      expect(fake.calls.verify).toHaveLength(0)
      expect(await ledger()).toBe('')
    },
  )

  it("keeps a human's no even when another call paid the service first between the rounds", async () => {
    const client = await connectX402Modern('approve')
    const first = await round(client, quote(), undefined, undefined, 'tgbp_x402_pay')
    expect(first.resultType).toBe('input_required')
    // Another call is approved and pays, so the policy no longer needs to ask.
    expect((await call(client, 'tgbp_x402_pay', quote())).isError).toBe(false)
    const declined = await round(
      client,
      quote(),
      first.requestState,
      { action: 'decline' },
      'tgbp_x402_pay',
    )
    expect(textOf(declined).body.details).toMatchObject({ rule: 'firstPayment', declined: true })
    expect(fake.calls.settle).toHaveLength(1)
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
    // A swap's second call is a new swap with a new intent id.
    const {
      intentId: _a,
      idempotencyKey: _b,
      ...taskBody
    } = JSON.parse(task.result?.content[0]?.text ?? 'null')
    const { intentId: _c, idempotencyKey: _d, ...blockingBody } = blocking.body
    expect(taskBody).toEqual(blockingBody)
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

  it('keeps the key until the client reads the result, then frees the inputs', async () => {
    const args = { chain: 'sepolia', destinationAddress: AGENT, amount: '10' }
    const keys = () =>
      api.mints.create.mock.calls.map(
        (c) => (c as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey,
      )
    const tasks = await connectTasks()
    await expect(tasks.client.callTool({ name: 'tgbp_mint', arguments: args })).rejects.toThrow()
    await vi.waitFor(() => expect(api.mints.create).toHaveBeenCalledTimes(1))
    // The result was never read: a retry resends the same key.
    await call(await connect(), 'tgbp_mint', args)
    expect(keys()[1]).toBe(keys()[0])
    // Once a result is read, the same inputs are a new mint.
    expect((await callTask(await connectTasks(), 'tgbp_mint', args)).status).toBe('completed')
    await call(await connect(), 'tgbp_mint', args)
    expect(keys()[3]).not.toBe(keys()[2])
  })

  it('fails a redemption task with its id when the burn fails, bigint details and all', async () => {
    api.redemptions.create.mockResolvedValueOnce(
      created({ amount: { amount: '50.00', currency: 'GBP' } }),
    )
    chain.transfer.mockRejectedValueOnce(
      new TgbpKitError('INSUFFICIENT_BALANCE', 'too little', {
        details: { balance: 1n, needed: 50n },
      }),
    )
    const task = await callTask(await connectTasks(), 'tgbp_redeem', {
      chain: 'sepolia',
      bankId: 'bank_ok',
      amount: '50',
    })
    expect(task.status).toBe('failed')
    expect(task.error?.data).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { redemptionId: 'red_1', balance: '1', needed: '50' },
      idempotencyKey: expect.any(String),
    })
  })

  it('refuses a redeem retry by transaction when a burned task was never read', async () => {
    const args = { chain: 'sepolia', bankId: 'bank_ok', amount: '50' }
    api.redemptions.create.mockResolvedValueOnce(
      created({ amount: { amount: '50.00', currency: 'GBP' } }),
    )
    const tasks = await connectTasks()
    await expect(tasks.client.callTool({ name: 'tgbp_redeem', arguments: args })).rejects.toThrow()
    await vi.waitFor(() => expect(chain.transfer).toHaveBeenCalledTimes(1))
    await vi.waitFor(async () => {
      const { body } = await call(await connect(), 'tgbp_redeem', args)
      expect(body.message).toMatch(/red_1 .*sent in transaction 0xburn/)
    })
    expect(chain.transfer).toHaveBeenCalledTimes(1)
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

  it('re-registers the same swap intent, so the swap converts once', async () => {
    const args = { chain: 'sepolia', direction: 'TGBP_TO_USDC', amount: '10', recipient: AGENT }
    swap.createConversion.mockImplementationOnce(async (body: { intentId: string }) => {
      converted.add(body.intentId)
      return new Promise(() => {})
    })
    await dieDuring('tgbp_swap', args, () => expect(swap.createConversion).toHaveBeenCalledTimes(1))

    const { isError, body } = await call(await connect({ elicit: 'approve' }), 'tgbp_swap', args)
    expect(isError).toBe(false)
    const conversions = swap.createConversion.mock.calls.map(([sent]) => sent.intentId)
    expect(conversions).toHaveLength(2)
    expect(conversions[1]).toBe(conversions[0])
    expect(swap.createSwapIntent.mock.calls.map(([sent]) => sent.id)).toEqual(conversions)
    expect([...converted]).toEqual([conversions[0]])
    expect(body.intentId).toBe(conversions[0])
  })

  it('never burns a second time when it died during the burn', async () => {
    const redeem = { chain: 'sepolia', bankId: 'bank_ok', amount: '50' }
    api.redemptions.create.mockResolvedValueOnce(
      created({ amount: { amount: '50.00', currency: 'GBP' } }),
    )
    chain.transfer.mockReturnValueOnce(new Promise(() => {}))
    await dieDuring('tgbp_redeem', redeem, () => expect(chain.transfer).toHaveBeenCalledTimes(1))

    const { isError, body } = await call(await connect(), 'tgbp_redeem', redeem)
    expect(isError).toBe(true)
    expect(body.message).toMatch(/red_1 .*may have been sent/)
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

  it('resends the same key after the API refused the first request', async () => {
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
    // A 4xx can follow an earlier attempt that created the record, so the key is kept.
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
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
