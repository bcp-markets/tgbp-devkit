/**
 * EVM helpers against a local anvil chain running MockTgbp, a test double
 * with tGBP's decimals, pause, ban list and custom errors.
 */
import {
  type Address,
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { foundry, sepolia } from 'viem/chains'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  type EvmTokenDeployment,
  getBalance,
  type IncomingTransfer,
  toTgbpKitError,
  transfer,
  watchIncomingTransfers,
} from '../src/evm/index.js'
import { parseAmount } from '../src/index.js'
import { startAnvil } from './anvil.js'
import { mockTgbpAbi, mockTgbpBytecode } from './fixtures/mock-tgbp.js'

const SOLANA_ADDRESS = '2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW'
const ONE = parseAmount('1', 18)

let anvil: Awaited<ReturnType<typeof startAnvil>>
let publicClient: PublicClient
let alice: WalletClient
let aliceAddress: Address
let bob: Address
let carol: Address
let token: EvmTokenDeployment

beforeAll(async () => {
  anvil = await startAnvil()
  const transport = http(anvil.url)
  publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 100 })
  // anvil's dev accounts are unlocked, so a JSON-RPC account needs no key in this repo.
  const [first, second, third] = await createWalletClient({
    chain: foundry,
    transport,
  }).getAddresses()
  if (!first || !second || !third) throw new Error('anvil returned no accounts')
  aliceAddress = first
  bob = second
  carol = third
  alice = createWalletClient({ chain: foundry, transport, account: aliceAddress })
})

afterAll(() => anvil?.stop())

beforeEach(async () => {
  const hash = await alice.deployContract({
    abi: mockTgbpAbi,
    bytecode: mockTgbpBytecode,
    account: aliceAddress,
    chain: foundry,
  })
  const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash })
  if (!contractAddress) throw new Error('MockTgbp did not deploy')
  token = {
    chain: 'anvil',
    family: 'evm',
    network: 'testnet',
    status: 'live',
    symbol: 'tGBP',
    decimals: 18,
    chainId: foundry.id,
    address: contractAddress,
    explorerUrl: '',
  }
  await admin('mint', [aliceAddress, 10n * ONE])
})

async function admin(
  functionName: 'mint' | 'setPaused' | 'setBanned',
  args: readonly unknown[],
): Promise<void> {
  const hash = await alice.writeContract({
    address: token.address,
    abi: mockTgbpAbi,
    functionName,
    args,
    account: aliceAddress,
    chain: foundry,
  } as never)
  await publicClient.waitForTransactionReceipt({ hash })
}

describe('getBalance', () => {
  it('reads the balance in base units', async () => {
    expect(await getBalance({ publicClient, chain: token, owner: aliceAddress })).toEqual({
      amount: 10n * ONE,
      decimals: 18,
    })
  })
})

describe('transfer', () => {
  it('moves tGBP and returns the mined receipt', async () => {
    const { receipt } = await transfer({
      publicClient,
      walletClient: alice,
      chain: token,
      to: bob,
      amount: 3n * ONE,
    })
    expect(receipt.status).toBe('success')
    expect((await getBalance({ publicClient, chain: token, owner: bob })).amount).toBe(3n * ONE)
  })

  it('throws TOKEN_PAUSED when the token is paused', async () => {
    await admin('setPaused', [true])
    await expect(
      transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: ONE }),
    ).rejects.toMatchObject({ code: 'TOKEN_PAUSED' })
  })

  it('throws ADDRESS_BANNED when the recipient is banned', async () => {
    await admin('setBanned', [bob, true])
    await expect(
      transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: ONE }),
    ).rejects.toMatchObject({ code: 'ADDRESS_BANNED', details: { address: bob } })
  })

  it('throws ADDRESS_BANNED when the sender is banned', async () => {
    await admin('setBanned', [aliceAddress, true])
    await expect(
      transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: ONE }),
    ).rejects.toMatchObject({ code: 'ADDRESS_BANNED', details: { address: aliceAddress } })
  })

  it('throws INSUFFICIENT_BALANCE when the sender holds too little', async () => {
    await expect(
      transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: 11n * ONE }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { balance: 10n * ONE, needed: 11n * ONE },
    })
  })

  it('throws WRONG_CHAIN_ADDRESS for a Solana recipient', async () => {
    await expect(
      transfer({
        publicClient,
        walletClient: alice,
        chain: token,
        to: SOLANA_ADDRESS,
        amount: ONE,
      }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN_ADDRESS' })
  })

  it('throws WRONG_CHAIN_ADDRESS for a mixed-case address with a bad checksum', async () => {
    const at = bob.slice(2).search(/[a-fA-F]/) + 2
    const flipped =
      bob[at] === bob[at]?.toUpperCase() ? bob[at]?.toLowerCase() : bob[at]?.toUpperCase()
    const badChecksum = `${bob.slice(0, at)}${flipped}${bob.slice(at + 1)}`
    expect(badChecksum.toLowerCase()).toBe(bob.toLowerCase())
    await expect(
      transfer({ publicClient, walletClient: alice, chain: token, to: badChecksum, amount: ONE }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN_ADDRESS' })
  })

  it('throws WRONG_CHAIN_ADDRESS when the wallet is on another chain', async () => {
    const wrongChain = { ...token, chain: 'sepolia', chainId: sepolia.id }
    await expect(
      transfer({ publicClient, walletClient: alice, chain: wrongChain, to: bob, amount: ONE }),
    ).rejects.toMatchObject({
      code: 'WRONG_CHAIN_ADDRESS',
      details: { expectedChainId: sepolia.id, actualChainId: foundry.id },
    })
  })

  it('refuses a zero amount', async () => {
    await expect(
      transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: 0n }),
    ).rejects.toThrow(RangeError)
  })

  it('refuses a number amount', async () => {
    await expect(
      transfer({
        publicClient,
        walletClient: alice,
        chain: token,
        to: bob,
        amount: 1 as unknown as bigint,
      }),
    ).rejects.toThrow(TypeError)
  })
})

