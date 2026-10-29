# Quickstart

> **For AI agents.** This page is also Markdown, at [/quickstart.md](https://dev.tokenisedgbp.com/quickstart.md), and [llms.txt](https://dev.tokenisedgbp.com/llms.txt) lists every page. To act on tGBP, install the `tgbp-mcp` MCP server and the agent skills from `@bcptechnologies/tgbp-kit`: the [README](https://github.com/bcp-markets/tgbp-devkit#agents-mcp-server-skills-and-spend-policy) has the config. Start on testnet: Base Sepolia, test tGBP from the faucet, and the API sandbox, the server's default. Act through the server and its spend policy, and never ask for the API key or the wallet key.

This guide takes a clean machine to a confirmed test tGBP transfer on Base Sepolia. It takes about 15 minutes. You need Node.js 20.6 or later and a terminal.

The scripts are also in the repo, under [`examples/quickstart`](https://github.com/bcp-markets/tgbp-devkit/tree/main/examples/quickstart).

## 1. Create the project

```
node --version
mkdir tgbp-quickstart && cd tgbp-quickstart
npm init -y
npm pkg set type=module
npm install @bcptechnologies/tgbp-kit viem
echo .env >> .gitignore
```

## 2. Connect to Base Sepolia

Save this as `tgbp.mjs`. The other scripts import the token, the account and the clients from it. It uses Base's public RPC unless you set `RPC_URL`.

```
import { getEvmToken } from '@bcptechnologies/tgbp-kit'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

// Test tGBP on Base Sepolia, from the kit's token registry.
export const token = getEvmToken('base-sepolia')

if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set: run node wallet.mjs, then pass --env-file=.env')
}

const transport = http(process.env.RPC_URL)

export const account = privateKeyToAccount(process.env.PRIVATE_KEY)
export const publicClient = createPublicClient({ chain: baseSepolia, transport })
export const walletClient = createWalletClient({ chain: baseSepolia, transport, account })
```

## 3. Create a test wallet

Save this as `wallet.mjs`, then run `node wallet.mjs`.

```
import { existsSync, writeFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// Never overwrite a key: the wallet and its test tGBP would be lost with it.
if (existsSync('.env')) {
  throw new Error('.env already exists. Keep using that wallet, or move the file away first.')
}

const key = generatePrivateKey()
writeFileSync('.env', `PRIVATE_KEY=${key}\n`, { mode: 0o600 })
console.log(`Test wallet created. Address: ${privateKeyToAccount(key).address}`)
```

The key stays in `.env` on your machine. Use this wallet for testnets only, and never send it real funds.

## 4. Fund the wallet

1. Get a little Base Sepolia ETH to pay gas, from one of the [faucets Base lists](https://docs.base.org/get-started/get-funds).
2. Get 10 test tGBP from the tGBP faucet. In the project, run `npx tgbp-faucet <your address>`, or paste the address into this form. (The form sends `address` by POST to https://dev.tokenisedgbp.com/api/faucet.) The faucet sends once a day to each address and to each network.

> **The faucet needs only your address.** Never paste a private key into it or anywhere else. Nobody will ask you to pay for test tokens.

## 5. Check the balance

Save this as `balance.mjs`, then run `node --env-file=.env balance.mjs`.

```
import { formatAmount } from '@bcptechnologies/tgbp-kit'
import { getBalance } from '@bcptechnologies/tgbp-kit/evm'
import { formatEther } from 'viem'
import { account, publicClient } from './tgbp.mjs'

const { amount, decimals } = await getBalance({
  publicClient,
  chain: 'base-sepolia',
  owner: account.address,
})
const gas = await publicClient.getBalance({ address: account.address })

console.log(`${account.address} holds ${formatAmount(amount, decimals)} tGBP`)
console.log(`and ${formatEther(gas)} Base Sepolia ETH for gas`)
```

## 6. Send tGBP

Save this as `send.mjs`. Run it with a recipient address and an amount: `node --env-file=.env send.mjs 0xRecipient 1`.

```
import { isTgbpKitError, parseAmount } from '@bcptechnologies/tgbp-kit'
import { transfer } from '@bcptechnologies/tgbp-kit/evm'
import { publicClient, token, walletClient } from './tgbp.mjs'

const [to, value = '1'] = process.argv.slice(2)
if (!to) {
  console.error('Usage: node --env-file=.env send.mjs <recipient address> [amount]')
  process.exit(1)
}

try {
  const { hash, receipt } = await transfer({
    publicClient,
    walletClient,
    chain: 'base-sepolia',
    to,
    amount: parseAmount(value, token.decimals),
  })
  console.log(`Sent ${value} tGBP, confirmed in block ${receipt.blockNumber}`)
  console.log(`${token.explorerUrl}/tx/${hash}`)
} catch (error) {
  // The kit explains the failures it can predict, such as an empty balance.
  // parseAmount throws a RangeError for an amount the token cannot hold.
  if (isTgbpKitError(error)) console.error(`${error.code}: ${error.message}`)
  else if (error instanceof RangeError) console.error(error.message)
  else throw error
  process.exit(1)
}
```

`transfer` checks the pause state, both addresses' ban status and your balance before it signs. It returns once the transaction is mined. Open the printed link to see the transfer on the block explorer.

## Next

- Watch for incoming payments with `watchIncomingTransfers`.
- Handle each error code: see the [README](https://github.com/bcp-markets/tgbp-devkit#errors).
- Before you write about tGBP in your app, read [how to describe it](https://dev.tokenisedgbp.com/brand.md).
