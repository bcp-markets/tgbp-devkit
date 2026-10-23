/**
 * An agent pays 5p of test tGBP for an API call over x402 on Base Sepolia,
 * from a wallet that holds no ETH. This is also the end-to-end test of
 * `@bcptechnologies/tgbp-kit/x402`: it exits 1 if any check fails.
 *
 *   pnpm x402:demo --fund-from <foundry keystore account>
 *   pnpm x402:demo --pay-to <address>        # fund the printed payer yourself
 *
 * The payer is a fresh key made in memory for this run and never written down.
 * With `--fund-from`, `cast` sends it 5p from that keystore (it asks for the
 * keystore password) and the payment goes back to the same address.
 */
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import express from 'express'
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

import { formatAmount } from '../../src/amount.js'
import { tgbpAbi } from '../../src/evm/abi.js'
import { createTgbpPaymentFetch } from '../../src/x402/client.js'
import {
  penceToBaseUnits,
  TGBP_BASE_SEPOLIA,
  tgbpPaymentMiddleware,
} from '../../src/x402/server.js'

const PENCE = 5
const token = TGBP_BASE_SEPOLIA
const price = penceToBaseUnits(PENCE, token)
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'

const { values } = parseArgs({
  options: { 'fund-from': { type: 'string' }, 'pay-to': { type: 'string' } },
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

  const app = express()
  app.use(
    tgbpPaymentMiddleware({
      routes: { 'GET /quote': { pence: PENCE, payTo, description: 'A sterling quote' } },
    }),
  )
  app.get('/quote', (_req, res) => {
    res.json({ quote: 'GBP is the currency of the United Kingdom', paidWith: '5p of test tGBP' })
  })
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const { port } = server.address() as AddressInfo

  try {
    const pay = createTgbpPaymentFetch({ publicClient, walletClient, maxPencePerRequest: PENCE })
    const { response, settlement } = await pay(`http://127.0.0.1:${port}/quote`)
    const hash = settlement?.transaction
    console.log(`Settlement: ${token.explorerUrl}/tx/${hash}`)
    console.log(`API response ${response.status}:`, await response.text())
    check(response.status === 200, 'the paid request got the API response')
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
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
