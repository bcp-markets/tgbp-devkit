import { describe, expect, it } from 'vitest'

import { compare, snakeCase, tsOperations } from '../scripts/check-python-parity.js'
import { createTgbpClient } from '../src/api/index.js'

describe('Python parity check', () => {
  it('lists every TypeScript client operation by dotted path', () => {
    const ops = tsOperations(createTgbpClient({ apiKey: 'k', environment: 'sandbox' }))
    expect(ops).toContain('mints.simulatePayin')
    expect(ops).toContain('redemptions.confirmBurn')
    expect(ops).toHaveLength(11)
  })

  it('maps camelCase to snake_case', () => {
    expect(snakeCase('mints.simulatePayin')).toBe('mints.simulate_payin')
    expect(snakeCase('getSupportedNetworks')).toBe('get_supported_networks')
  })

  it('reports an operation missing from Python, and one only Python has', () => {
    expect(compare(['getQuote', 'getLimits'], ['get_quote', 'get_limits'])).toEqual([])
    expect(compare(['getQuote', 'getLimits'], ['get_quote', 'get_extra'])).toEqual([
      'missing in Python: get_limits',
      'only in Python: get_extra',
    ])
  })
})
