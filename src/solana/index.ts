import {
  type Address,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  type Commitment,
  createTransactionMessage,
  getBase64Encoder,
  getSignatureFromTransaction,
  type Instruction,
  isAddress,
  pipe,
  type Rpc,
  type RpcSubscriptions,
  type SendableTransaction,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Transaction,
  type TransactionSigner,
  type TransactionWithBlockhashLifetime,
} from '@solana/kit'
import {
  AccountState,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
  isTokenError,
  TOKEN_ERROR__ACCOUNT_FROZEN,
  TOKEN_ERROR__INSUFFICIENT_FUNDS,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'

import { TgbpKitError } from '../errors.js'
import {
  getSolanaToken,
  type SolanaChainKey,
  type SolanaTokenDeployment,
} from '../registry/index.js'

export type { SolanaTokenDeployment } from '../registry/index.js'

/** A registry chain key, or a deployment object for a cluster the registry does not list (a local validator). */
export type SolanaTokenTarget = SolanaChainKey | SolanaTokenDeployment

// The Token-2022 program id. `@solana-program/token-2022` is not a dependency, so it is spelled out.
const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address

export interface SolanaBalance {
  /** Base units (9 decimals). */
  amount: bigint
  decimals: number
  /** The owner's associated token account. It may not exist yet, in which case `amount` is 0. */
  tokenAccount: Address
}

export interface GetSolanaBalanceParams {
  rpc: Rpc<SolanaRpcApi>
  chain: SolanaTokenTarget
  /** Wallet address (not a token account). */
  owner: string
  commitment?: Commitment
}

export async function getBalance({
  rpc,
  chain,
  owner,
  commitment = 'confirmed',
}: GetSolanaBalanceParams): Promise<SolanaBalance> {
  const token = resolveToken(chain)
  const tokenAccount = await associatedTokenAccount(token, toSolanaAddress(owner, token))
  const { account } = await readTokenAccount(rpc, tokenAccount, commitment)
  return { amount: account?.amount ?? 0n, decimals: token.decimals, tokenAccount }
}

export interface SolanaTransferParams {
  rpc: Rpc<SolanaRpcApi>
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>
  /** Owns the tGBP being sent and pays the fee, plus rent if the recipient has no token account yet. */
  signer: TransactionSigner
  chain: SolanaTokenTarget
  /**
   * Recipient wallet address. A token account, a program or the mint is refused: the kit would
   * derive an associated token account for it, and no one holds the private key of that address,
   * so the tokens would be unrecoverable.
   */
  to: string
  /** Base units. Use `parseAmount('12.50', 9)` to convert. */
  amount: bigint
  commitment?: Commitment
}

export interface PreparedSolanaTransfer {
  transaction: SendableTransaction & Transaction & TransactionWithBlockhashLifetime
  instructions: readonly Instruction[]
  signature: Signature
  /** Sender's associated token account. */
  source: Address
  /** Recipient's associated token account. */
  destination: Address
}

/**
 * Checks balances and freeze state, then builds and signs the transfer
 * without sending it. It creates the recipient's associated token account in
 * the same transaction when it does not exist yet.
 */
export async function prepareTransfer({
  rpc,
  signer,
  chain,
  to,
  amount,
  commitment = 'confirmed',
}: Omit<SolanaTransferParams, 'rpcSubscriptions'>): Promise<PreparedSolanaTransfer> {
  const token = resolveToken(chain)
  const recipient = toSolanaAddress(to, token)
  if (typeof amount !== 'bigint') throw new TypeError('amount must be a bigint in base units')
  if (amount <= 0n) throw new RangeError('amount must be greater than zero')

  if (recipient === token.address) {
    throw new TgbpKitError(
      'WRONG_CHAIN_ADDRESS',
      `${recipient} is the tGBP mint; pass the recipient's wallet address instead`,
      { details: { chain: token.chain, address: recipient } },
    )
  }
  const recipientInfo = await rpc
    .getAccountInfo(recipient, { commitment, encoding: 'base64' })
    .send()
  const recipientOwner = recipientInfo.value?.owner
  if (recipientOwner === TOKEN_PROGRAM_ADDRESS || recipientOwner === TOKEN_2022_PROGRAM_ADDRESS) {
    throw new TgbpKitError(
      'WRONG_CHAIN_ADDRESS',
      `${recipient} is a token account; pass the recipient's wallet address instead`,
      { details: { chain: token.chain, address: recipient } },
    )
  }
  // Other program-owned accounts (a multisig vault PDA) can own a token account; a program cannot.
  if (recipientInfo.value?.executable) {
    throw new TgbpKitError(
      'WRONG_CHAIN_ADDRESS',
      `${recipient} is a program; pass the recipient's wallet address instead`,
      { details: { chain: token.chain, address: recipient } },
    )
  }

  const [source, destination] = await Promise.all([
    associatedTokenAccount(token, signer.address),
    associatedTokenAccount(token, recipient),
  ])
  const [sourceState, destinationState] = await Promise.all([
    readTokenAccount(rpc, source, commitment),
    readTokenAccount(rpc, destination, commitment),
  ])

  if (sourceState.account?.state === AccountState.Frozen) {
    throw bannedError(token, signer.address)
  }
  if (destinationState.account?.state === AccountState.Frozen) {
    throw bannedError(token, recipient)
  }
  const balance = sourceState.account?.amount ?? 0n
  if (balance < amount) throw insufficientError(token, signer.address, balance, amount)

  const instructions = [
    ...(destinationState.account
      ? []
      : [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: signer,
            ata: destination,
            owner: recipient,
            mint: token.address as Address,
          }),
        ]),
    getTransferCheckedInstruction({
      source,
      mint: token.address as Address,
      destination,
      authority: signer,
      amount,
      decimals: token.decimals,
    }),
  ]

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = await signTransactionMessageWithSigners(message)
  assertIsSendableTransaction(transaction)
  assertIsTransactionWithBlockhashLifetime(transaction)
  return {
    transaction,
    instructions,
    signature: getSignatureFromTransaction(transaction),
    source,
    destination,
  }
}

