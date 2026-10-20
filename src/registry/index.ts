import { TgbpKitError } from '../errors.js'
import { TOKENS } from './tokens.generated.js'
import type {
  ChainStatus,
  EvmTokenDeployment,
  Network,
  SolanaTokenDeployment,
  TokenDeployment,
} from './types.js'

export type { ChainStatus, EvmTokenDeployment, Network, SolanaTokenDeployment, TokenDeployment }
export { TOKENS }

/** Every chain key in the registry, live and retired. */
export type ChainKey = (typeof TOKENS)[number]['chain']
export type EvmChainKey = Extract<(typeof TOKENS)[number], { family: 'evm' }>['chain']
export type SolanaChainKey = Extract<(typeof TOKENS)[number], { family: 'solana' }>['chain']

export interface ListTokensOptions {
  network?: Network
  family?: TokenDeployment['family']
  /** Include chains that have left the mesh. Default false. */
  includeRetired?: boolean
}

/** Live deployments by default; pass `includeRetired` to see retired chains too. */
export function listTokens(options: ListTokensOptions = {}): TokenDeployment[] {
  return (TOKENS as readonly TokenDeployment[]).filter(
    (t) =>
      (options.includeRetired || t.status === 'live') &&
      (!options.network || t.network === options.network) &&
      (!options.family || t.family === options.family),
  )
}

/** Look up a deployment by chain key. Retired chains are returned with `status: 'retired'`. */
export function getToken(chain: ChainKey | (string & {})): TokenDeployment {
  const token = (TOKENS as readonly TokenDeployment[]).find((t) => t.chain === chain)
  if (!token) {
    throw new TgbpKitError('UNKNOWN_CHAIN', `tGBP is not deployed on "${chain}"`, {
      details: { chain, known: TOKENS.map((t) => t.chain) },
    })
  }
  return token
}

export function getEvmToken(chain: EvmChainKey | (string & {})): EvmTokenDeployment {
  const token = getToken(chain)
  if (token.family !== 'evm') {
    throw new TgbpKitError(
      'WRONG_CHAIN_ADDRESS',
      `"${chain}" is a Solana chain, not an EVM chain`,
      {
        details: { chain },
      },
    )
  }
  return token
}

/** Find the EVM deployment for a chain id, e.g. from `walletClient.chain.id`. */
export function getEvmTokenByChainId(chainId: number): EvmTokenDeployment {
  const token = (TOKENS as readonly TokenDeployment[]).find(
    (t): t is EvmTokenDeployment => t.family === 'evm' && t.chainId === chainId,
  )
  if (!token) {
    throw new TgbpKitError('UNKNOWN_CHAIN', `tGBP is not deployed on chain id ${chainId}`, {
      details: { chainId },
    })
  }
  return token
}

export function getSolanaToken(chain: SolanaChainKey | (string & {})): SolanaTokenDeployment {
  const token = getToken(chain)
  if (token.family !== 'solana') {
    throw new TgbpKitError('WRONG_CHAIN_ADDRESS', `"${chain}" is an EVM chain, not Solana`, {
      details: { chain },
    })
  }
  return token
}
