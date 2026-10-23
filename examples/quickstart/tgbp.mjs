import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'

// Test tGBP on Base Sepolia. The kit's registry does not list this chain yet, so pass the
// deployment itself wherever a helper takes `chain`.
export const token = {
  chain: 'base-sepolia',
  family: 'evm',
  network: 'testnet',
  status: 'live',
  symbol: 'tGBP',
  decimals: 18,
  chainId: 84532,
  address: '0x27f6c8289550fCE67f6B50BeD1F519966aFE5287',
  explorerUrl: 'https://sepolia.basescan.org',
}

if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY is not set: run node wallet.mjs, then pass --env-file=.env')
}

const transport = http(process.env.RPC_URL)

export const account = privateKeyToAccount(process.env.PRIVATE_KEY)
export const publicClient = createPublicClient({ chain: baseSepolia, transport })
export const walletClient = createWalletClient({ chain: baseSepolia, transport, account })