describe('toTgbpKitError decodes on-chain reverts', () => {
  // The preflight reads catch these before signing; a state change between
  // the read and the transaction still reverts, and must decode the same way.
  async function revertOf(amount: bigint): Promise<unknown> {
    try {
      await publicClient.simulateContract({
        account: aliceAddress,
        address: token.address,
        abi: mockTgbpAbi,
        functionName: 'transfer',
        args: [bob, amount],
      })
    } catch (error) {
      return error
    }
    throw new Error('expected a revert')
  }

  it('maps EnforcedPause to TOKEN_PAUSED', async () => {
    await admin('setPaused', [true])
    expect(toTgbpKitError(await revertOf(ONE), token)?.code).toBe('TOKEN_PAUSED')
  })

  it('maps AccountBanned to ADDRESS_BANNED', async () => {
    await admin('setBanned', [aliceAddress, true])
    expect(toTgbpKitError(await revertOf(ONE), token)?.code).toBe('ADDRESS_BANNED')
  })

  it('maps ERC20InsufficientBalance to INSUFFICIENT_BALANCE with the amounts', async () => {
    expect(toTgbpKitError(await revertOf(11n * ONE), token)).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { address: aliceAddress, balance: 10n * ONE, needed: 11n * ONE },
    })
  })

  it('returns undefined for errors it cannot name', () => {
    expect(toTgbpKitError(new Error('boom'), token)).toBeUndefined()
  })
})

describe('watchIncomingTransfers', () => {
  it('reports each transfer to the watched address', async () => {
    const seen: IncomingTransfer[] = []
    const stop = watchIncomingTransfers({
      publicClient,
      chain: token,
      to: bob,
      pollingInterval: 100,
      onTransfer: (t) => seen.push(t),
    })
    try {
      await transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: ONE })
      await transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: 2n * ONE })
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(2)
      expect(seen.map((t) => t.amount)).toEqual([ONE, 2n * ONE])
      expect(seen[0]).toMatchObject({ from: aliceAddress, to: bob, removed: false })
    } finally {
      stop()
    }
  })

  it('ignores transfers to other addresses', async () => {
    const seen: IncomingTransfer[] = []
    const stop = watchIncomingTransfers({
      publicClient,
      chain: token,
      to: bob,
      pollingInterval: 100,
      onTransfer: (t) => seen.push(t),
    })
    try {
      await admin('mint', [aliceAddress, ONE])
      await transfer({ publicClient, walletClient: alice, chain: token, to: carol, amount: ONE })
      await transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: ONE })
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1)
      // Give a stray event for the mint or carol's transfer time to arrive.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(seen).toHaveLength(1)
      expect(seen[0]?.to).toBe(bob)
    } finally {
      stop()
    }
  })

  it('reports a wrong-chain client to onError and watches nothing', async () => {
    const seen: IncomingTransfer[] = []
    const errors: Error[] = []
    const stop = watchIncomingTransfers({
      publicClient,
      chain: { ...token, chain: 'sepolia', chainId: sepolia.id },
      to: bob,
      pollingInterval: 100,
      onTransfer: (t) => seen.push(t),
      onError: (error) => errors.push(error),
    })
    try {
      await expect.poll(() => errors.length, { timeout: 10_000 }).toBe(1)
      expect(errors[0]).toMatchObject({ code: 'WRONG_CHAIN_ADDRESS' })
      await transfer({ publicClient, walletClient: alice, chain: token, to: bob, amount: ONE })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(seen).toHaveLength(0)
    } finally {
      stop()
    }
  })
})
