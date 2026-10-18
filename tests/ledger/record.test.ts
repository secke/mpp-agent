import { Challenge, Errors } from 'mppx'
import { beforeEach, describe, expect, it } from 'vitest'

const { InvalidChallengeError, VerificationFailedError } = Errors

import { openLedger } from '../../ledger/db.ts'
import { Ledger, normalizeErrorCode } from '../../ledger/record.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'
import { TEST_CONFIG } from '../helpers.ts'

let n = 0
const challenge = (amount = '500000') =>
  Challenge.from({
    id: `challenge-${++n}`,
    realm: 'api.test',
    method: 'tempo',
    intent: 'charge',
    request: {
      amount,
      currency: PATH_USD,
      recipient: TEST_CONFIG.recipient,
      methodDetails: { chainId: TESTNET_CHAIN_ID },
    },
  }) as Challenge.Challenge

describe('Ledger', () => {
  let ledger: Ledger
  beforeEach(() => {
    ledger = new Ledger(openLedger(':memory:'))
  })

  it('writes a "challenged" row with the payment terms', () => {
    const c = challenge()
    ledger.recordChallenge(c, 'api.test')

    const row = ledger.get(c.id)!
    expect(row.status).toBe('challenged')
    expect(row.amount).toBe('500000')
    expect(row.currency).toBe(PATH_USD)
    expect(row.chain_id).toBe(TESTNET_CHAIN_ID)
    expect(row.recipient).toBe(TEST_CONFIG.recipient)
    expect(row.reference).toBeNull()
  })

  it('is idempotent: replaying the same Challenge does not duplicate a row', () => {
    const c = challenge()
    ledger.recordChallenge(c, 'api.test')
    ledger.recordChallenge(c, 'api.test')
    ledger.recordChallenge(c, 'api.test')
    expect(ledger.all()).toHaveLength(1)
  })

  it('counts occurrences rather than losing them', () => {
    // Two identical requests within the same millisecond share their id
    // (the id is an HMAC of its parameters). Without a counter, reconciliation
    // would underestimate traffic — measured: 19 collisions out of 50 requests.
    const c = challenge()
    ledger.recordChallenge(c, 'api.test')
    ledger.recordChallenge(c, 'api.test')
    ledger.recordChallenge(c, 'api.test')

    expect(ledger.get(c.id)!.occurrences).toBe(3)
    const challenged = ledger.reconciliation().find((r) => r.status === 'challenged')!
    expect(challenged).toMatchObject({ entries: 1, occurrences: 3, total_base_units: 1500000 })
  })

  it('moves to "success" with the transaction reference and the payer', () => {
    const c = challenge()
    ledger.recordChallenge(c, 'api.test')
    ledger.recordSuccess({
      challengeId: c.id,
      reference: '0xabc123',
      payer: `did:pkh:eip155:${TESTNET_CHAIN_ID}:0xf39F`,
    })

    const row = ledger.get(c.id)!
    expect(row.status).toBe('success')
    expect(row.reference).toBe('0xabc123')
    expect(row.payer).toContain('did:pkh:eip155')
    expect(row.error_code).toBeNull()
  })

  it('moves to "failed" with the normalized MPP code', () => {
    const c = challenge()
    ledger.recordChallenge(c, 'api.test')
    ledger.recordFailure({ challengeId: c.id, error: new VerificationFailedError() })

    const row = ledger.get(c.id)!
    expect(row.status).toBe('failed')
    expect(row.error_code).toBe('verification-failed')
  })

  it('stores neither the error message nor its details', () => {
    const c = challenge()
    const error = new VerificationFailedError({
      details: { credential: 'Payment eyJzZWNyZXQi', txHash: '0xdeadbeef' },
    })
    ledger.recordChallenge(c, 'api.test')
    ledger.recordFailure({ challengeId: c.id, error })

    const stored = JSON.stringify(ledger.get(c.id))
    expect(stored).not.toContain(error.message)
    expect(stored).not.toContain('Payment eyJzZWNyZXQi')
    expect(stored).not.toContain('0xdeadbeef')
    expect(ledger.get(c.id)!.error_code).toBe('verification-failed')
  })

  it('never regresses a completed payment', () => {
    const c = challenge()
    ledger.recordChallenge(c, 'api.test')
    ledger.recordSuccess({ challengeId: c.id, reference: '0xabc' })
    ledger.recordFailure({ challengeId: c.id, error: new InvalidChallengeError() })

    const row = ledger.get(c.id)!
    expect(row.status).toBe('success')
    expect(row.error_code).toBeNull()
  })

  it('tolerates a settle on an unknown Challenge without throwing', () => {
    expect(() => ledger.recordSuccess({ challengeId: 'never-seen', reference: '0x1' })).not.toThrow()
    expect(ledger.all()).toHaveLength(0)
  })

  it('reconciles by status', () => {
    const paid = challenge('500000')
    ledger.recordChallenge(paid, 'api.test')
    ledger.recordSuccess({ challengeId: paid.id, reference: '0x1' })

    const failed = challenge('250000')
    ledger.recordChallenge(failed, 'api.test')
    ledger.recordFailure({ challengeId: failed.id, error: new InvalidChallengeError() })

    ledger.recordChallenge(challenge('100000'), 'api.test')

    const byStatus = Object.fromEntries(ledger.reconciliation().map((r) => [r.status, r]))
    expect(byStatus['success']).toMatchObject({ entries: 1, occurrences: 1, total_base_units: 500000 })
    expect(byStatus['failed']).toMatchObject({ entries: 1, total_base_units: 250000 })
    expect(byStatus['challenged']).toMatchObject({ entries: 1, total_base_units: 100000 })
  })

  it('lists the Challenges left unresolved', () => {
    const paid = challenge()
    ledger.recordChallenge(paid, 'api.test')
    ledger.recordSuccess({ challengeId: paid.id, reference: '0x1' })
    const pending = challenge()
    ledger.recordChallenge(pending, 'api.test')

    const unsettled = ledger.unsettled()
    expect(unsettled).toHaveLength(1)
    expect(unsettled[0]!.challenge_id).toBe(pending.id)
  })
})

describe('normalizeErrorCode', () => {
  it('extracts the code from the MPP problem URI', () => {
    expect(normalizeErrorCode(new VerificationFailedError())).toBe('verification-failed')
    expect(normalizeErrorCode(new InvalidChallengeError())).toBe('invalid-challenge')
  })

  it('falls back to the name then to "unknown"', () => {
    expect(normalizeErrorCode(new TypeError('x'))).toBe('TypeError')
    expect(normalizeErrorCode(null)).toBe('unknown')
    expect(normalizeErrorCode({})).toBe('unknown')
  })
})
