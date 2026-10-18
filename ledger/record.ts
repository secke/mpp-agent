/**
 * Payments audit log.
 *
 * Fed by the mppx server hooks:
 *   onChallengeCreated → `challenged` row
 *   onPaymentSuccess   → moves to `success` + reference + payer
 *   onPaymentFailed    → moves to `failed` + normalized error code
 *
 * ⚠️ Server handlers run **inline** on the paid request path
 * payante (https://mpp.dev/sdk/typescript/server/Mppx.create § Event handling).
 * All writes here are synchronous and prepared once — better-sqlite3
 * is synchronous by design, which avoids introducing a queue.
 *
 * ⚠️ Nothing sensitive enters this database: no Credential, no raw Receipt,
 * no secret, no error message. See the header comment of schema.sql.
 */
import { Challenge } from 'mppx'

import type { LedgerDatabase } from './db.ts'

export type PaymentStatus = 'challenged' | 'success' | 'failed'

export type PaymentRow = {
  challenge_id: string
  realm: string
  method: string
  intent: string
  route: string | null
  amount: string
  currency: string
  recipient: string | null
  chain_id: number | null
  status: PaymentStatus
  reference: string | null
  payer: string | null
  error_code: string | null
  occurrences: number
  created_at: string
  updated_at: string
}

export type ReconciliationRow = {
  status: PaymentStatus
  entries: number
  occurrences: number
  total_base_units: number
  first_at: string
  last_at: string
}

/**
 * Extracts the normalized MPP code from a problem URI.
 * "https://paymentauth.org/problems/verification-failed" → "verification-failed"
 * Type source: docs/NOTES.md §2, node_modules/mppx/dist/Errors.d.ts
 */
export function normalizeErrorCode(error: unknown): string {
  const type = (error as { type?: unknown } | null)?.type
  if (typeof type === 'string' && type.length > 0) {
    const last = type.split('/').pop()
    if (last) return last
  }
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.length > 0 ? name : 'unknown'
}

/** Route bound to the Challenge via `opaque`, when mppx put it there. */
function routeOf(challenge: Challenge.Challenge): string | null {
  try {
    return Challenge.meta(challenge)?.['_mppx_scope'] ?? null
  } catch {
    return null
  }
}

export class Ledger {
  readonly #db: LedgerDatabase
  readonly #insert
  readonly #ensure
  readonly #settle
  readonly #fail
  readonly #get
  readonly #all
  readonly #reconciliation
  readonly #unsettled

