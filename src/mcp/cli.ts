#!/usr/bin/env node
/**
 * tgbp-mcp: the tGBP MCP server over stdio. Configured by environment:
 *
 *   TGBP_POLICY_FILE        the spend policy (required)
 *   TGBP_LEDGER_FILE        the spend ledger; default <policy>.ledger.jsonl
 *   TGBP_API_KEY            enables mint, redeem and swap
 *   TGBP_ENVIRONMENT        sandbox (default) or production
 *   TGBP_SWAP_BASE_URL      the swap host; production uses its own by default
 *   TGBP_EVM_PRIVATE_KEY    the agent wallet; enables balance, transfer and redeem
 *   TGBP_RPC_URL_<CHAIN>    an RPC URL per chain, e.g. TGBP_RPC_URL_SEPOLIA
 *   TGBP_APPROVAL_TIMEOUT_SECONDS  how long a redemption waits for a human; default 300
 *
 * stdout carries the protocol, so everything else goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createPublicClient, createWalletClient, defineChain, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { EvmClients } from '../agent/actions.js'
import { loadSpendPolicy } from '../agent/policy.js'
import { createTgbpClient, type TgbpEnvironment } from '../api/client.js'
import { createTgbpSwapClient, SWAP_PRODUCTION_URL } from '../api/swap.js'
import type { EvmTokenDeployment } from '../registry/index.js'
import { createTgbpMcpServer } from './server.js'

async function main(): Promise<void> {
  const env = process.env
  const policyPath = env.TGBP_POLICY_FILE
  if (!policyPath) throw new Error('Set TGBP_POLICY_FILE to your spend policy')
  const policy = await loadSpendPolicy(policyPath)

  const environment = (env.TGBP_ENVIRONMENT ?? 'sandbox') as TgbpEnvironment
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error('TGBP_ENVIRONMENT must be sandbox or production')
  }
  const apiKey = env.TGBP_API_KEY
  const swapBaseUrl =
    env.TGBP_SWAP_BASE_URL ?? (environment === 'production' ? SWAP_PRODUCTION_URL : undefined)

  const timeoutSeconds = Number(env.TGBP_APPROVAL_TIMEOUT_SECONDS ?? 300)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('TGBP_APPROVAL_TIMEOUT_SECONDS must be a positive number')
  }

  const server = createTgbpMcpServer({
    policy,
    ledgerPath: env.TGBP_LEDGER_FILE ?? `${policyPath}.ledger.jsonl`,
    approvalTimeoutMs: timeoutSeconds * 1000,
    ...(apiKey ? { api: createTgbpClient({ apiKey, environment }) } : {}),
    ...(apiKey && swapBaseUrl
      ? { swap: createTgbpSwapClient({ apiKey, baseUrl: swapBaseUrl }) }
      : {}),
    ...(env.TGBP_EVM_PRIVATE_KEY ? { evm: evmClients(env.TGBP_EVM_PRIVATE_KEY as Hex) } : {}),
  })
  await server.connect(new StdioServerTransport())
  console.error(`tgbp-mcp: serving, spend policy ${policyPath} expires ${policy.expiresAt}`)
}

function evmClients(privateKey: Hex): (token: EvmTokenDeployment) => EvmClients {
  const account = privateKeyToAccount(privateKey)
  const cache = new Map<string, EvmClients>()
  return (token) => {
    const cached = cache.get(token.chain)
    if (cached) return cached
    const name = `TGBP_RPC_URL_${token.chain.toUpperCase().replace(/-/g, '_')}`
    const url = process.env[name]
    if (!url) throw new Error(`Set ${name} to an RPC URL for ${token.chain}`)
    const chain = defineChain({
      id: token.chainId,
      name: token.chain,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    })
    const clients: EvmClients = {
      publicClient: createPublicClient({ chain, transport: http(url) }),
      walletClient: createWalletClient({ account, chain, transport: http(url) }),
    }
    cache.set(token.chain, clients)
    return clients
  }
}

main().catch((error: unknown) => {
  console.error(`tgbp-mcp: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
