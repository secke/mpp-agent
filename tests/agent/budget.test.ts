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
  throw new Error('expected: a refusal, got: an authorization')
}

describe('BudgetGuard — nominal authorization', () => {
  let guard: BudgetGuard
  beforeEach(() => {
    guard = new BudgetGuard(LIMITS)
  })

  it('authorizes a compliant Challenge and commits the amount', () => {
    expect(guard.authorize(challenge())).toBe(500000n)
    expect(guard.reserved).toBe(500000n)
    expect(guard.committed).toBe(0n)
    expect(guard.remaining).toBe(toBaseUnits('2.00', 6))
  })

  it('does not commit the same Challenge twice (retry)', () => {
    const c = challenge()
    guard.authorize(c)
    guard.authorize(c)
    expect(guard.reserved).toBe(500000n)
  })

  it('counts the spend once the payment is confirmed', () => {
    const c = challenge()
    guard.authorize(c)
    guard.settle(c.id)
    expect(guard.committed).toBe(500000n)
    expect(guard.reserved).toBe(0n)
    expect(guard.remaining).toBe(toBaseUnits('2.00', 6))
  })

  it('gives the commitment back when the payment fails', () => {
    const c = challenge()
    guard.authorize(c)
    guard.release(c.id)
    expect(guard.committed).toBe(0n)
    expect(guard.remaining).toBe(LIMITS.totalBudget)
  })

  it('ignores a settle/release on an unknown Challenge', () => {
    expect(() => guard.settle('never-seen')).not.toThrow()
    expect(() => guard.release('never-seen')).not.toThrow()
    expect(guard.committed).toBe(0n)
  })
})

describe('BudgetGuard — caps', () => {
  let guard: BudgetGuard
  beforeEach(() => {
    guard = new BudgetGuard(LIMITS)
  })

  it('refuses above the per-call cap', () => {
    expect(denyCode(() => guard.authorize(challenge({ amount: '1000001' })))).toBe('per-call-cap')
    expect(guard.reserved).toBe(0n) // nothing committed on a refusal
  })

  it('accepts exactly the per-call cap', () => {
    expect(() => guard.authorize(challenge({ amount: '1000000' }))).not.toThrow()
  })

  it('refuses when the envelope is exhausted', () => {
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

  it('counts in-flight commitments, not just the confirmed', () => {
    // Two concurrent calls at 1.00 on a 2.50 envelope: the third must be
    // refused even though none is confirmed yet.
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

  it('refuses an unexpected chain (mainnet)', () => {
    expect(denyCode(() => guard.authorize(challenge({ chainId: 4217 })))).toBe('unexpected-chain')
  })

  it('refuses a Challenge with no chainId', () => {
    expect(denyCode(() => guard.authorize(challenge({ chainId: undefined })))).toBe(
      'unexpected-chain',
    )
  })

  it('refuses an unexpected currency', () => {
    expect(denyCode(() => guard.authorize(challenge({ currency: USDC_MAINNET })))).toBe(
      'unexpected-currency',
    )
  })

  it('refuses an unreadable amount', () => {
    for (const amount of ['0.5', '-1', '', 'lots', 500000])
      expect(denyCode(() => guard.authorize(challenge({ amount }))), String(amount)).toBe(
        'malformed-amount',
      )
  })

  it('refuses an unsupported method or intent', () => {
    expect(denyCode(() => guard.authorize(challenge({ method: 'stripe' })))).toBe(
      'unsupported-method',
    )
    expect(denyCode(() => guard.authorize(challenge({ intent: 'session' })))).toBe(
      'unsupported-method',
    )
  })

  it('refuses a recipient outside the allowlist when one is defined', () => {
    const strict = new BudgetGuard({ ...LIMITS, recipients: [RECIPIENT] })
    expect(() => strict.authorize(challenge({ recipient: RECIPIENT }))).not.toThrow()
    expect(
      denyCode(() =>
        strict.authorize(challenge({ recipient: '0x0000000000000000000000000000000000000001' })),
      ),
    ).toBe('unexpected-recipient')
  })

  it('compares addresses case-insensitively', () => {
    const strict = new BudgetGuard({ ...LIMITS, recipients: [RECIPIENT.toLowerCase()] })
    expect(() => strict.authorize(challenge({ recipient: RECIPIENT.toUpperCase() }))).not.toThrow()
  })

  it('refuses absurd limits at construction', () => {
    expect(() => new BudgetGuard({ ...LIMITS, maxPerCall: 0n })).toThrow(RangeError)
    expect(() => new BudgetGuard({ ...LIMITS, totalBudget: -1n })).toThrow(RangeError)
  })
})

describe('BudgetGuard — snapshot', () => {
  it('exposes readable amounts and no sensitive data', () => {
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
