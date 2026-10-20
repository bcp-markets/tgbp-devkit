/**
 * Solana helpers against an in-memory RPC that serves SPL token accounts for
 * the registry's devnet tGBP mint. Transactions are built and signed for real;
 * only the network is faked.
 */

import {
  type Address,
  generateKeyPairSigner,
  getBase64Decoder,
  none,
  type Rpc,
  type RpcSubscriptions,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SolanaError,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from '@solana/kit'
import {
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTokenEncoder,
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { beforeEach, describe, expect, it } from 'vitest'
import { getSolanaToken, parseAmount } from '../src/index.js'
import {
  getBalance,
  type IncomingSolanaTransfer,
  prepareTransfer,
  toTgbpKitError,
  transfer,
  watchIncomingTransfers,
} from '../src/solana/index.js'

const token = getSolanaToken('solana-devnet')
const mint = token.address as Address
const ONE = parseAmount('1', 9)
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address

interface FakeAccount {
  owner: Address
  data: Uint8Array
}

let accounts: Map<Address, FakeAccount>
let slot: bigint
let alice: TransactionSigner
let bob: TransactionSigner

const rpc = {
  getAccountInfo: (address: Address) => ({
    send: async () => {
      const account = accounts.get(address)
      return {
        context: { slot },
        value: account
          ? {
              owner: account.owner,
              data: [getBase64Decoder().decode(account.data), 'base64'],
              executable: false,
              lamports: 2_039_280n,
              rentEpoch: 0n,
              space: BigInt(account.data.length),
            }
          : null,
      }
    },
  }),
  getLatestBlockhash: () => ({
    send: async () => ({
      context: { slot },
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n },
    }),
  }),
  // Only `transfer` reaches these: the send fails like a dropped connection would.
  sendTransaction: () => ({
    send: async () => {
      throw new Error('socket hang up')
    },
  }),
  getEpochInfo: () => ({
    send: async () => ({ absoluteSlot: slot, blockHeight: 1n }),
  }),
  getSignatureStatuses: () => ({
    send: async () => ({ context: { slot }, value: [null] }),
  }),
} as unknown as Rpc<SolanaRpcApi>

const noSubscriptions = {} as RpcSubscriptions<SolanaRpcSubscriptionsApi>

async function ata(owner: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  return pda
}

function tokenAccountData(owner: Address, amount: bigint, state = AccountState.Initialized) {
  return new Uint8Array(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: none(),
      state,
      isNative: none(),
      delegatedAmount: 0n,
      closeAuthority: none(),
    }),
  )
}

async function fund(owner: Address, amount: bigint, state = AccountState.Initialized) {
  accounts.set(await ata(owner), {
    owner: TOKEN_PROGRAM_ADDRESS,
    data: tokenAccountData(owner, amount, state),
  })
}

beforeEach(async () => {
  accounts = new Map()
  slot = 100n
  alice = await generateKeyPairSigner()
  bob = await generateKeyPairSigner()
  await fund(alice.address, 10n * ONE)
})

describe('getBalance', () => {
  it('reads the associated token account', async () => {
    expect(await getBalance({ rpc, chain: 'solana-devnet', owner: alice.address })).toEqual({
      amount: 10n * ONE,
      decimals: 9,
      tokenAccount: await ata(alice.address),
    })
  })

  it('reports zero when the owner has no token account yet', async () => {
    expect((await getBalance({ rpc, chain: 'solana-devnet', owner: bob.address })).amount).toBe(0n)
  })
})

