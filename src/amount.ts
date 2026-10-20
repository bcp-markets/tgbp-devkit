/**
 * Conversions between a decimal string ("12.50") and base units (bigint).
 *
 * tGBP has 18 decimals on EVM chains and 9 on Solana, so the same pound amount
 * is a different integer on each. Every helper in this kit takes base units;
 * use these two functions at the edge of your app.
 */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/

/**
 * Parse a non-negative decimal string into base units. Throws rather than
 * rounding when the string has more fractional digits than the token has
 * decimals: silently dropping digits would move a different amount than the
 * one the user typed.
 */
export function parseAmount(value: string, decimals: number): bigint {
  assertDecimals(decimals)
  const match = DECIMAL.exec(value.trim())
  if (!match) throw new RangeError(`Not a non-negative decimal amount: "${value}"`)
  const [, whole = '0', fraction = ''] = match
  if (fraction.length > decimals) {
    throw new RangeError(
      `"${value}" has ${fraction.length} decimal places; this token has ${decimals}`,
    )
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}

/** Format base units as a decimal string with no trailing zeros ("12.5"). */
export function formatAmount(baseUnits: bigint, decimals: number): string {
  assertDecimals(decimals)
  const negative = baseUnits < 0n
  const abs = negative ? -baseUnits : baseUnits
  const scale = 10n ** BigInt(decimals)
  const whole = abs / scale
  const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`Invalid decimals: ${decimals}`)
  }
}
