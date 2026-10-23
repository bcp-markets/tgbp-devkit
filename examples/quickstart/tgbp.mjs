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
