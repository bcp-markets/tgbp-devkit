/**
 * What an agent can do with tGBP: read a balance, send, mint, redeem and
 * swap. Each action validates its input, then asks the spend guard, and only
 * then calls the API or signs. A refusal therefore costs nothing.
 *
 * On-chain actions run on EVM chains.
 */
import { type Hex, isAddress, type PublicClient, type WalletClient } from 'viem'

import { formatAmount, parseAmount } from '../amount.js'
import type { CreateResult, Mint, Redemption, TgbpClient } from '../api/client.js'
import type { Conversion, TgbpSwapClient } from '../api/swap.js'
import { isTgbpKitError, TgbpKitError } from '../errors.js'
import { getBalance, transfer } from '../evm/index.js'
import { type EvmTokenDeployment, getEvmToken, getToken } from '../registry/index.js'
import type { SpendGuard } from './guard.js'
import type { SubmissionJournal, SubmissionTool } from './submissions.js'

export interface EvmClients {
  publicClient: PublicClient
  /** Must carry the agent's account. */
  walletClient: WalletClient
}

export interface AgentActionsOptions {
  guard: SpendGuard
  /** Needed for mint and redeem. */
  api?: TgbpClient
  /** Needed for swap. */
  swap?: TgbpSwapClient
  /** Returns the clients for a chain. Needed for balance, transfer and redeem. */
  evm?: (token: EvmTokenDeployment) => EvmClients
  /**
   * Saves each mint, redemption and swap's idempotency key before it is sent,
   * so a retry after a crash resends the same key and the API dedupes it.
   */
  submissions?: SubmissionJournal
}

export interface MintParams {
  chain: string
  destinationAddress: string
  amount: string
  customerId?: string
  idempotencyKey?: string
}

export interface RedeemParams {
  chain: string
  bankId: string
  amount: string
  reference?: string
}

export interface SwapParams {
  chain: string
  direction: SwapDirection
  amount: string
  recipient: string
  minOut?: string
  idempotencyKey?: string
}

export type RedeemResult =
  | { redemption: CreateResult<Redemption>; burned: false }
  | { redemption: CreateResult<Redemption>; burned: true; burnHash: Hex }

/** An authorised action whose key is saved and which has sent nothing yet. */
export interface Prepared<T> {
  /** The key `submit` sends; undefined when there is no journal and no key was passed. */
  idempotencyKey: string | undefined
  /**
   * Sends the action. It runs once: a second call throws, because the guard
   * authorised one action. With `holdOpen`, a submission that succeeds stays
   * open in the journal until `release`, so a retry before its result reaches
   * the caller resends the same key.
   */
  submit(options?: { holdOpen?: boolean }): Promise<T>
  /** Closes what `submit({ holdOpen: true })` left open. Call it once the result is delivered. */
  release(): Promise<void>
}

export type SwapDirection = 'USDC_TO_TGBP' | 'TGBP_TO_USDC'

/** The API takes GBP to the penny. */
const GBP_DECIMALS = 2
const USDC_DECIMALS = 6
/** The chains the swap API serves (its ChainId). */
const SWAP_CHAINS = ['base', 'sepolia'] as const