/**
 * Send tGBP and wait for confirmation. Preflight failures throw a
 * `TgbpKitError` before anything is signed; a token-program error from the
 * network is mapped to the same codes. Any other send or confirmation failure
 * throws `TRANSFER_UNCONFIRMED` with `details.signature`: check that signature
 * before retrying, because the transaction may still land and a retry may pay twice.
 */
export async function transfer(params: SolanaTransferParams): Promise<{ signature: Signature }> {
  const token = resolveToken(params.chain)
  const commitment = params.commitment ?? 'confirmed'
  const { transaction, instructions, signature } = await prepareTransfer({
    ...params,
    chain: token,
  })
  try {
    await sendAndConfirmTransactionFactory({
      rpc: params.rpc,
      rpcSubscriptions: params.rpcSubscriptions,
    })(transaction, { commitment })
  } catch (error) {
    throw (
      toTgbpKitError(error, instructions, token, signature) ??
      new TgbpKitError(
        'TRANSFER_UNCONFIRMED',
        `tGBP transfer ${signature} was signed on ${token.chain} but not confirmed; check this signature before retrying, a retry may pay twice`,
        { cause: error, details: { chain: token.chain, signature } },
      )
    )
  }
  return { signature }
}

export interface IncomingSolanaTransfer {
  /** Increase in the token account balance, in base units. */
  amount: bigint
  /** Balance after the increase, in base units. */
  balance: bigint
  slot: bigint
}

export interface WatchSolanaTransfersParams {
  rpc: Rpc<SolanaRpcApi>
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>
  chain: SolanaTokenTarget
  /** Wallet address to watch. */
  owner: string
  onTransfer: (transfer: IncomingSolanaTransfer) => void
  /** Defaults to `console.error`; a watcher error is never silent. */
  onError?: (error: unknown) => void
  /** Defaults to `confirmed`. */
  commitment?: Commitment
}

/**
 * Calls `onTransfer` each time the owner's tGBP token account balance goes
 * up, measured from a baseline read when the watcher starts. It reports net
 * increases per notification: an incoming and an outgoing transfer in the
 * same slot net out, and a mint counts as an increase. Account notifications
 * carry no sender; look the transaction up by slot if you need it.
 *
 * If the subscription stream ends, `onError` gets `WATCHER_STOPPED`; restart
 * the watcher and re-read the balance. Returns a function that stops watching.
 */
