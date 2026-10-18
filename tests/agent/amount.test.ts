import { describe, expect, it } from 'vitest'

import { AmountError, fromBaseUnits, parseBaseUnits, toBaseUnits } from '../../agent/amount.ts'

describe('toBaseUnits', () => {
  it('converts without losing precision', () => {
    expect(toBaseUnits('0.50', 6)).toBe(500000n)
    expect(toBaseUnits('1', 6)).toBe(1000000n)
    expect(toBaseUnits('0.000001', 6)).toBe(1n)
    expect(toBaseUnits('1234.567890', 6)).toBe(1234567890n)
  })

  it('refuses more decimals than the token has — no silent rounding', () => {
    expect(() => toBaseUnits('0.1234567', 6)).toThrow(AmountError)
    expect(() => toBaseUnits('0.1234567', 6)).toThrow(/7 decimals/)
  })

  it('refuses anything that is not a plain decimal amount', () => {
    for (const bad of ['1e-3', '-1', '0x10', '1,50', '', ' ', 'NaN', 'Infinity'])
      expect(() => toBaseUnits(bad, 6), bad).toThrow(AmountError)
  })

  it('never goes through a float', () => {
    // 0.1 + 0.2 as floats gives 0.30000000000000004.
    expect(toBaseUnits('0.1', 6) + toBaseUnits('0.2', 6)).toBe(toBaseUnits('0.3', 6))
  })
})

describe('fromBaseUnits', () => {
  it('round-trips', () => {
    for (const human of ['0.5', '1', '0.000001', '1234.56789'])
      expect(fromBaseUnits(toBaseUnits(human, 6), 6)).toBe(human)
  })

  it('formats zero and integers without a stray decimal', () => {
    expect(fromBaseUnits(0n, 6)).toBe('0')
    expect(fromBaseUnits(1000000n, 6)).toBe('1')
  })
})

describe('parseBaseUnits', () => {
  it('accepts a string of digits', () => {
    expect(parseBaseUnits('500000')).toBe(500000n)
  })

  it('refuses everything else — fail-closed', () => {
    for (const bad of [500000, null, undefined, '', '-1', '0.5', '1n', ' 500000 ', {}])
      expect(() => parseBaseUnits(bad), JSON.stringify(bad)).toThrow(AmountError)
  })
})