export function createAgentActions(options: AgentActionsOptions) {
  const { guard, submissions } = options

  function evmClients(token: EvmTokenDeployment): EvmClients {
    if (!options.evm) throw new Error('No EVM wallet is configured')
    return options.evm(token)
  }

  function requireApi(): TgbpClient {
    if (!options.api) throw new Error('No tGBP API key is configured; set TGBP_API_KEY')
    return options.api
  }

  return {
    /** The tGBP balance of `owner`, or of the agent's own wallet. */
    async balance(params: { chain: string; owner?: string }) {
      const token = getEvmToken(params.chain)
      await guard.authorize({ action: 'balance', chain: token.chain })
      const { publicClient, walletClient } = evmClients(token)
      const owner = params.owner ?? walletClient.account?.address
      if (!owner) throw new Error('Pass an owner, or configure a wallet with an account')
      const { amount, decimals } = await getBalance({ publicClient, chain: token, owner })
      return { chain: token.chain, owner, amount: formatAmount(amount, decimals) }
    },

    /** Send tGBP from the agent's wallet. `amount` is a decimal string. */
    async transfer(params: { chain: string; to: string; amount: string }) {
      const token = getEvmToken(params.chain)
      const baseUnits = parseAmount(params.amount, token.decimals)
      const amount = formatAmount(baseUnits, token.decimals)
      const clients = evmClients(token)
      await guard.authorize({
        action: 'transfer',
        chain: token.chain,
        destination: params.to,
        amount,
      })
      const { hash } = await transfer({
        ...clients,
        chain: token,
        to: params.to,
        amount: baseUnits,
      })
      return { chain: token.chain, to: params.to, amount, hash }
    },

    /**
     * Create a mint: tGBP goes to `destinationAddress` once the bank transfer
     * arrives. Pass back the `idempotencyKey` of an earlier attempt to retry it
     * without creating a second mint.
     */
    mint: async (params: MintParams) => (await prepareMint(params)).submit(),

    /**
     * Create a redemption, then burn the tGBP by sending it to the
     * redemption's burn address. GBP is paid to `bankId` once the burn
     * confirms. Nothing is burned unless the API's redemption matches the
     * request: its chain, amount and bank account.
     */
    redeem: async (params: RedeemParams) => (await prepareRedeem(params)).submit(),

    /**
     * Convert a confirmed swap deposit and settle it to `recipient`. `amount`
     * is the source amount: tGBP for TGBP_TO_USDC, USDC for USDC_TO_TGBP.
     * Pass back the `idempotencyKey` of an earlier attempt to retry it.
     */
    swap: async (params: SwapParams) => (await prepareSwap(params)).submit(),

    /**
     * The same actions in two steps. Each validates, asks the spend guard and
     * saves its idempotency key, then returns; nothing is sent until `submit`.
     * An approval the guard needs is therefore settled before anything is sent.
     */
    prepare: { mint: prepareMint, redeem: prepareRedeem, swap: prepareSwap },
  }

  /** The key to send: saved to the journal first, if there is one. */
  async function openSubmission(
    tool: SubmissionTool,
    inputs: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ): Promise<string | undefined> {
    if (!submissions) return idempotencyKey
    return (await submissions.open(tool, inputs, idempotencyKey)).idempotencyKey
  }

  /**
   * Closes a submission whose answer arrived. A failure to close never hides
   * that answer: the submission stays open, and the next request with the
   * same inputs gets the first record back, marked `replayed`.
   */
  async function closeSubmission(
    tool: SubmissionTool,
    inputs: Record<string, unknown>,
    idempotencyKey: string | undefined,
    stage: 'submitted' | 'burning' = 'submitted',
  ): Promise<void> {
    if (!submissions || !idempotencyKey) return
    try {
      await submissions.close(tool, inputs, idempotencyKey, stage)
    } catch (error) {
      console.error(
        `tgbp: could not close the ${stage} ${tool} with idempotency key ${idempotencyKey} ` +
          `in ${submissions.path}; it stays open: ${String(error)}`,
      )
    }
  }

  /**
   * Wraps `run` as a single-use `Prepared`. `run` passes each close that
   * follows a success to `succeeded`, which holds it for `release` when asked.
   */
  function prepared<T>(
    idempotencyKey: string | undefined,
    run: (succeeded: (close: () => Promise<void>) => Promise<void>) => Promise<T>,
  ): Prepared<T> {
    let used = false
    let held: (() => Promise<void>) | undefined
    return {
      idempotencyKey,
      async submit(submitOptions = {}) {
        if (used) throw new Error('This action was already submitted; prepare it again')
        used = true
        return run(async (close) => {
          if (submitOptions.holdOpen) held = close
          else await close()
        })
      },
      async release() {
        const close = held
        held = undefined
        await close?.()
      },
    }
  }

  /** A key goes in the create options; without one the API client generates its own. */
  function keyOptions(idempotencyKey: string | undefined): { idempotencyKey?: string } {
    return idempotencyKey ? { idempotencyKey } : {}
  }

  async function prepareMint(params: MintParams): Promise<Prepared<CreateResult<Mint>>> {
    const api = requireApi()
    const token = getToken(params.chain)
    const { amount, value } = gbp(params.amount)
    await guard.authorize({
      action: 'mint',
      chain: token.chain,
      destination: params.destinationAddress,
      amount,
    })
    const inputs = {
      chain: token.chain,
      destinationAddress: evmLower(params.destinationAddress),
      amount,
      customerId: params.customerId || undefined,
    }
    const idempotencyKey = await openSubmission('mint', inputs, params.idempotencyKey)
    return prepared(idempotencyKey, async (succeeded) => {
      const result = await api.mints.create(
        {
          chain: token.chain,
          destinationAddress: params.destinationAddress,
          amount: { currency: 'GBP', value },
          ...(params.customerId ? { customerId: params.customerId } : {}),
        },
        keyOptions(idempotencyKey),
      )
      await succeeded(() => closeSubmission('mint', inputs, idempotencyKey))
      return result
    })
  }

  async function prepareRedeem(params: RedeemParams): Promise<Prepared<RedeemResult>> {
    const api = requireApi()
    const token = getEvmToken(params.chain)
    const { amount, value } = gbp(params.amount)
    const baseUnits = parseAmount(amount, token.decimals)
    const clients = evmClients(token)
    const inputs = {
      chain: token.chain,
      bankId: params.bankId,
      amount,
      reference: params.reference || undefined,
    }
    // Refused before the guard counts it or asks a human: its burn may already have been sent.
    await submissions?.assertNotBurning(inputs)
    await guard.authorize({
      action: 'redeem',
      chain: token.chain,
      destination: params.bankId,
      amount,
    })
    const idempotencyKey = await openSubmission('redeem', inputs, undefined)
    const body = {
      chain: token.chain,
      bankId: params.bankId,
      amount: { currency: 'GBP' as const, value },
      ...(params.reference ? { reference: params.reference } : {}),
    }
    return prepared(idempotencyKey, async (succeeded): Promise<RedeemResult> => {
      const created = idempotencyKey
        ? await api.redemptions.create(body, { idempotencyKey })
        : await api.redemptions.create(body)
      // A second approver must act first; nothing is burned, and the spend stays counted.
      if (created.status === 'pending_approval') {
        await succeeded(() => closeSubmission('redeem', inputs, idempotencyKey))
        return { redemption: created, burned: false }
      }
      let redemption: Redemption = created.data
      try {
        // A replay returns the record as it was created; the burn needs its state now.
        if (created.status === 'replayed') {
          redemption = (await api.redemptions.get(redemption.redemptionId)).data
        }
      } catch (error) {
        throw notBurned(error, redemption.redemptionId, idempotencyKey)
      }
      try {
        assertRedemptionMatches(redemption, token, params.bankId, amount)
      } catch (error) {
        // The API's current record is final: a retry would only read it again.
        await closeSubmission('redeem', inputs, idempotencyKey)
        throw notBurned(error, redemption.redemptionId, idempotencyKey)
      }
      // Recorded before the burn is sent, so a retry after a crash never burns a second time.
      // A refusal here means another attempt holds the record and may be burning: never wrap it
      // as "nothing was burned", or the agent might cancel a redemption being burned.
      if (submissions && idempotencyKey) {
        await submissions.burning(
          inputs,
          idempotencyKey,
          redemption.redemptionId,
          redemption.burnAddress,
        )
      }
      let hash: Hex
      try {
        ;({ hash } = await transfer({
          ...clients,
          chain: token,
          to: redemption.burnAddress,
          amount: baseUnits,
        }))
      } catch (error) {
        const failed = burnFailed(error, redemption.redemptionId, idempotencyKey)
        // Only a burn known to have moved nothing may be retried; any other stays recorded as sent.
        if (isTgbpKitError(error) && NOT_BURNED.has(error.code)) {
          await closeSubmission('redeem', inputs, idempotencyKey, 'burning')
        }
        throw failed
      }
      // On disk before the result is held for its reader: an unread burn stays refused, by hash.
      if (submissions && idempotencyKey) {
        await submissions.burnSent(inputs, idempotencyKey, hash).catch((error: unknown) => {
          console.error(
            `tgbp: could not record burn ${hash} in ${submissions.path}: ${String(error)}`,
          )
        })
      }
      await succeeded(() => closeSubmission('redeem', inputs, idempotencyKey, 'burning'))
      return { redemption: created, burned: true, burnHash: hash }
    })
  }

  async function prepareSwap(
    params: SwapParams,
  ): Promise<Prepared<{ data: Conversion; idempotencyKey: string }>> {
    const swap = options.swap
    if (!swap) throw new Error('No swap API is configured; set TGBP_API_KEY and TGBP_SWAP_BASE_URL')
    const chain = getEvmToken(params.chain).chain
    const swapChain = SWAP_CHAINS.find((c) => c === chain)
    if (!swapChain) {
      throw new TgbpKitError('UNKNOWN_CHAIN', `The swap API does not serve "${chain}"`, {
        details: { chain, supported: SWAP_CHAINS },
      })
    }
    if (!isAddress(params.recipient)) {
      throw new TgbpKitError('WRONG_CHAIN_ADDRESS', `"${params.recipient}" is not an EVM address`, {
        details: { chain, address: params.recipient },
      })
    }
    const decimals = params.direction === 'USDC_TO_TGBP' ? USDC_DECIMALS : 18
    const amount = formatAmount(parseAmount(params.amount, decimals), decimals)
    // Caps are in pounds. A USDC amount counts as the same number of pounds,
    // which overstates it while a dollar is worth less than a pound.
    await guard.authorize({
      action: 'swap',
      chain,
      destination: params.recipient,
      amount,
    })
    const inputs = {
      chain,
      direction: params.direction,
      amount,
      recipient: params.recipient.toLowerCase(),
      minOut: params.minOut || undefined,
    }
    const idempotencyKey = await openSubmission('swap', inputs, params.idempotencyKey)
    const amountField = params.direction === 'USDC_TO_TGBP' ? 'usdcAmount' : 'tgbpAmount'
    return prepared(idempotencyKey, async (succeeded) => {
      const result = await swap.createConversion(
        {
          chainId: swapChain,
          direction: params.direction,
          recipientAddress: params.recipient,
          [amountField]: amount,
          ...(params.minOut ? { minOut: params.minOut } : {}),
        },
        keyOptions(idempotencyKey),
      )
      await succeeded(() => closeSubmission('swap', inputs, idempotencyKey))
      return result
    })
  }
}