describe('prepareTransfer', () => {
  it('creates the recipient token account, then transfers with checked decimals', async () => {
    const prepared = await prepareTransfer({
      rpc,
      signer: alice,
      chain: 'solana-devnet',
      to: bob.address,
      amount: 3n * ONE,
    })
    expect(prepared.instructions.map((i) => i.programAddress)).toEqual([
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS,
    ])
    const parsed = parseTransferCheckedInstruction(
      prepared.instructions[1] as Parameters<typeof parseTransferCheckedInstruction>[0],
    )
    expect(parsed.data).toMatchObject({ amount: 3n * ONE, decimals: 9 })
    expect(parsed.accounts.source.address).toBe(await ata(alice.address))
    expect(parsed.accounts.destination.address).toBe(await ata(bob.address))
    expect(parsed.accounts.mint.address).toBe(mint)
    expect(prepared.signature).toEqual(expect.any(String))
  })

  it('skips account creation when the recipient already has one', async () => {
    await fund(bob.address, 0n)
    const prepared = await prepareTransfer({
      rpc,
      signer: alice,
      chain: 'solana-devnet',
      to: bob.address,
      amount: ONE,
    })
    expect(prepared.instructions.map((i) => i.programAddress)).toEqual([TOKEN_PROGRAM_ADDRESS])
  })

  it('throws INSUFFICIENT_BALANCE when the sender holds too little', async () => {
    await expect(
      prepareTransfer({ rpc, signer: alice, chain: token, to: bob.address, amount: 11n * ONE }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { balance: 10n * ONE, needed: 11n * ONE },
    })
  })

  it('throws INSUFFICIENT_BALANCE when the sender has no token account', async () => {
    await expect(
      prepareTransfer({ rpc, signer: bob, chain: token, to: alice.address, amount: ONE }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', details: { balance: 0n } })
  })

  it('throws ADDRESS_BANNED when the sender account is frozen', async () => {
    await fund(alice.address, 10n * ONE, AccountState.Frozen)
    await expect(
      prepareTransfer({ rpc, signer: alice, chain: token, to: bob.address, amount: ONE }),
    ).rejects.toMatchObject({ code: 'ADDRESS_BANNED', details: { address: alice.address } })
  })

  it('throws ADDRESS_BANNED when the recipient account is frozen', async () => {
    await fund(bob.address, 0n, AccountState.Frozen)
    await expect(
      prepareTransfer({ rpc, signer: alice, chain: token, to: bob.address, amount: ONE }),
    ).rejects.toMatchObject({ code: 'ADDRESS_BANNED', details: { address: bob.address } })
  })

  it('throws WRONG_CHAIN_ADDRESS for an EVM recipient', async () => {
    await expect(
      prepareTransfer({
        rpc,
        signer: alice,
        chain: token,
        to: '0x27f6c8289550fCE67f6B50BeD1F519966aFE5287',
        amount: ONE,
      }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN_ADDRESS' })
  })

  it('throws WRONG_CHAIN_ADDRESS when the recipient is a token account, not a wallet', async () => {
    await fund(bob.address, 0n)
    await expect(
      prepareTransfer({
        rpc,
        signer: alice,
        chain: token,
        to: await ata(bob.address),
        amount: ONE,
      }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN_ADDRESS' })
  })

  it('throws WRONG_CHAIN_ADDRESS when the recipient is the mint', async () => {
    await expect(
      prepareTransfer({ rpc, signer: alice, chain: token, to: mint, amount: ONE }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN_ADDRESS', details: { address: mint } })
  })

  it('throws WRONG_CHAIN_ADDRESS when the recipient is a Token-2022 account', async () => {
    accounts.set(bob.address, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: new Uint8Array(165) })
    await expect(
      prepareTransfer({ rpc, signer: alice, chain: token, to: bob.address, amount: ONE }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN_ADDRESS', details: { address: bob.address } })
  })

  it('refuses a number amount', async () => {
    await expect(
      prepareTransfer({
        rpc,
        signer: alice,
        chain: token,
        to: bob.address,
        amount: 1 as unknown as bigint,
      }),
    ).rejects.toThrow(TypeError)
  })
})

describe('transfer', () => {
  it('fails before sending when a preflight check fails', async () => {
    await expect(
      transfer({
        rpc,
        rpcSubscriptions: noSubscriptions,
        signer: alice,
        chain: token,
        to: bob.address,
        amount: 11n * ONE,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
  })

  it('throws TRANSFER_UNCONFIRMED with the signature when sending fails', async () => {
    const params = { rpc, signer: alice, chain: token, to: bob.address, amount: ONE }
    // Signing is deterministic (ed25519, same blockhash), so this is the signature transfer() sends.
    const { signature } = await prepareTransfer(params)
    const error = await transfer({ ...params, rpcSubscriptions: noSubscriptions }).catch(
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'TRANSFER_UNCONFIRMED', details: { signature } })
    expect((error as Error).cause).toMatchObject({ message: 'socket hang up' })
  })
})

describe('toTgbpKitError', () => {
  const instructions = [
    { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
    { programAddress: TOKEN_PROGRAM_ADDRESS },
  ]
  const tokenError = (code: number) =>
    new Error('Transaction simulation failed', {
      cause: new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code, index: 1 }),
    })

  it('maps the token program InsufficientFunds error to INSUFFICIENT_BALANCE', () => {
    expect(toTgbpKitError(tokenError(1), instructions, token)?.code).toBe('INSUFFICIENT_BALANCE')
  })

  it('maps the token program AccountFrozen error to ADDRESS_BANNED', () => {
    expect(toTgbpKitError(tokenError(17), instructions, token)?.code).toBe('ADDRESS_BANNED')
  })

  it('attaches the signature to a named error', () => {
    const signature = 'sig' as Parameters<typeof toTgbpKitError>[3]
    expect(toTgbpKitError(tokenError(1), instructions, token, signature)).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { signature },
    })
  })

  it('stops walking a cyclic cause chain', () => {
    const cyclic = new Error('loop') as Error & { cause?: unknown }
    cyclic.cause = cyclic
    expect(toTgbpKitError(cyclic, instructions, token)).toBeUndefined()
  })

  it('returns undefined for errors it cannot name', () => {
    expect(toTgbpKitError(tokenError(4), instructions, token)).toBeUndefined()
    expect(toTgbpKitError(new Error('timeout'), instructions, token)).toBeUndefined()
  })
})

type Notification = {
  context: { slot: bigint }
  value: { data: [string, 'base64'] } | null
}

/** An account subscription the test feeds by hand; `end()` closes the stream. */
function fakeSubscriptions() {
  const queue: Notification[] = []
  let ended = false
  let wake: (() => void) | undefined
  const rpcSubscriptions = {
    accountNotifications: () => ({
      subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!abortSignal.aborted) {
            const next = queue.shift()
            if (next) yield next
            else if (ended) return
            else await new Promise<void>((resolve) => (wake = resolve))
          }
        },
      }),
    }),
  } as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>
  return {
    rpcSubscriptions,
    push(atSlot: bigint, amount: bigint | null) {
      queue.push({
        context: { slot: atSlot },
        value:
          amount === null
            ? null
            : {
                data: [
                  getBase64Decoder().decode(tokenAccountData(alice.address, amount)),
                  'base64',
                ],
              },
      })
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
  }
}

describe('watchIncomingTransfers', () => {
  it('reports balance increases after the baseline and ignores decreases', async () => {
    const feed = fakeSubscriptions()
    const seen: IncomingSolanaTransfer[] = []
    const stop = watchIncomingTransfers({
      rpc,
      rpcSubscriptions: feed.rpcSubscriptions,
      chain: token,
      owner: alice.address,
      onTransfer: (t) => seen.push(t),
    })
    try {
      feed.push(100n, 10n * ONE) // at the baseline slot: already counted
      feed.push(101n, 12n * ONE) // +2
      feed.push(102n, 7n * ONE) // outgoing
      feed.push(103n, 8n * ONE) // +1
      await expect.poll(() => seen.length).toBe(2)
      expect(seen).toEqual([
        { amount: 2n * ONE, balance: 12n * ONE, slot: 101n },
        { amount: ONE, balance: 8n * ONE, slot: 103n },
      ])
    } finally {
      stop()
      feed.end()
    }
  })

  it('treats a closed account as a zero balance', async () => {
    const feed = fakeSubscriptions()
    const seen: IncomingSolanaTransfer[] = []
    const errors: unknown[] = []
    const stop = watchIncomingTransfers({
      rpc,
      rpcSubscriptions: feed.rpcSubscriptions,
      chain: token,
      owner: alice.address,
      onTransfer: (t) => seen.push(t),
      onError: (e) => errors.push(e),
    })
    try {
      feed.push(101n, null) // closed
      feed.push(102n, 3n * ONE) // reopened and funded: +3 from zero
      await expect.poll(() => seen.length).toBe(1)
      expect(seen).toEqual([{ amount: 3n * ONE, balance: 3n * ONE, slot: 102n }])
      expect(errors).toEqual([])
    } finally {
      stop()
      feed.end()
    }
  })

  it('keeps watching when onTransfer throws', async () => {
    const feed = fakeSubscriptions()
    const seen: IncomingSolanaTransfer[] = []
    const errors: unknown[] = []
    const stop = watchIncomingTransfers({
      rpc,
      rpcSubscriptions: feed.rpcSubscriptions,
      chain: token,
      owner: alice.address,
      onTransfer: (t) => {
        seen.push(t)
        if (seen.length === 1) throw new Error('handler failed')
      },
      onError: (e) => errors.push(e),
    })
    try {
      feed.push(101n, 11n * ONE)
      feed.push(102n, 12n * ONE)
      await expect.poll(() => seen.length).toBe(2)
      expect(errors).toEqual([expect.objectContaining({ message: 'handler failed' })])
    } finally {
      stop()
      feed.end()
    }
  })

  it('reports WATCHER_STOPPED when the stream ends', async () => {
    const feed = fakeSubscriptions()
    const errors: unknown[] = []
    const stop = watchIncomingTransfers({
      rpc,
      rpcSubscriptions: feed.rpcSubscriptions,
      chain: token,
      owner: alice.address,
      onTransfer: () => {},
      onError: (e) => errors.push(e),
    })
    try {
      feed.end()
      await expect.poll(() => errors.length).toBe(1)
      expect(errors[0]).toMatchObject({ code: 'WATCHER_STOPPED' })
    } finally {
      stop()
    }
  })
})
