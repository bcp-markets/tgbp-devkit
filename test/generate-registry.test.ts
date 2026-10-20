/**
 * The generator against a synthetic tGBP tree, so its rules are tested in
 * every CI run, not only where the private source is available.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildRegistry } from '../scripts/generate-registry.js'

const CANONICAL = '0x27f6c8289550fce67f6b50bed1f519966afe5287'
const MAINNET_MINT = '2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW'
const DEVNET_MINT = 'H9JAnSzaX66KioeboojT8Ng7Aw2xKLbNoCuNfWZjisYd'

const REGISTRY = `
import { EndpointId } from '@layerzerolabs/lz-definitions'
import { CANONICAL_OWNER } from './owners'
export const MAINNET_OFT_ADDRESS = '${CANONICAL}'
const explorer = { flavor: 'etherscan' }
const base = {
  hardhatNetwork: 'base', chainId: 8453, eid: EndpointId.BASE_V2_MAINNET, isMainnet: true,
  oftDeploymentName: 'StableTokenV1OFT', oftAddress: MAINNET_OFT_ADDRESS,
  blockExplorer: { name: 'BaseScan', browserUrl: 'https://basescan.org', ...explorer },
}
const gnosis = {
  hardhatNetwork: 'gnosis', chainId: 100, eid: 30145, isMainnet: true,
  oftDeploymentName: 'StableTokenV1OFT', oftAddress: '0x1F34490F8e8E776FFc547b39B864364035Eaf44F',
  blockExplorer: { browserUrl: 'https://gnosisscan.io' },
  knownAnomaly: { reason: 'non-canonical', expectedOwner: CANONICAL_OWNER },
  retired: { issue: 'X-1', date: '2026-09-28', reason: 'left ' + 'the mesh' },
}
const sepolia = {
  hardhatNetwork: 'sepolia', chainId: 11155111, eid: 40161, isMainnet: false,
  oftDeploymentName: 'StableTokenV1OFT', oftAddress: '0xf6Ef9ADB61A48E29E36bc873070A46A3D2667ff3',
  blockExplorer: { browserUrl: 'https://sepolia.etherscan.io' },
}
const baseSepolia = {
  hardhatNetwork: 'base-sepolia', chainId: 84532, eid: 40245, isMainnet: false,
  oftDeploymentName: 'StableTokenV1OFT', oftAddress: MAINNET_OFT_ADDRESS,
  blockExplorer: { browserUrl: 'https://sepolia.basescan.org' },
  knownAnomaly: { reason: 'orphan proxy' },
}
const arc = {
  hardhatNetwork: 'arc', chainId: 5042, eid: 30417, isMainnet: true,
  oftDeploymentName: 'StableTokenV1OFT', blockExplorer: { browserUrl: 'https://explorer.arc.io' },
}
const baseFork = { ...base, hardhatNetwork: 'base-fork', localForkOf: 'base' }
export const CHAINS = { base, gnosis, sepolia, 'base-sepolia': baseSepolia, arc, 'base-fork': baseFork }
`

const MESH = {
  chains: [
    { id: 'base', chainType: 'evm', tokenMintAddress: null },
    { id: 'solana', chainType: 'solana', tokenMintAddress: MAINNET_MINT },
    { id: 'solana-devnet', chainType: 'solana', tokenMintAddress: DEVNET_MINT },
  ],
}

function sourceTree(edit: (write: (path: string, body: unknown) => void) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tgbp-source-'))
  const write = (path: string, body: unknown) => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body))
  }
  write('registry/chains.ts', REGISTRY)
  write('registry/solana.json', MESH)
  write('contracts/StableTokenV1OFT.sol', 'contract StableTokenV1OFT {}')
  // As in tGBP's git tree: base and solana-mainnet artifacts are committed,
  // sepolia's directory holds only other tokens, the rest have none.
  write('deployments/base/StableTokenV1OFT.json', { address: CANONICAL })
  write('deployments/sepolia/StableTokenV1OFT_tEUR.json', { address: '0x01' })
  write('deployments/solana-mainnet/OFT.json', { mint: MAINNET_MINT })
  edit(write)
  return dir
}

describe('buildRegistry', () => {
  it('lists live, testnet, retired and Solana deployments', () => {
    const tokens = buildRegistry(sourceTree())
    expect(tokens.map((t) => [t.chain, t.network, t.status])).toEqual([
      ['base', 'mainnet', 'live'],
      ['gnosis', 'mainnet', 'retired'],
      ['sepolia', 'testnet', 'live'],
      ['solana', 'mainnet', 'live'],
      ['solana-devnet', 'testnet', 'live'],
    ])
    expect(tokens[0]).toEqual({
      chain: 'base',
      family: 'evm',
      network: 'mainnet',
      status: 'live',
      symbol: 'tGBP',
      decimals: 18,
      chainId: 8453,
      address: '0x27f6c8289550fCE67f6B50BeD1F519966aFE5287',
      explorerUrl: 'https://basescan.org',
    })
    expect(tokens[1]).toMatchObject({ retiredOn: '2026-09-28' })
    expect(tokens[4]).toMatchObject({ cluster: 'devnet', address: DEVNET_MINT, decimals: 9 })
  })

  it('skips forks, undeployed chains and a live anomaly with no artifact', () => {
    const chains = buildRegistry(sourceTree()).map((t) => t.chain)
    expect(chains).not.toContain('base-fork')
    expect(chains).not.toContain('arc')
    expect(chains).not.toContain('base-sepolia')
  })

  it('skips a live anomaly even when its artifact is committed', () => {
    const dir = sourceTree((write) =>
      write('deployments/base-sepolia/StableTokenV1OFT.json', { address: CANONICAL }),
    )
    expect(buildRegistry(dir).map((t) => t.chain)).not.toContain('base-sepolia')
  })

  it('fails when a field it reads is an imported value', () => {
    const dir = sourceTree((write) =>
      write(
        'registry/chains.ts',
        REGISTRY.replace(
          "import { CANONICAL_OWNER } from './owners'",
          "import { CANONICAL_OWNER, Flags } from './owners'",
        ).replace(
          'isMainnet: true,\n  oftDeploymentName',
          'isMainnet: Flags.MAINNET,\n  oftDeploymentName',
        ),
      ),
    )
    expect(() => buildRegistry(dir)).toThrow(/base: isMainnet is an imported value/)
  })

  it('fails on a __proto__ key', () => {
    const dir = sourceTree((write) =>
      write('registry/chains.ts', 'export const CHAINS = { __proto__: {} }'),
    )
    expect(() => buildRegistry(dir)).toThrow(/__proto__/)
  })

  it('fails when the registry address disagrees with a committed artifact', () => {
    const dir = sourceTree((write) =>
      write('deployments/base/StableTokenV1OFT.json', {
        address: '0x0000000000000000000000000000000000000001',
      }),
    )
    expect(() => buildRegistry(dir)).toThrow(/base: chain registry oftAddress .* != deployment/)
  })

  it('fails when a Solana artifact disagrees with Solana targets', () => {
    const dir = sourceTree((write) =>
      write('deployments/solana-testnet/OFT.json', { mint: MAINNET_MINT }),
    )
    expect(() => buildRegistry(dir)).toThrow(/solana-devnet: Solana targets mint/)
  })

  it('fails on a Solana chain it has no cluster for', () => {
    const dir = sourceTree((write) =>
      write('registry/solana.json', {
        chains: [...MESH.chains, { id: 'eclipse', chainType: 'solana', tokenMintAddress: null }],
      }),
    )
    expect(() => buildRegistry(dir)).toThrow(/Solana chain "eclipse"/)
  })

  it('fails on a deployment directory it cannot place', () => {
    const dir = sourceTree((write) => write('deployments/zksync/StableTokenV1OFT.json', {}))
    expect(() => buildRegistry(dir)).toThrow(/deployments\/zksync/)
  })

  it('fails when the contract overrides decimals()', () => {
    const dir = sourceTree((write) =>
      write(
        'contracts/StableTokenV1OFT.sol',
        'contract X { function decimals() public pure returns (uint8) { return 6; } }',
      ),
    )
    expect(() => buildRegistry(dir)).toThrow(/overrides decimals/)
  })

  it('fails loudly on source it cannot evaluate', () => {
    const dir = sourceTree((write) =>
      write('registry/chains.ts', 'export const CHAINS = buildChains()'),
    )
    expect(() => buildRegistry(dir)).toThrow(/unsupported expression CallExpression/)
  })
})
