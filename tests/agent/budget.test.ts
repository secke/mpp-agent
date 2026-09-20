import { Challenge } from 'mppx'
import { beforeEach, describe, expect, it } from 'vitest'

import { toBaseUnits } from '../../agent/amount.ts'
import { BudgetDenied, BudgetGuard, type BudgetLimits } from '../../agent/budget.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const USDC_MAINNET = '0x20C000000000000000000000b9537d11c60E8b50'

const LIMITS: BudgetLimits = {
  maxPerCall: toBaseUnits('1.00', 6),
  totalBudget: toBaseUnits('2.50', 6),
  chainId: TESTNET_CHAIN_ID,
  currency: PATH_USD,
  decimals: 6,
}

let n = 0
function challenge(
  overrides: {
    amount?: unknown
    currency?: string
    recipient?: string
    chainId?: unknown
    method?: string
    intent?: string
  } = {},
): Challenge.Challenge {
  return Challenge.from({
    id: `challenge-${++n}`,
    realm: 'api.test',
    method: overrides.method ?? 'tempo',
    intent: overrides.intent ?? 'charge',
    request: {
      amount: 'amount' in overrides ? overrides.amount : '500000',
      currency: overrides.currency ?? PATH_USD,
      recipient: overrides.recipient ?? RECIPIENT,
      methodDetails: {
        chainId: 'chainId' in overrides ? overrides.chainId : TESTNET_CHAIN_ID,
      },
    },
  }) as Challenge.Challenge
}

function denyCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof BudgetDenied) return error.code
    throw error
  }
  throw new Error('attendu : un refus, obtenu : une autorisation')
}

describe('BudgetGuard — autorisation nominale', () => {
  let guard: BudgetGuard
  beforeEach(() => {
    guard = new BudgetGuard(LIMITS)
  })

  it('autorise un Challenge conforme et engage le montant', () => {
    expect(guard.authorize(challenge())).toBe(500000n)
    expect(guard.reserved).toBe(500000n)
    expect(guard.committed).toBe(0n)
    expect(guard.remaining).toBe(toBaseUnits('2.00', 6))
  })

  it('ne réengage pas deux fois le même Challenge (retry)', () => {
    const c = challenge()
    guard.authorize(c)
    guard.authorize(c)
    expect(guard.reserved).toBe(500000n)
  })

  it('décompte la dépense une fois le paiement confirmé', () => {
    const c = challenge()
    guard.authorize(c)
    guard.settle(c.id)
    expect(guard.committed).toBe(500000n)
    expect(guard.reserved).toBe(0n)
    expect(guard.remaining).toBe(toBaseUnits('2.00', 6))
  })

  it('rend l’engagement quand le paiement échoue', () => {
    const c = challenge()
    guard.authorize(c)
    guard.release(c.id)
    expect(guard.committed).toBe(0n)
    expect(guard.remaining).toBe(LIMITS.totalBudget)
  })

  it('ignore un settle/release sur un Challenge inconnu', () => {
    expect(() => guard.settle('jamais-vu')).not.toThrow()
    expect(() => guard.release('jamais-vu')).not.toThrow()
    expect(guard.committed).toBe(0n)
  })
})

describe('BudgetGuard — plafonds', () => {
  let guard: BudgetGuard
  beforeEach(() => {
    guard = new BudgetGuard(LIMITS)
  })

  it('refuse au-dessus du plafond par appel', () => {
    expect(denyCode(() => guard.authorize(challenge({ amount: '1000001' })))).toBe('per-call-cap')
    expect(guard.reserved).toBe(0n) // rien d’engagé sur un refus
  })

  it('accepte pile au plafond par appel', () => {
    expect(() => guard.authorize(challenge({ amount: '1000000' }))).not.toThrow()
  })

  it('refuse quand l’enveloppe est épuisée', () => {
    for (const amount of ['1000000', '1000000']) {
      const c = challenge({ amount })
      guard.authorize(c)
      guard.settle(c.id)
    }
    expect(guard.committed).toBe(toBaseUnits('2.00', 6))
    expect(denyCode(() => guard.authorize(challenge({ amount: '600000' })))).toBe(
      'budget-exhausted',
    )
  })

  it('compte les engagements en cours, pas seulement le confirmé', () => {
    // Deux appels concurrents à 1.00 sur une enveloppe de 2.50 : le troisième
    // doit être refusé même si aucun n’est encore confirmé.
    guard.authorize(challenge({ amount: '1000000' }))
    guard.authorize(challenge({ amount: '1000000' }))
    expect(guard.remaining).toBe(toBaseUnits('0.50', 6))
    expect(denyCode(() => guard.authorize(challenge({ amount: '600000' })))).toBe(
      'budget-exhausted',
    )
  })
})

describe('BudgetGuard — fail-closed', () => {
  let guard: BudgetGuard
  beforeEach(() => {
    guard = new BudgetGuard(LIMITS)
  })

  it('refuse une chaîne inattendue (mainnet)', () => {
    expect(denyCode(() => guard.authorize(challenge({ chainId: 4217 })))).toBe('unexpected-chain')
  })

  it('refuse un Challenge sans chainId', () => {
    expect(denyCode(() => guard.authorize(challenge({ chainId: undefined })))).toBe(
      'unexpected-chain',
    )
  })

  it('refuse une devise inattendue', () => {
    expect(denyCode(() => guard.authorize(challenge({ currency: USDC_MAINNET })))).toBe(
      'unexpected-currency',
    )
  })

  it('refuse un montant illisible', () => {
    for (const amount of ['0.5', '-1', '', 'beaucoup', 500000])
      expect(denyCode(() => guard.authorize(challenge({ amount }))), String(amount)).toBe(
        'malformed-amount',
      )
  })

  it('refuse une méthode ou un intent non pris en charge', () => {
    expect(denyCode(() => guard.authorize(challenge({ method: 'stripe' })))).toBe(
      'unsupported-method',
    )
    expect(denyCode(() => guard.authorize(challenge({ intent: 'session' })))).toBe(
      'unsupported-method',
    )
  })

  it('refuse un destinataire hors liste blanche quand elle est définie', () => {
    const strict = new BudgetGuard({ ...LIMITS, recipients: [RECIPIENT] })
    expect(() => strict.authorize(challenge({ recipient: RECIPIENT }))).not.toThrow()
    expect(
      denyCode(() =>
        strict.authorize(challenge({ recipient: '0x0000000000000000000000000000000000000001' })),
      ),
    ).toBe('unexpected-recipient')
  })

  it('compare les adresses sans tenir compte de la casse', () => {
    const strict = new BudgetGuard({ ...LIMITS, recipients: [RECIPIENT.toLowerCase()] })
    expect(() => strict.authorize(challenge({ recipient: RECIPIENT.toUpperCase() }))).not.toThrow()
  })

  it('refuse des limites absurdes à la construction', () => {
    expect(() => new BudgetGuard({ ...LIMITS, maxPerCall: 0n })).toThrow(RangeError)
    expect(() => new BudgetGuard({ ...LIMITS, totalBudget: -1n })).toThrow(RangeError)
  })
})

describe('BudgetGuard — instantané', () => {
  it('expose des montants lisibles et aucune donnée sensible', () => {
    const guard = new BudgetGuard(LIMITS)
    const c = challenge()
    guard.authorize(c)
    guard.settle(c.id)
    guard.authorize(challenge())
    expect(guard.snapshot()).toEqual({
      committed: '0.5',
      reserved: '0.5',
      remaining: '1.5',
      inFlight: 1,
    })
  })
})