export function watchIncomingTransfers({
  rpc,
  rpcSubscriptions,
  chain,
  owner,
  onTransfer,
  onError,
  commitment = 'confirmed',
}: WatchSolanaTransfersParams): () => void {
  const token = resolveToken(chain)
  const wallet = toSolanaAddress(owner, token)
  const abort = new AbortController()
  const report = (error: unknown) => {
    if (!onError) {
      console.error('tGBP watcher error', error)
      return
    }
    try {
      onError(error)
    } catch (thrown) {
      console.error('tGBP watcher onError threw', thrown)
    }
  }

  void (async () => {
    try {
      const tokenAccount = await associatedTokenAccount(token, wallet)
      // Subscribe before the baseline read so no change can fall between them;
      // notifications at or before the baseline slot are already counted in it.
      const notifications = await rpcSubscriptions
        .accountNotifications(tokenAccount, { commitment, encoding: 'base64' })
        .subscribe({ abortSignal: abort.signal })
      const baseline = await readTokenAccount(rpc, tokenAccount, commitment)
      let last = baseline.account?.amount ?? 0n
      for await (const notification of notifications) {
        if (notification.context.slot <= baseline.slot) continue
        // A closed account notifies with no value or empty data: its balance is 0.
        const data = (notification.value as { data?: readonly [string, string] } | null)?.data?.[0]
        const balance = data ? decodeTokenAmount(data) : 0n
        if (balance > last) {
          try {
            onTransfer({ amount: balance - last, balance, slot: notification.context.slot })
          } catch (error) {
            report(error)
          }
        }
        last = balance
      }
      if (!abort.signal.aborted) {
        report(
          new TgbpKitError(
            'WATCHER_STOPPED',
            'tGBP watcher stream ended; restart it and re-read the balance',
            { details: { chain: token.chain, owner: wallet } },
          ),
        )
      }
    } catch (error) {
      if (!abort.signal.aborted) report(error)
    } finally {
      // Always release the subscription, whichever way the loop ended.
      abort.abort()
    }
  })()

  return () => abort.abort()
}

/**
 * Map a send error for a tGBP transfer to a `TgbpKitError`, or return
 * undefined when the error is not one the kit can name.
 */
export function toTgbpKitError(
  error: unknown,
  instructions: readonly Instruction[],
  token: SolanaTokenDeployment,
  signature?: Signature,
): TgbpKitError | undefined {
  const message = { instructions }
  const extra = signature ? { signature } : {}
  // Cap the walk: a cyclic or very deep cause chain must not hang the caller.
  let e: unknown = error
  for (let hops = 0; e && hops < 10; hops++, e = (e as { cause?: unknown }).cause) {
    if (isTokenError(e, message, TOKEN_ERROR__INSUFFICIENT_FUNDS)) {
      return insufficientError(token, undefined, undefined, undefined, error, extra)
    }
    if (isTokenError(e, message, TOKEN_ERROR__ACCOUNT_FROZEN)) {
      return bannedError(token, undefined, error, extra)
    }
  }
  return undefined
}

function resolveToken(chain: SolanaTokenTarget): SolanaTokenDeployment {
  return typeof chain === 'string' ? getSolanaToken(chain) : chain
}

function toSolanaAddress(value: string, token: SolanaTokenDeployment): Address {
  if (!isAddress(value)) {
    throw new TgbpKitError(
      'WRONG_CHAIN_ADDRESS',
      `"${value}" is not a Solana address, so it cannot hold tGBP on ${token.chain}`,
      { details: { chain: token.chain, address: value } },
    )
  }
  return value
}

async function associatedTokenAccount(
  token: SolanaTokenDeployment,
  owner: Address,
): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({
    owner,
    mint: token.address as Address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  return pda
}

async function readTokenAccount(rpc: Rpc<SolanaRpcApi>, address: Address, commitment: Commitment) {
  const { context, value } = await rpc
    .getAccountInfo(address, { commitment, encoding: 'base64' })
    .send()
  const account = value ? getTokenDecoder().decode(getBase64Encoder().encode(value.data[0])) : null
  return { slot: context.slot, account }
}

function decodeTokenAmount(base64: string): bigint {
  return getTokenDecoder().decode(getBase64Encoder().encode(base64)).amount
}

function bannedError(
  token: SolanaTokenDeployment,
  address?: Address,
  cause?: unknown,
  extra: Record<string, unknown> = {},
) {
  const who = address ? `${address}'s tGBP account is` : 'A tGBP account in this transfer is'
  return new TgbpKitError('ADDRESS_BANNED', `${who} frozen on ${token.chain}`, {
    cause,
    details: { chain: token.chain, ...(address ? { address } : {}), ...extra },
  })
}

function insufficientError(
  token: SolanaTokenDeployment,
  address: Address | undefined,
  balance: bigint | undefined,
  needed: bigint | undefined,
  cause?: unknown,
  extra: Record<string, unknown> = {},
) {
  const known = balance !== undefined && needed !== undefined
  return new TgbpKitError(
    'INSUFFICIENT_BALANCE',
    known
      ? `Insufficient tGBP on ${token.chain}: balance ${balance}, needed ${needed}`
      : `Insufficient tGBP on ${token.chain}`,
    { cause, details: { chain: token.chain, address, balance, needed, ...extra } },
  )
}
