/**
 * An MCP server that gives an agent tGBP tools, every one that moves value
 * behind the spend policy. A redemption above the approval threshold asks the human
 * through the MCP client (elicitation). A client that cannot ask, a "no", and
 * no answer before the timeout all refuse it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { type AgentActionsOptions, createAgentActions } from '../agent/actions.js'
import {
  type Approver,
  createSpendGuard,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_REASON_LENGTH,
} from '../agent/guard.js'
import type { SpendPolicy } from '../agent/policy.js'
import { formatAmount } from '../amount.js'
import { isTgbpKitError } from '../errors.js'
import { KIT_VERSION } from '../version.js'

type X402Client = typeof import('../x402/client.js')
type PaymentFetch = ReturnType<X402Client['createTgbpPaymentFetch']>

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

/** The most `tgbp_x402_pay` accepts as `maxPence`; the spend policy's caps still apply below it. */
const MAX_X402_PENCE = 100_000
/** How much of a paid service's response the tool returns into the agent's context. */
const MAX_X402_BODY_CHARS = 20_000

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

  // One payment fetch for the server: it pays one payment at a time, because
  // two signed at once would share a permit nonce.
  let paymentFetch: Promise<PaymentFetch> | undefined
  function x402PaymentFetch(): Promise<PaymentFetch> {
    paymentFetch ??= (async () => {
      const x402 = await loadX402()
      if (!options.evm) throw new Error('No EVM wallet is configured')
      const { publicClient, walletClient } = options.evm(x402.TGBP_BASE_SEPOLIA)
      return x402.createTgbpPaymentFetch({
        publicClient,
        walletClient,
        maxPencePerRequest: MAX_X402_PENCE,
        guard,
      })
    })()
    // A failed setup is not cached, so the next call can try again.
    paymentFetch.catch(() => {
      paymentFetch = undefined
    })
    return paymentFetch
  }

  server.registerTool(
    'tgbp_x402_pay',
    {
      title: 'Pay an x402 URL in tGBP',
      description:
        "GET a URL that charges over x402 and pay it in tGBP on Base Sepolia from this agent's wallet, then return the service's response. A price above maxPence is refused without signing. Pass estimate: true to read the price and pay nothing. A payment counts against the per-transfer and daily caps, and the payee must be an allowed destination.",
      inputSchema: {
        url: z
          .url({ protocol: /^https?$/ })
          .max(2000)
          .describe('The paid URL'),
        maxPence: z
          .number()
          .int()
          .min(1)
          .max(MAX_X402_PENCE)
          .describe('The most to pay, in whole pence'),
        estimate: z.boolean().optional().describe('Return the price and pay nothing'),
        reason: z
          .string()
          .max(MAX_REASON_LENGTH)
          .optional()
          .describe('Why you are paying; the spend ledger records it. Needed to pay.'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ url, maxPence, estimate, reason }) =>
      run(async () => {
        if (estimate) {
          const x402 = await loadX402()
          const quote = await x402.quoteTgbpPayment(url)
          if (quote.free) return { estimate: true, ...quote }
          const token = x402.TGBP_BASE_SEPOLIA
          return {
            estimate: true,
            free: false,
            url: quote.url,
            amount: formatAmount(quote.amount, token.decimals),
            payTo: quote.payTo,
            network: quote.network,
            maxPence,
            withinMax: quote.amount <= x402.penceToBaseUnits(maxPence, token),
          }
        }
        if (reason === undefined || reason.trim() === '') {
          throw new RangeError('Pass a reason: the spend ledger records why each payment was made')
        }
        const { decimals } = (await loadX402()).TGBP_BASE_SEPOLIA
        const pay = await x402PaymentFetch()
        const paid = await pay(url, undefined, { reason, maxPence })
        const text = await paid.response.text()
        return {
          url,
          status: paid.response.status,
          contentType: paid.response.headers.get('content-type'),
          body: text.slice(0, MAX_X402_BODY_CHARS),
          truncated: text.length > MAX_X402_BODY_CHARS,
          paid:
            paid.settlement && paid.amount !== undefined
              ? {
                  amount: formatAmount(paid.amount, decimals),
                  payTo: paid.payTo,
                  transaction: paid.settlement.transaction,
                  network: paid.settlement.network,
                }
              : null,
        }
      }),
  )

  return server
}

/** The x402 packages are optional peers, so the client loads on first use. */
async function loadX402(): Promise<X402Client> {
  try {
    return await import('../x402/client.js')
  } catch (cause) {
    if ((cause as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') throw cause
    throw new Error(
      'tgbp_x402_pay needs @x402/core and @x402/evm; install them, or add -p @x402/core@2 -p @x402/evm@2 to the npx line',
      { cause },
    )
  }
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
