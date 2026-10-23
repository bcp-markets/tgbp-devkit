import type { EvmTokenDeployment } from '../registry/index.js'

/**
 * tGBP on Base Sepolia, the chain the x402 helpers target. The generated
 * registry skips this proxy, because the tGBP contracts repo flags it as an
 * anomaly for cross-chain onboarding. Its implementation bytecode was compared
 * with Base mainnet's: it differs only in the LayerZero endpoint address,
 * which transfers, permits and ban checks do not read.
 */
export const TGBP_BASE_SEPOLIA: EvmTokenDeployment = {
  chain: 'base-sepolia',
  family: 'evm',
  network: 'testnet',
  status: 'live',
  symbol: 'tGBP',
  decimals: 18,
  chainId: 84532,
  address: '0x27f6c8289550fCE67f6B50BeD1F519966aFE5287',
  explorerUrl: 'https://sepolia.basescan.org',
}

/**
 * tGBP's EIP-712 domain for EIP-2612 permits, as the token's `eip712Domain()`
 * returns it on Base Sepolia.
 */
export const TGBP_EIP712_DOMAIN = { name: 'tGBP', version: '1' } as const

/**
 * The public x402 facilitator. Its `/supported` list includes the exact
 * scheme on Base Sepolia and the `eip2612GasSponsoring` extension.
 */
export const X402_ORG_FACILITATOR_URL = 'https://x402.org/facilitator'

/**
 * The longest a signed payment may stay valid. The server sets the window
 * (`maxTimeoutSeconds`); the server helper refuses a longer one, and the
 * client refuses to sign one, so a signature cannot settle days later.
 */
export const MAX_PAYMENT_WINDOW_SECONDS = 600

/** The x402 (CAIP-2) network id for a token's chain, e.g. `eip155:84532`. */
export function x402Network(token: EvmTokenDeployment): `eip155:${number}` {
  return `eip155:${token.chainId}`
}

/**
 * Converts whole pence to tGBP base units. 1p is 10^(decimals - 2) base
 * units, so 5p on an 18-decimal chain is 5 * 10^16.
 */
export function penceToBaseUnits(pence: number | bigint, token: EvmTokenDeployment): bigint {
  if (token.decimals < 2) {
    throw new RangeError(`tGBP on ${token.chain} has ${token.decimals} decimals; pence need 2`)
  }
  if (typeof pence === 'number' && !Number.isSafeInteger(pence)) {
    throw new RangeError(`pence must be a whole number, got ${pence}`)
  }
  const amount = BigInt(pence)
  if (amount <= 0n) throw new RangeError('pence must be greater than zero')
  return amount * 10n ** BigInt(token.decimals - 2)
}
