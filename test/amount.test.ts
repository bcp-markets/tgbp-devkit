import { describe, expect, it } from 'vitest'

import { formatAmount, parseAmount } from '../src/index.js'

describe('parseAmount', () => {
  it('converts a decimal string to base units', () => {
    expect(parseAmount('12.5', 18)).toBe(12_500_000_000_000_000_000n)
    expect(parseAmount('0.000000001', 9)).toBe(1n)
    expect(parseAmount('7', 9)).toBe(7_000_000_000n)
  })

  it('refuses to round away digits the token cannot hold', () => {
    expect(() => parseAmount('0.0000000001', 9)).toThrow(/10 decimal places; this token has 9/)
  })

  it('rejects decimals outside 0..36', () => {
    expect(() => parseAmount('1', -1)).toThrow(RangeError)
    expect(() => parseAmount('1', 37)).toThrow(RangeError)
  })

  it('rejects negative, empty and non-numeric input', () => {
    for (const bad of ['-1', '', '1e3', '1.', '.5', 'abc']) {
      expect(() => parseAmount(bad, 18), bad).toThrow(RangeError)
    }
  })
})

describe('formatAmount', () => {
  it('formats base units without trailing zeros', () => {
    expect(formatAmount(12_500_000_000_000_000_000n, 18)).toBe('12.5')
    expect(formatAmount(1n, 9)).toBe('0.000000001')
    expect(formatAmount(0n, 9)).toBe('0')
  })

  it('formats a negative amount', () => {
    expect(formatAmount(-1_500_000_000n, 9)).toBe('-1.5')
  })

  it('round-trips with parseAmount', () => {
    expect(formatAmount(parseAmount('1234.56789', 18), 18)).toBe('1234.56789')
  })
})