export type AgentActions = ReturnType<typeof createAgentActions>

/** A GBP amount as its canonical string and the number the API takes. */
function gbp(input: string): { amount: string; value: number } {
  const pence = parseAmount(input, GBP_DECIMALS)
  if (pence > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`"${input}" is too large`)
  const amount = formatAmount(pence, GBP_DECIMALS)
  return { amount, value: Number(amount) }
}

function assertRedemptionMatches(
  redemption: Redemption,
  token: EvmTokenDeployment,
  bankId: string,
  amount: string,
): void {
  const mismatch = (field: string) =>
    new Error(
      `Redemption ${redemption.redemptionId} does not match the request (${field}); nothing was burned. Cancel it.`,
    )
  // A redemption in any other state will never pay out, so a burn would destroy the tGBP.
  if (redemption.status !== 'pending') throw mismatch(`status ${redemption.status}`)
  if (redemption.chain !== token.chain) throw mismatch('chain')
  if (redemption.bankAccount?.id !== bankId) throw mismatch('bank')
  let returned: bigint
  try {
    returned = parseAmount(redemption.amount.amount, 18)
  } catch {
    throw mismatch('amount')
  }
  if (returned !== parseAmount(amount, 18)) throw mismatch('amount')
  if (!isAddress(redemption.burnAddress)) throw mismatch('burn address')
}

