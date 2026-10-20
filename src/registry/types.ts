export type Network = 'mainnet' | 'testnet'

/**
 * `retired` chains have left the tGBP cross-chain mesh. Their token contract
 * may still hold balances, but they are not listed as live and new
 * integrations should not target them.
 */
export type ChainStatus = 'live' | 'retired'

interface TokenDeploymentBase {
  /** Registry key, e.g. `base`, `arbitrum-sepolia`, `solana`. */
  chain: string
  network: Network
  status: ChainStatus
  /** ISO date the chain was retired; set only when `status` is `retired`. */
  retiredOn?: string
  symbol: 'tGBP'
  decimals: number
}

export interface EvmTokenDeployment extends TokenDeploymentBase {
  family: 'evm'
  chainId: number
  /** ERC-20 contract address, EIP-55 checksummed. */
  address: `0x${string}`
  explorerUrl: string
}

export interface SolanaTokenDeployment extends TokenDeploymentBase {
  family: 'solana'
  cluster: 'mainnet-beta' | 'devnet'
  /** SPL mint address. */
  address: string
}

export type TokenDeployment = EvmTokenDeployment | SolanaTokenDeployment
