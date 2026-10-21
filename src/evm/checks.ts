// Internal helpers shared by the EVM and x402 modules. Not part of the public API.
import { type Address, getAddress, isAddress, type PublicClient, type WalletClient } from 'viem'

import { TgbpKitError } from '../errors.js'
import { type EvmChainKey, type EvmTokenDeployment, getEvmToken } from '../registry/index.js'

export function resolveToken(chain: EvmChainKey | EvmTokenDeployment): EvmTokenDeployment {
  return typeof chain === 'string' ? getEvmToken(chain) : chain
}

export function toEvmAddress(value: string, token: EvmTokenDeployment): Address {
  // Strict: a mixed-case address must carry a valid EIP-55 checksum; all-lowercase passes.
  if (!isAddress(value)) {
    throw new TgbpKitError(
      'WRONG_CHAIN_ADDRESS',
      `"${value}" is not a valid EVM address (check the checksum), so it cannot hold tGBP on ${token.chain}`,
      { details: { chain: token.chain, address: value } },
    )
  }
  return getAddress(value)
}

export async function assertClientChain(
  client: PublicClient | WalletClient,
  token: EvmTokenDeployment,
): Promise<void> {
  // Ask the node: `client.chain` is only what the caller configured.
  const chainId = await client.getChainId()
  if (chainId !== token.chainId) {
    throw new TgbpKitError(
      'WRONG_CHAIN_ADDRESS',
      `Client is on chain id ${chainId}, but tGBP on ${token.chain} lives on chain id ${token.chainId}`,
      { details: { chain: token.chain, expectedChainId: token.chainId, actualChainId: chainId } },
    )
  }
}

export function pausedError(token: EvmTokenDeployment, cause?: unknown): TgbpKitError {
  return new TgbpKitError('TOKEN_PAUSED', `tGBP is paused on ${token.chain}`, {
    cause,
    details: { chain: token.chain },
  })
}

export function bannedError(
  token: EvmTokenDeployment,
  address?: Address,
  cause?: unknown,
): TgbpKitError {
  const who = address ? `${address} is` : 'The sender or recipient is'
  return new TgbpKitError('ADDRESS_BANNED', `${who} banned from tGBP on ${token.chain}`, {
    cause,
    details: { chain: token.chain, ...(address ? { address } : {}) },
  })
}

export function insufficientError(
  token: EvmTokenDeployment,
  address: Address | undefined,
  balance: bigint | undefined,
  needed: bigint | undefined,
  cause?: unknown,
): TgbpKitError {
  const known = balance !== undefined && needed !== undefined
  return new TgbpKitError(
    'INSUFFICIENT_BALANCE',
    known
      ? `Insufficient tGBP on ${token.chain}: balance ${balance}, needed ${needed}`
      : `Insufficient tGBP on ${token.chain}`,
    { cause, details: { chain: token.chain, address, balance, needed } },
  )
}
