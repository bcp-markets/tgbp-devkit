import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  getEvmToken,
  getEvmTokenByChainId,
  getSolanaToken,
  getToken,
  isTgbpKitError,
  listTokens,
  TOKENS,
} from '../src/index.js'

describe('token registry', () => {
  it('marks Gnosis retired and keeps it out of the live list', () => {
    expect(getToken('gnosis')).toMatchObject({ status: 'retired', retiredOn: '2026-09-28' })
    expect(listTokens().map((t) => t.chain)).not.toContain('gnosis')
    expect(listTokens({ includeRetired: true }).map((t) => t.chain)).toContain('gnosis')
  })

  it('lists only live chains by default', () => {
    expect(listTokens().every((t) => t.status === 'live')).toBe(true)
  })

  it('separates mainnet from testnet', () => {
    const testnet = listTokens({ network: 'testnet' }).map((t) => t.chain)
    expect(testnet).toEqual(
      expect.arrayContaining(['sepolia', 'arbitrum-sepolia', 'arc-testnet', 'solana-devnet']),
    )
    expect(testnet).not.toContain('base')
  })

  // A guard on the public contract: callers hard-code these when converting amounts.
  it('keeps the public decimals contract: 18 on EVM, 9 on Solana', () => {
    for (const t of TOKENS) expect(t.decimals).toBe(t.family === 'evm' ? 18 : 9)
  })

  it('stores EVM addresses checksummed', () => {
    for (const t of listTokens({ family: 'evm', includeRetired: true })) {
      expect(t.address).toBe(getAddress(t.address))
    }
  })

  it('finds a deployment by chain id', () => {
    expect(getEvmTokenByChainId(8453).chain).toBe('base')
  })

  it('throws UNKNOWN_CHAIN for a chain tGBP is not on', () => {
    expect(() => getToken('dogechain')).toThrow(expect.objectContaining({ code: 'UNKNOWN_CHAIN' }))
    let caught: unknown
    try {
      getEvmTokenByChainId(31337)
    } catch (error) {
      caught = error
    }
    expect(isTgbpKitError(caught, 'UNKNOWN_CHAIN')).toBe(true)
  })

  it('refuses a chain of the other family', () => {
    expect(() => getEvmToken('solana')).toThrow(
      expect.objectContaining({ code: 'WRONG_CHAIN_ADDRESS' }),
    )
    expect(() => getSolanaToken('base')).toThrow(
      expect.objectContaining({ code: 'WRONG_CHAIN_ADDRESS' }),
    )
  })
})
