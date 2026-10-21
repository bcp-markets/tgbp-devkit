/**
 * What an agent can do with tGBP: read a balance, send, mint, redeem and
 * swap. Each action validates its input, then asks the spend guard, and only
 * then calls the API or signs. A refusal therefore costs nothing.
 *
 * On-chain actions run on EVM chains.
 */
import { isAddress, type PublicClient, type WalletClient } from 'viem'

import { formatAmount, parseAmount } from '../amount.js'
import type { CreateResult, Mint, Redemption, TgbpClient } from '../api/client.js'
import type { Conversion, TgbpSwapClient } from '../api/swap.js'
import { isTgbpKitError, TgbpKitError } from '../errors.js'
import { getBalance, transfer } from '../evm/index.js'
import { type EvmTokenDeployment, getEvmToken, getToken } from '../registry/index.js'
import type { SpendGuard } from './guard.js'

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
}

export type SwapDirection = 'USDC_TO_TGBP' | 'TGBP_TO_USDC'

/** The API takes GBP to the penny. */
const GBP_DECIMALS = 2
const USDC_DECIMALS = 6
/** The chains the swap API serves (its ChainId). */
const SWAP_CHAINS = ['base', 'sepolia'] as const

export function createAgentActions(options: AgentActionsOptions) {
  const { guard } = options

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
    async mint(params: {
      chain: string
      destinationAddress: string
      amount: string
      customerId?: string
      idempotencyKey?: string
    }): Promise<CreateResult<Mint>> {
      const api = requireApi()
      const token = getToken(params.chain)
      const { amount, value } = gbp(params.amount)
      await guard.authorize({
        action: 'mint',
        chain: token.chain,
        destination: params.destinationAddress,
        amount,
      })
      return api.mints.create(
        {
          chain: token.chain,
          destinationAddress: params.destinationAddress,
          amount: { currency: 'GBP', value },
          ...(params.customerId ? { customerId: params.customerId } : {}),
        },
        params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {},
      )
    },

    /**
     * Create a redemption, then burn the tGBP by sending it to the
     * redemption's burn address. GBP is paid to `bankId` once the burn
     * confirms. Nothing is burned unless the API's redemption matches the
     * request: its chain, amount and bank account.
     */
    async redeem(params: { chain: string; bankId: string; amount: string; reference?: string }) {
      const api = requireApi()
      const token = getEvmToken(params.chain)
      const { amount, value } = gbp(params.amount)
      const baseUnits = parseAmount(amount, token.decimals)
      const clients = evmClients(token)
      await guard.authorize({
        action: 'redeem',
        chain: token.chain,
        destination: params.bankId,
        amount,
      })
      const created = await api.redemptions.create({
        chain: token.chain,
        bankId: params.bankId,
        amount: { currency: 'GBP', value },
        ...(params.reference ? { reference: params.reference } : {}),
      })
      // A second approver must act first; nothing is burned, and the spend stays counted.
      if (created.status === 'pending_approval') return { redemption: created, burned: false }
      const redemption: Redemption = created.data
      assertRedemptionMatches(redemption, token, params.bankId, amount)
      try {
        const { hash } = await transfer({
          ...clients,
          chain: token,
          to: redemption.burnAddress,
          amount: baseUnits,
        })
        return { redemption: created, burned: true, burnHash: hash }
      } catch (error) {
        throw burnFailed(error, redemption.redemptionId)
      }
    },

    /**
     * Convert a confirmed swap deposit and settle it to `recipient`. `amount`
     * is the source amount: tGBP for TGBP_TO_USDC, USDC for USDC_TO_TGBP.
     * Pass back the `idempotencyKey` of an earlier attempt to retry it.
     */
    async swap(params: {
      chain: string
      direction: SwapDirection
      amount: string
      recipient: string
      minOut?: string
      idempotencyKey?: string
    }): Promise<{ data: Conversion; idempotencyKey: string }> {
      if (!options.swap)
        throw new Error('No swap API is configured; set TGBP_API_KEY and TGBP_SWAP_BASE_URL')
      const chain = getEvmToken(params.chain).chain
      const swapChain = SWAP_CHAINS.find((c) => c === chain)
      if (!swapChain) {
        throw new TgbpKitError('UNKNOWN_CHAIN', `The swap API does not serve "${chain}"`, {
          details: { chain, supported: SWAP_CHAINS },
        })
      }
      if (!isAddress(params.recipient)) {
        throw new TgbpKitError(
          'WRONG_CHAIN_ADDRESS',
          `"${params.recipient}" is not an EVM address`,
          {
            details: { chain, address: params.recipient },
          },
        )
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
      const amountField = params.direction === 'USDC_TO_TGBP' ? 'usdcAmount' : 'tgbpAmount'
      return options.swap.createConversion(
        {
          chainId: swapChain,
          direction: params.direction,
          recipientAddress: params.recipient,
          [amountField]: amount,
          ...(params.minOut ? { minOut: params.minOut } : {}),
        },
        params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {},
      )
    },
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
 * Keep the original code, and add the redemption id the caller needs to
 * recover. Only a failure known to have moved nothing says so; any other may
 * have burned already, and a second burn would destroy the tGBP twice.
 */
function burnFailed(error: unknown, redemptionId: string): Error {
  const kit = isTgbpKitError(error) ? error : undefined
  const advice =
    kit && NOT_BURNED.has(kit.code)
      ? 'nothing was burned; fix the cause and burn again, or cancel it'
      : 'the burn may have been sent; check the transaction and the burn address before you burn again or cancel'
  const reason =
    kit?.message ??
    ((error as { shortMessage?: unknown }).shortMessage as string | undefined) ??
    (error instanceof Error ? error.message : String(error))
  const message = `Redemption ${redemptionId} was created but its burn did not complete: ${advice}. ${reason}`
  return kit
    ? new TgbpKitError(kit.code, message, {
        cause: error,
        details: { ...kit.details, redemptionId },
      })
    : new Error(message, { cause: error })
}
