import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'

import { TgbpKitError } from '../errors.js'
import type { EvmChainKey, EvmTokenDeployment } from '../registry/index.js'
import { tgbpAbi } from './abi.js'
import {
  assertCanTransfer,
  assertClientChain,
  bannedError,
  insufficientError,
  pausedError,
  resolveToken,
  toEvmAddress,
} from './checks.js'

export type { EvmTokenDeployment } from '../registry/index.js'
export { tgbpAbi }

/** A registry chain key, or a deployment object for a chain the registry does not list (a local fork). */
export type EvmTokenTarget = EvmChainKey | EvmTokenDeployment

export interface EvmBalance {
  /** Base units (18 decimals). */
  amount: bigint
  decimals: number
}

export interface GetEvmBalanceParams {
  publicClient: PublicClient
  chain: EvmTokenTarget
  owner: string
}

export async function getBalance({
  publicClient,
  chain,
  owner,
}: GetEvmBalanceParams): Promise<EvmBalance> {
  const token = resolveToken(chain)
  const account = toEvmAddress(owner, token)
  await assertClientChain(publicClient, token)
  const amount = await publicClient.readContract({
    address: token.address,
    abi: tgbpAbi,
    functionName: 'balanceOf',
    args: [account],
  })
  return { amount, decimals: token.decimals }
}

export interface EvmTransferParams {
  publicClient: PublicClient
  /** Must carry an account: `createWalletClient({ account, ... })`. */
  walletClient: WalletClient
  chain: EvmTokenTarget
  to: string
  /** Base units. Use `parseAmount('12.50', 18)` to convert. */
  amount: bigint
}

export interface EvmTransferResult {
  hash: Hash
  receipt: TransactionReceipt
}

/**
 * Send tGBP. Before signing, it reads pause state, both parties' ban status
 * and the sender's balance, so the common failures throw a `TgbpKitError`
 * without spending gas. A revert caught in simulation is decoded into the
 * same error codes.
 *
 * Once the transaction is broadcast, a failed or timed-out confirmation throws
 * `TRANSFER_UNCONFIRMED` and a mined revert throws `TRANSFER_REVERTED`; both
 * carry `details.hash`. Check that hash before retrying: a retry may pay twice.
 */
export async function transfer({
  publicClient,
  walletClient,
  chain,
  to,
  amount,
}: EvmTransferParams): Promise<EvmTransferResult> {
  const token = resolveToken(chain)
  const recipient = toEvmAddress(to, token)
  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account; create it with `account`')
  if (typeof amount !== 'bigint') throw new TypeError('amount must be a bigint in base units')
  if (amount <= 0n) throw new RangeError('amount must be greater than zero')

  await Promise.all([
    assertClientChain(publicClient, token),
    assertClientChain(walletClient, token),
  ])

  await assertCanTransfer(publicClient, token, account.address, recipient, amount)

  let hash: Hash
  try {
    const { request } = await publicClient.simulateContract({
      account,
      address: token.address,
      abi: tgbpAbi,
      functionName: 'transfer',
      args: [recipient, amount],
    })
    hash = await walletClient.writeContract(request)
  } catch (error) {
    throw toTgbpKitError(error, token) ?? error
  }

  let receipt: TransactionReceipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash })
  } catch (error) {
    throw new TgbpKitError(
      'TRANSFER_UNCONFIRMED',
      `tGBP transfer ${hash} was broadcast on ${token.chain} but not confirmed; check this hash before retrying, a retry may pay twice`,
      { cause: error, details: { chain: token.chain, hash } },
    )
  }
  if (receipt.status !== 'success') {
    throw new TgbpKitError(
      'TRANSFER_REVERTED',
      `tGBP transfer ${hash} reverted on ${token.chain}`,
      {
        details: { chain: token.chain, hash, receipt },
      },
    )
  }
  return { hash, receipt }
}

export interface IncomingTransfer {
  from: Address
  to: Address
  /** Base units. */
  amount: bigint
  transactionHash: Hash
  blockNumber: bigint
  logIndex: number
  /**
   * True when a chain reorganisation removed the log. A caller that already
   * credited this transfer must reverse the credit.
   */
  removed: boolean
}

export interface WatchEvmTransfersParams {
  publicClient: PublicClient
  chain: EvmTokenTarget
  /** Address to watch for incoming tGBP. */
  to: string
  onTransfer: (transfer: IncomingTransfer) => void
  /** Defaults to `console.error`; a watcher error is never silent. */
  onError?: (error: Error) => void
  pollingInterval?: number
}

/**
 * Calls `onTransfer` for every tGBP Transfer event to `to`, from the block
 * the watcher starts at. Returns a function that stops watching.
 *
 * It first checks that the client is on the token's chain (the same address
 * lives on several mainnets and testnets); a mismatch goes to `onError` and
 * nothing is watched. Events are reported at the chain head, not finalised:
 * wait for enough confirmations past `blockNumber` before crediting, and
 * reverse a credit when a transfer arrives again with `removed: true`.
 */
export function watchIncomingTransfers({
  publicClient,
  chain,
  to,
  onTransfer,
  onError,
  pollingInterval,
}: WatchEvmTransfersParams): () => void {
  const token = resolveToken(chain)
  const recipient = toEvmAddress(to, token)
  const reportError = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (!onError) {
      console.error('tGBP watcher error', err)
      return
    }
    try {
      onError(err)
    } catch (thrown) {
      console.error('tGBP watcher onError threw', thrown)
    }
  }

  let stopped = false
  let unwatch: (() => void) | undefined
  assertClientChain(publicClient, token).then(() => {
    if (stopped) return
    unwatch = publicClient.watchContractEvent({
      address: token.address,
      abi: tgbpAbi,
      eventName: 'Transfer',
      args: { to: recipient },
      ...(pollingInterval === undefined ? {} : { pollingInterval }),
      onError: reportError,
      onLogs: (logs) => {
        for (const log of logs) {
          const { from, to: logTo, value } = log.args
          // Pending logs carry no block or hash; the watcher reports mined transfers only.
          if (
            from === undefined ||
            logTo === undefined ||
            value === undefined ||
            log.transactionHash === null ||
            log.blockNumber === null ||
            log.logIndex === null
          ) {
            continue
          }
          try {
            onTransfer({
              from,
              to: logTo,
              amount: value,
              transactionHash: log.transactionHash,
              blockNumber: log.blockNumber,
              logIndex: log.logIndex,
              removed: log.removed,
            })
          } catch (error) {
            reportError(error)
          }
        }
      },
    })
  }, reportError)

  return () => {
    stopped = true
    unwatch?.()
  }
}

/**
 * Map a viem error from a tGBP call to a `TgbpKitError`, or return undefined
 * when the error is not one the kit can name.
 */
export function toTgbpKitError(
  error: unknown,
  token: EvmTokenDeployment,
): TgbpKitError | undefined {
  if (!(error instanceof BaseError)) return undefined
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined
  const { errorName, args } = reverted.data ?? {}
  switch (errorName) {
    case 'EnforcedPause':
      return pausedError(token, error)
    case 'AccountBanned':
      return bannedError(token, undefined, error)
    case 'ERC20InsufficientBalance': {
      const [sender, balance, needed] = (args ?? []) as [Address, bigint, bigint]
      return insufficientError(token, sender, balance, needed, error)
    }
    default:
      return undefined
  }
}
