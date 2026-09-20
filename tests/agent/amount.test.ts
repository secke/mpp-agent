import { describe, expect, it } from 'vitest'

import { AmountError, fromBaseUnits, parseBaseUnits, toBaseUnits } from '../../agent/amount.ts'

describe('toBaseUnits', () => {
  it('convertit sans perdre de précision', () => {
    expect(toBaseUnits('0.50', 6)).toBe(500000n)
    expect(toBaseUnits('1', 6)).toBe(1000000n)
    expect(toBaseUnits('0.000001', 6)).toBe(1n)
    expect(toBaseUnits('1234.567890', 6)).toBe(1234567890n)
  })

  it('refuse plus de décimales que le jeton — pas d’arrondi silencieux', () => {
    expect(() => toBaseUnits('0.1234567', 6)).toThrow(AmountError)
    expect(() => toBaseUnits('0.1234567', 6)).toThrow(/7 décimales/)
  })

  it('refuse ce qui n’est pas un montant décimal simple', () => {
    for (const bad of ['1e-3', '-1', '0x10', '1,50', '', ' ', 'NaN', 'Infinity'])
      expect(() => toBaseUnits(bad, 6), bad).toThrow(AmountError)
  })

  it('ne passe jamais par un flottant', () => {
    // 0.1 + 0.2 en flottant donne 0.30000000000000004.
    expect(toBaseUnits('0.1', 6) + toBaseUnits('0.2', 6)).toBe(toBaseUnits('0.3', 6))
  })
})

describe('fromBaseUnits', () => {
  it('fait l’aller-retour', () => {
    for (const human of ['0.5', '1', '0.000001', '1234.56789'])
      expect(fromBaseUnits(toBaseUnits(human, 6), 6)).toBe(human)
  })

  it('formate zéro et les entiers sans décimale parasite', () => {
    expect(fromBaseUnits(0n, 6)).toBe('0')
    expect(fromBaseUnits(1000000n, 6)).toBe('1')
  })
})

describe('parseBaseUnits', () => {
  it('accepte une chaîne de chiffres', () => {
    expect(parseBaseUnits('500000')).toBe(500000n)
  })

  it('refuse tout le reste — fail-closed', () => {
    for (const bad of [500000, null, undefined, '', '-1', '0.5', '1n', ' 500000 ', {}])
      expect(() => parseBaseUnits(bad), JSON.stringify(bad)).toThrow(AmountError)
  })
})
