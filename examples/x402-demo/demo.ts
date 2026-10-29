/**
 * An agent pays 5p of test tGBP for an API call over x402 on Base Sepolia,
 * from a wallet that holds no ETH. The API is the example seller in
 * `examples/x402-seller`, run in this process. This is also the end-to-end
 * test of `@bcptechnologies/tgbp-kit/x402`: it exits 1 if any check fails.
 *
 *   pnpm x402:demo --fund-from <foundry keystore account>
 *   pnpm x402:demo --pay-to <address>        # fund the printed payer yourself
 *   pnpm x402:demo --pay-to <address> --mcp  # pay through the MCP server's tgbp_x402_pay
 *
 * The payer is a fresh key made in memory for this run and never written down.
 * With `--fund-from`, `cast` sends it 5p from that keystore (it asks for the
 * keystore password) and the payment goes back to the same address.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  isHash,
  parseEventLogs,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

import { createSpendGuard } from '../../src/agent/guard.js'
import type { SpendPolicy } from '../../src/agent/policy.js'
import { formatAmount } from '../../src/amount.js'
import { tgbpAbi } from '../../src/evm/abi.js'
import { createTgbpMcpServer } from '../../src/mcp/server.js'
import { createTgbpPaymentFetch } from '../../src/x402/client.js'
import { penceToBaseUnits, TGBP_BASE_SEPOLIA } from '../../src/x402/server.js'
import { QUOTE_PENCE, sellerApp } from '../x402-seller/seller.js'

const PENCE = QUOTE_PENCE
const token = TGBP_BASE_SEPOLIA
const price = penceToBaseUnits(PENCE, token)
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'

const { values } = parseArgs({
  options: {
    'fund-from': { type: 'string' },
    'pay-to': { type: 'string' },
    mcp: { type: 'boolean' },
  },
})

// No `chain`: Base Sepolia's OP-stack formatters give a client type the kit's `PublicClient` does not accept, and reads need none.
const publicClient = createPublicClient({ transport: http(rpcUrl) })
const account = privateKeyToAccount(generatePrivateKey())
const walletClient = createWalletClient({ chain: baseSepolia, transport: http(rpcUrl), account })
const tgbpBalance = (owner: `0x${string}`) =>
  publicClient.readContract({
    address: token.address,
    abi: tgbpAbi,
    functionName: 'balanceOf',
    args: [owner],
  })

function check(ok: boolean, message: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
  if (!ok) process.exitCode = 1
}

/** Sends the payer 5p with `cast`, and returns the sender's address. */
async function fundWithCast(keystoreAccount: string): Promise<`0x${string}`> {
  const args = [
    'send',
    token.address,
    'transfer(address,uint256)',
    account.address,
    price.toString(),
    '--account',
    keystoreAccount,
    '--json',
  ]
  // stdin and stderr stay on the terminal, so cast can ask for the keystore password.
  // The RPC URL goes in the environment, so a URL with an API key stays out of `ps`.
  const child = spawn('cast', args, {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, ETH_RPC_URL: rpcUrl },
  })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error(`cast send failed (exit ${code ?? 'signal'})`)
  let receipt: { status?: unknown; from?: unknown; transactionHash?: unknown }
  try {
    receipt = JSON.parse(stdout)
  } catch (cause) {
    throw new Error(
      `cast send printed no JSON receipt; check the payer before re-running:\n${stdout}`,
      {
        cause,
      },
    )
  }
  console.log(`Funding transaction: ${token.explorerUrl}/tx/${String(receipt.transactionHash)}`)
  if (receipt.status !== '0x1') throw new Error('the funding transaction failed')
  if (typeof receipt.from !== 'string' || !isAddress(receipt.from)) {
    throw new Error(`cast send reported no sender: ${stdout}`)
  }
  return getAddress(receipt.from)
}

