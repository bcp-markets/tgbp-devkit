// Chain-agnostic entry point. EVM helpers live in `@tgbp/kit/evm` (needs viem),
// Solana helpers in `@tgbp/kit/solana` (needs @solana/kit and @solana-program/token),
// so an app pulls in only the chain library it uses.
export { formatAmount, parseAmount } from './amount.js'
export { isTgbpKitError, type TgbpErrorCode, TgbpKitError } from './errors.js'
export * from './registry/index.js'