  constructor(db: LedgerDatabase) {
    this.#db = db

    // A Challenge already seen adds no row and does not overwrite its status:
    // it increments `occurrences`. Needed because two identical requests
    // within the same millisecond share their id (see schema.sql).
    this.#insert = db.prepare(`
      insert into payments (
        challenge_id, realm, method, intent, route, amount, currency,
        recipient, chain_id, status, created_at, updated_at
      ) values (
        @challenge_id, @realm, @method, @intent, @route, @amount, @currency,
        @recipient, @chain_id, 'challenged', @now, @now
      )
      on conflict(challenge_id) do update
        set occurrences = occurrences + 1, updated_at = @now
    `)

    // A row already resolved does not go backwards: the guard on `status`
    // makes the operation idempotent even if the hook is called twice.
    this.#settle = db.prepare(`
      update payments
         set status = 'success', reference = @reference, payer = @payer,
             error_code = null, updated_at = @now
       where challenge_id = @challenge_id and status != 'success'
    `)

    this.#fail = db.prepare(`
      update payments
         set status = 'failed', error_code = @error_code, payer = coalesce(@payer, payer),
             updated_at = @now
       where challenge_id = @challenge_id and status != 'success'
    `)

    // Non-counting variant: guarantees the row exists without inflating
    // `occurrences`. Used by the success/failed handlers, which may see a
    // Challenge already recorded by onChallengeCreated.
    this.#ensure = db.prepare(`
      insert into payments (
        challenge_id, realm, method, intent, route, amount, currency,
        recipient, chain_id, status, occurrences, created_at, updated_at
      ) values (
        @challenge_id, @realm, @method, @intent, @route, @amount, @currency,
        @recipient, @chain_id, 'challenged', 1, @now, @now
      )
      on conflict(challenge_id) do nothing
    `)

    this.#get = db.prepare(`select * from payments where challenge_id = ?`)
    this.#all = db.prepare(`select * from payments order by created_at`)
    this.#reconciliation = db.prepare(`select * from ledger_reconciliation order by status`)
    this.#unsettled = db.prepare(`select * from ledger_unsettled`)
  }

  /**
   * Records an issued Challenge. One row per id; repeated issuances of the
   * same id increment `occurrences`.
   */
  recordChallenge(challenge: Challenge.Challenge, realm: string): void {
    this.#write(this.#insert, challenge, realm)
  }

  /**
   * Guarantees the row exists **without** counting an issuance.
   * For the success/failed paths, which may arrive on a Challenge already
   * recorded (or never seen: restart, another instance).
   */
  ensureChallenge(challenge: Challenge.Challenge, realm: string): void {
    this.#write(this.#ensure, challenge, realm)
  }

  #write(
    statement: { run: (params: Record<string, unknown>) => unknown },
    challenge: Challenge.Challenge,
    realm: string,
  ): void {
    const request = (challenge.request ?? {}) as {
      amount?: unknown
      currency?: unknown
      recipient?: unknown
      methodDetails?: { chainId?: unknown }
    }
    const now = new Date().toISOString()
    statement.run({
      challenge_id: challenge.id,
      realm: challenge.realm || realm,
      method: challenge.method,
      intent: challenge.intent,
      route: routeOf(challenge),
      amount: String(request.amount ?? ''),
      currency: String(request.currency ?? ''),
      recipient: request.recipient == null ? null : String(request.recipient),
      chain_id: typeof request.methodDetails?.chainId === 'number'
        ? request.methodDetails.chainId
        : null,
      now,
    })
  }

  /** Marks a payment as completed. `reference` = transaction hash (via the Receipt). */
  recordSuccess(params: {
    challengeId: string
    reference?: string | null
    payer?: string | null
  }): void {
    this.#settle.run({
      challenge_id: params.challengeId,
      reference: params.reference ?? null,
      payer: params.payer ?? null,
      now: new Date().toISOString(),
    })
  }

  /** Marks a failure with the normalized MPP code. The error message is not stored. */
  recordFailure(params: {
    challengeId: string
    error: unknown
    payer?: string | null
  }): void {
    this.#fail.run({
      challenge_id: params.challengeId,
      error_code: normalizeErrorCode(params.error),
      payer: params.payer ?? null,
      now: new Date().toISOString(),
    })
  }

  get(challengeId: string): PaymentRow | undefined {
    return this.#get.get(challengeId) as PaymentRow | undefined
  }

  all(): PaymentRow[] {
    return this.#all.all() as PaymentRow[]
  }

  reconciliation(): ReconciliationRow[] {
    return this.#reconciliation.all() as ReconciliationRow[]
  }

  unsettled(): Pick<PaymentRow, 'challenge_id' | 'route' | 'amount' | 'currency' | 'created_at'>[] {
    return this.#unsettled.all() as never
  }

  close(): void {
    this.#db.close()
  }
}

/** Minimal type of the server hooks the ledger needs. */
type HookTarget = {
  realm: string
  onChallengeCreated: (handler: (context: { challenge: Challenge.Challenge }) => void) => unknown
  onPaymentSuccess: (
    handler: (context: {
      challenge: Challenge.Challenge
      receipt?: { reference?: string | undefined } | undefined
      credential?: { source?: string | null | undefined } | undefined
    }) => void,
  ) => unknown
  onPaymentFailed: (
    handler: (context: {
      challenge: Challenge.Challenge
      error: unknown
      credential?: { source?: string | null | undefined } | null | undefined
    }) => void,
  ) => unknown
}

/** Hooks the ledger onto a server payment instance. */
export function attachLedger(payment: HookTarget, ledger: Ledger): void {
  payment.onChallengeCreated(({ challenge }) => {
    ledger.recordChallenge(challenge, payment.realm)
  })

  payment.onPaymentSuccess(({ challenge, receipt, credential }) => {
    // The Challenge may never have been seen (restart, another instance).
    // `ensureChallenge` creates the row if needed without counting one more issuance.
    ledger.ensureChallenge(challenge, payment.realm)
    ledger.recordSuccess({
      challengeId: challenge.id,
      reference: receipt?.reference ?? null,
      payer: credential?.source ?? null,
    })
  })

  payment.onPaymentFailed(({ challenge, error, credential }) => {
    ledger.ensureChallenge(challenge, payment.realm)
    ledger.recordFailure({
      challengeId: challenge.id,
      error,
      payer: credential?.source ?? null,
    })
  })
}