async function waitForFunding(): Promise<void> {
  console.log(`Send ${formatAmount(price, token.decimals)} test tGBP to ${account.address}`)
  console.log(`  npx -p @bcptechnologies/tgbp-kit tgbp-faucet ${account.address}`)
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    try {
      if ((await tgbpBalance(account.address)) >= price) return
    } catch (error) {
      console.warn('Balance read failed; polling again', error)
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error('the payer was not funded within 15 minutes')
}

interface Paid {
  status: number
  body: string
  hash: string | undefined
}

/** The demo stands in for the owner, who must approve the first payment to a service. */
async function approveFirstPayment(): Promise<boolean> {
  console.log('Approving the first payment to the quote service')
  return true
}

/** Pays for `url` with the payment fetch, or with `--mcp` through the MCP server's `tgbp_x402_pay`. */
async function payFor(url: string, policy: SpendPolicy, ledgerPath: string): Promise<Paid> {
  const reason = 'a sterling quote'
  if (!values.mcp) {
    const pay = createTgbpPaymentFetch({
      publicClient,
      walletClient,
      maxPencePerRequest: PENCE,
      guard: createSpendGuard({ policy, ledgerPath, approver: approveFirstPayment }),
    })
    const { response, settlement } = await pay(url, undefined, { reason })
    return { status: response.status, body: await response.text(), hash: settlement?.transaction }
  }
  const server = createTgbpMcpServer({
    policy,
    ledgerPath,
    evm: () => ({ publicClient, walletClient }),
  })
  // The server asks the owner through the MCP client before the first payment to a service.
  const client = new Client(
    { name: 'x402-demo', version: '0' },
    { capabilities: { elicitation: {} } },
  )
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: 'accept',
    content: { approve: await approveFirstPayment() },
  }))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  try {
    const result = await client.callTool({
      name: 'tgbp_x402_pay',
      arguments: { url, maxPence: PENCE, reason },
    })
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
    if (result.isError) throw new Error(`tgbp_x402_pay failed: ${text}`)
    const paid = JSON.parse(text) as {
      status: number
      body: string
      paid?: { transaction?: string }
    }
    console.log('tgbp_x402_pay result:', text)
    return { status: paid.status, body: paid.body, hash: paid.paid?.transaction }
  } finally {
    await client.close()
  }
}

async function main(): Promise<void> {
  const fundFrom = values['fund-from']
  const payToArg = values['pay-to']
  if (fundFrom === undefined && (payToArg === undefined || !isAddress(payToArg))) {
    throw new Error('pass --fund-from <keystore account>, or --pay-to <address>')
  }
  console.log(`Payer (fresh key, this run only): ${account.address}`)
  check((await publicClient.getBalance({ address: account.address })) === 0n, 'payer holds 0 ETH')

  const payTo =
    fundFrom === undefined ? getAddress(payToArg as string) : await fundWithCast(fundFrom)
  if (fundFrom === undefined) await waitForFunding()
  const payerBefore = await tgbpBalance(account.address)

  const ledgerDir = await mkdtemp(join(tmpdir(), 'tgbp-x402-demo-'))
  const app = sellerApp({ payTo })
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo

  // A spend policy for this run only: one 5p x402 payment to the local quote service, today.
  const policy: SpendPolicy = {
    version: 1,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    actions: ['x402'],
    chains: [token.chain],
    destinations: [payTo],
    perTransferCap: formatAmount(price, token.decimals),
    dailyCap: formatAmount(price, token.decimals),
    redemptionApprovalAbove: '0',
    x402: {
      services: [{ match: `http://127.0.0.1:${port}/quote`, category: 'quotes' }],
      categoryBudgets: { quotes: formatAmount(price, token.decimals) },
      paymentsPerMinute: 1,
    },
  }
  const ledgerPath = join(ledgerDir, 'ledger.jsonl')

  try {
    const { status, body, hash } = await payFor(
      `http://127.0.0.1:${port}/quote`,
      policy,
      ledgerPath,
    )
    console.log(`Settlement: ${token.explorerUrl}/tx/${hash}`)
    console.log(`API response ${status}:`, body)
    check(status === 200, 'the paid request got the API response')
    if (hash === undefined || !isHash(hash)) {
      check(false, 'the facilitator reported a transaction hash')
      return
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    check(receipt.status === 'success', 'the settlement transaction succeeded on Base Sepolia')
    const transfers = parseEventLogs({ abi: tgbpAbi, eventName: 'Transfer', logs: receipt.logs })
    check(
      transfers.some(
        (log) =>
          getAddress(log.address) === getAddress(token.address) &&
          log.args.from === account.address &&
          log.args.to === payTo &&
          log.args.value === price,
      ),
      `the settlement moved exactly 5p of tGBP from the payer to ${payTo}`,
    )
    check(payerBefore - (await tgbpBalance(account.address)) === price, 'the payer paid 5p, once')
    check(
      (await publicClient.getBalance({ address: account.address })) === 0n,
      'the payer still holds 0 ETH: the facilitator paid the gas',
    )
    check(
      (await createSpendGuard({ policy, ledgerPath }).budget()).remaining === '0',
      'the spend ledger counted the payment against the daily cap',
    )
  } finally {
    server.closeAllConnections()
    server.close()
    // A failed clean-up must not hide the error that ended the run.
    await rm(ledgerDir, { recursive: true, force: true }).catch((error: unknown) => {
      console.error(`Could not remove ${ledgerDir}:`, error)
    })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
