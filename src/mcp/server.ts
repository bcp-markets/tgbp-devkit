/**
 * An MCP server that gives an agent tGBP tools, every one of them behind the
 * spend policy. A redemption above the approval threshold asks the human
 * through the MCP client (elicitation). A client that cannot ask, a "no", and
 * no answer before the timeout all refuse it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { type AgentActionsOptions, createAgentActions } from '../agent/actions.js'
import { type Approver, createSpendGuard, DEFAULT_APPROVAL_TIMEOUT_MS } from '../agent/guard.js'
import type { SpendPolicy } from '../agent/policy.js'
import { isTgbpKitError } from '../errors.js'
import { KIT_VERSION } from '../version.js'

export interface TgbpMcpServerOptions extends Omit<AgentActionsOptions, 'guard'> {
  policy: SpendPolicy
  /** The append-only spend ledger for this policy. */
  ledgerPath: string
  /** How long to wait for a human to approve a redemption. Default 5 minutes. */
  approvalTimeoutMs?: number
  /** Clock, for tests. */
  now?: () => Date
}

/** Bounds every free-text argument, so an agent cannot hand the parsers a megabyte string. */
const text = () => z.string().max(200)
const chain = text().describe('Registry chain key, e.g. "sepolia"')
const amount = text().describe('Decimal amount, e.g. "12.50"')
const idempotencyKey = text()
  .optional()
  .describe(
    'To retry an earlier attempt, pass its idempotencyKey; never for a new one. A retry counts against the caps again.',
  )

export function createTgbpMcpServer(options: TgbpMcpServerOptions): McpServer {
  const server = new McpServer({ name: 'tgbp', version: KIT_VERSION })
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS

  const approver: Approver = async (request, signal) => {
    if (!server.server.getClientCapabilities()?.elicitation) return false
    const result = await server.server.elicitInput(
      {
        mode: 'form',
        message:
          `An agent asks to redeem ${request.amount} tGBP on ${request.chain} to bank ` +
          `${request.destination}. Your spend policy needs a human to approve any redemption ` +
          `over ${request.threshold}. Approve it?`,
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve this redemption' } },
          required: ['approve'],
        },
      },
      { signal, timeout: approvalTimeoutMs },
    )
    return result.action === 'accept' && result.content?.approve === true
  }

  const guard = createSpendGuard({
    policy: options.policy,
    ledgerPath: options.ledgerPath,
    approver,
    approvalTimeoutMs,
    ...(options.now ? { now: options.now } : {}),
  })
  const actions = createAgentActions({ ...options, guard })

  server.registerTool(
    'tgbp_policy',
    {
      title: 'Show the spend policy',
      description:
        'The spend policy this server enforces: allowed actions, chains and destinations, caps, the redemption approval threshold and the expiry. Read it before you plan an action.',
      annotations: { readOnlyHint: true },
    },
    async () => ok(options.policy),
  )

  server.registerTool(
    'tgbp_balance',
    {
      title: 'Read a tGBP balance',
      description: "The tGBP balance of an address, or of this agent's own wallet.",
      inputSchema: { chain, owner: text().optional().describe('Defaults to the agent wallet') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => actions.balance(args)),
  )

  server.registerTool(
    'tgbp_transfer',
    {
      title: 'Send tGBP',
      description:
        "Send tGBP from this agent's wallet to an allowed destination. Counts against the per-transfer and daily caps.",
      inputSchema: { chain, to: text().describe('Recipient address'), amount },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) => run(() => actions.transfer(args)),
  )

  server.registerTool(
    'tgbp_mint',
    {
      title: 'Mint tGBP',
      description:
        'Create a mint. The result carries bank transfer details; tGBP is minted to the destination once that GBP arrives.',
      inputSchema: {
        chain,
        destinationAddress: text().describe('Where the tGBP is minted to'),
        amount: amount.describe('GBP, to the penny, e.g. "100.00"'),
        customerId: text().optional(),
        idempotencyKey,
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) => run(() => actions.mint(args)),
  )

  server.registerTool(
    'tgbp_redeem',
    {
      title: 'Redeem tGBP for GBP',
      description:
        'Create a redemption and burn the tGBP from this wallet. GBP is paid to the bank account once the burn confirms. A redemption above the approval threshold waits for a human.',
      inputSchema: {
        chain,
        bankId: text().describe('The bank account id the GBP is paid to'),
        amount: amount.describe('GBP, to the penny, e.g. "50.00"'),
        reference: text().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) => run(() => actions.redeem(args)),
  )

  server.registerTool(
    'tgbp_swap',
    {
      title: 'Swap USDC and tGBP',
      description:
        'Convert a confirmed swap deposit and settle it to an allowed recipient. For the caps, a USDC amount counts as the same number of pounds.',
      inputSchema: {
        chain,
        direction: z.enum(['USDC_TO_TGBP', 'TGBP_TO_USDC']),
        amount: amount.describe('The source amount: tGBP or USDC'),
        recipient: text().describe('Where the swapped tokens go'),
        minOut: text().optional().describe('Refuse the swap if it pays out less than this'),
        idempotencyKey,
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) => run(() => actions.swap(args)),
  )

  return server
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn())
  } catch (error) {
    return failure(error)
  }
}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: toJson(value) }] }
}

/** A refusal is a tool result, not a protocol error, so the agent reads the rule. */
function failure(error: unknown): CallToolResult {
  const body = isTgbpKitError(error)
    ? { code: error.code, message: error.message, details: error.details }
    : { message: plainMessage(error) }
  return { isError: true, content: [{ type: 'text', text: toJson(body) }] }
}

/**
 * viem's full message carries the RPC URL, which often holds a provider key;
 * its short message does not.
 */
function plainMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const short = (error as { shortMessage?: unknown }).shortMessage
  return typeof short === 'string' ? short : error.message
}

function toJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
}
