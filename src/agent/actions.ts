/**
 * What an agent can do with tGBP: read a balance, send, mint, redeem and
 * swap. Each action validates its input, then asks the spend guard, and only
 * then calls the API or signs. A refusal therefore costs nothing.
 *
 * On-chain actions run on EVM chains.
 */
import type { PublicClient, WalletClient } from 'viem'

import { formatAmount, parseAmount } from '../amount.js'
import type { CreateResult, Mint, Redemption, TgbpClient } from '../api/client.js'
import type { Conversion, TgbpSwapClient } from '../api/swap.js'
import { isTgbpKitError, TgbpKitError } from '../errors.js'
import { getBalance, transfer } from '../evm/index.js'
import { type EvmTokenDeployment, getEvmToken } from '../registry/index.js'
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

export function createAgentActions(options: AgentActionsOptions) {
  const { guard } = options

  function evmClients(token: EvmTokenDeployment): EvmClients {
    if (!options.evm) throw new Error('No EVM wallet is configured')
    return options.evm(token)
  }

  function requireApi(): TgbpClient {
    if (!options.api) throw new Error('No tGBP API key is configured')
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
      await guard.authorize({
        action: 'transfer',
        chain: token.chain,
        destination: params.to,
        amount: params.amount,
      })
      const { hash } = await transfer({
        ...evmClients(token),
        chain: token,
        to: params.to,
        amount: baseUnits,
      })
      return { chain: token.chain, to: params.to, amount: params.amount, hash }
    },

    /** Create a mint: tGBP goes to `destinationAddress` once the bank transfer arrives. */
    async mint(params: {
      chain: string
      destinationAddress: string
      amount: string
      customerId?: string
    }): Promise<CreateResult<Mint>> {
      const api = requireApi()
      const value = gbpValue(params.amount)
      await guard.authorize({
        action: 'mint',
        chain: params.chain,
        destination: params.destinationAddress,
        amount: params.amount,
      })
      return api.mints.create({
        chain: params.chain,
        destinationAddress: params.destinationAddress,
        amount: { currency: 'GBP', value },
        ...(params.customerId ? { customerId: params.customerId } : {}),
      })
    },

    /**
     * Create a redemption, then burn the tGBP by sending it to the
     * redemption's burn address. GBP is paid to `bankId` once the burn confirms.
     */
    async redeem(params: { chain: string; bankId: string; amount: string; reference?: string }) {
      const api = requireApi()
      const value = gbpValue(params.amount)
      const token = getEvmToken(params.chain)
      const baseUnits = parseAmount(params.amount, token.decimals)
      const clients = evmClients(token)
      await guard.authorize({
        action: 'redeem',
        chain: token.chain,
        destination: params.bankId,
        amount: params.amount,
      })
      const created = await api.redemptions.create({
        chain: token.chain,
        bankId: params.bankId,
        amount: { currency: 'GBP', value },
        ...(params.reference ? { reference: params.reference } : {}),
      })
      if (created.status === 'pending_approval') return { redemption: created }
      const redemption: Redemption = created.data
      try {
        const { hash } = await transfer({
          ...clients,
          chain: token,
          to: redemption.burnAddress,
          amount: baseUnits,
        })
        return { redemption: created, burnHash: hash }
      } catch (error) {
        throw burnFailed(error, redemption.redemptionId)
      }
    },

    /**
     * Convert a confirmed swap deposit and settle it to `recipient`. `amount`
     * is the source amount: tGBP for TGBP_TO_USDC, USDC for USDC_TO_TGBP.
     */
    async swap(params: {
      chain: string
      direction: SwapDirection
      amount: string
      recipient: string
      minOut?: string
    }): Promise<{ data: Conversion; idempotencyKey: string }> {
      if (!options.swap) throw new Error('No swap API is configured')
      // Caps are in pounds. A USDC amount counts as the same number of pounds,
      // which overstates it while a dollar is worth less than a pound.
      parseAmount(params.amount, params.direction === 'USDC_TO_TGBP' ? 6 : 18)
      await guard.authorize({
        action: 'swap',
        chain: params.chain,
        destination: params.recipient,
        amount: params.amount,
      })
      const amountField = params.direction === 'USDC_TO_TGBP' ? 'usdcAmount' : 'tgbpAmount'
      return options.swap.createConversion({
        chainId: params.chain as Parameters<TgbpSwapClient['createConversion']>[0]['chainId'],
        direction: params.direction,
        recipientAddress: params.recipient as `0x${string}`,
        [amountField]: params.amount,
        ...(params.minOut ? { minOut: params.minOut } : {}),
      })
    },
  }
}

export type AgentActions = ReturnType<typeof createAgentActions>

function gbpValue(amount: string): number {
  parseAmount(amount, GBP_DECIMALS)
  return Number(amount)
}

/** Keep the original code, and add the redemption id the caller needs to recover. */
function burnFailed(error: unknown, redemptionId: string): Error {
  const message = `Redemption ${redemptionId} was created but its burn failed; cancel it or send the burn again`
  if (isTgbpKitError(error)) {
    return new TgbpKitError(error.code, `${message}: ${error.message}`, {
      cause: error,
      details: { ...error.details, redemptionId },
    })
  }
  return new Error(message, { cause: error })
}