/** An EVM address hashes the same in any letter case; any other address is case-sensitive. */
function evmLower(address: string): string {
  return isAddress(address) ? address.toLowerCase() : address
}

/** Failures raised before the burn was broadcast, or by a mined revert: no tGBP moved. */
const NOT_BURNED = new Set<string>([
  'INSUFFICIENT_BALANCE',
  'ADDRESS_BANNED',
  'TOKEN_PAUSED',
  'WRONG_CHAIN_ADDRESS',
  'UNKNOWN_CHAIN',
  'TRANSFER_REVERTED',
])

/**
 * A failure after the redemption was created and before its burn was sent:
 * nothing was burned. Keeps the original code and adds the redemption id.
 */
function notBurned(
  error: unknown,
  redemptionId: string,
  idempotencyKey: string | undefined,
): Error {
  const kit = isTgbpKitError(error) ? error : undefined
  const message = `Redemption ${redemptionId} was created but nothing was burned. ${reasonOf(error)}`
  const details = { redemptionId, ...(idempotencyKey ? { idempotencyKey } : {}) }
  return kit
    ? new TgbpKitError(kit.code, message, { cause: error, details: { ...kit.details, ...details } })
    : new Error(message, { cause: error })
}

function reasonOf(error: unknown): string {
  return (
    (isTgbpKitError(error) ? error.message : undefined) ??
    ((error as { shortMessage?: unknown }).shortMessage as string | undefined) ??
    (error instanceof Error ? error.message : String(error))
  )
}

/**
 * Keep the original code, and add the redemption id the caller needs to
 * recover. Only a failure known to have moved nothing says so; any other may
 * have burned already, and a second burn would destroy the tGBP twice.
 */
function burnFailed(
  error: unknown,
  redemptionId: string,
  idempotencyKey: string | undefined,
): Error {
  const kit = isTgbpKitError(error) ? error : undefined
  const advice =
    kit && NOT_BURNED.has(kit.code)
      ? 'nothing was burned; fix the cause and burn again, or cancel it'
      : 'the burn may have been sent; check the transaction and the burn address before you burn again or cancel'
  const message = `Redemption ${redemptionId} was created but its burn did not complete: ${advice}. ${reasonOf(error)}`
  return kit
    ? new TgbpKitError(kit.code, message, {
        cause: error,
        details: { ...kit.details, redemptionId, ...(idempotencyKey ? { idempotencyKey } : {}) },
      })
    : new Error(message, { cause: error })
}
