/**
 * Every failure the kit can explain gets a code, so callers can branch on it
 * instead of parsing a revert string or a Solana program error number.
 */
export type TgbpErrorCode =
  /** The token contract is paused on this chain; no transfer can move. */
  | 'TOKEN_PAUSED'
  /** The sender or the recipient is banned (EVM) or has a frozen token account (Solana). */
  | 'ADDRESS_BANNED'
  /** The address is not valid on this chain, or the wallet is connected to a different chain. */
  | 'WRONG_CHAIN_ADDRESS'
  /** The sender holds less tGBP than the amount requested. */
  | 'INSUFFICIENT_BALANCE'
  /** The chain is not in the tGBP token registry. */
  | 'UNKNOWN_CHAIN'
  /**
   * The transfer was broadcast but its confirmation failed or timed out. `details` carries
   * `hash` (EVM) or `signature` (Solana): check that id on chain before retrying, because a
   * retry may pay twice.
   */
  | 'TRANSFER_UNCONFIRMED'
  /** The EVM transaction was mined but reverted. `details.hash` names it. */
  | 'TRANSFER_REVERTED'
  /** A watcher's stream ended or failed; restart it to keep receiving transfers. */
  | 'WATCHER_STOPPED'

export class TgbpKitError extends Error {
  readonly code: TgbpErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: TgbpErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'TgbpKitError'
    this.code = code
    this.details = options.details ?? {}
  }
}

export function isTgbpKitError(error: unknown, code?: TgbpErrorCode): error is TgbpKitError {
  return error instanceof TgbpKitError && (code === undefined || error.code === code)
}
