/**
 * Journal d'audit des paiements.
 *
 * Alimenté par les hooks serveur de mppx :
 *   onChallengeCreated → ligne `challenged`
 *   onPaymentSuccess   → passe à `success` + référence + payeur
 *   onPaymentFailed    → passe à `failed` + code d'erreur normalisé
 *
 * ⚠️ Les handlers serveur s'exécutent **en ligne** sur le chemin de la requête
 * payante (https://mpp.dev/sdk/typescript/server/Mppx.create § Event handling).
 * Toutes les écritures ici sont synchrones et préparées une fois — better-sqlite3
 * est synchrone par conception, ce qui évite d'introduire une file d'attente.
 *
 * ⚠️ Rien de sensible n'entre dans cette base : ni Credential, ni Receipt brut,
 * ni secret, ni message d'erreur. Voir le commentaire de tête de schema.sql.
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
 * Extrait le code MPP normalisé d'une URI de problème.
 * « https://paymentauth.org/problems/verification-failed » → « verification-failed »
 * Source des types : docs/NOTES.md §2, node_modules/mppx/dist/Errors.d.ts
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

/** Route liée au Challenge via `opaque`, quand mppx l'y a placée. */
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

    // Un Challenge déjà vu n'ajoute pas de ligne et n'écrase pas son statut :
    // il incrémente `occurrences`. Nécessaire parce que deux requêtes
    // identiques dans la même milliseconde partagent leur id (voir schema.sql).
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

    // Une ligne déjà résolue ne repasse pas en arrière : la garde sur `status`
    // rend l'opération idempotente même si le hook est appelé deux fois.
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

    // Variante non comptante : garantit l'existence de la ligne sans gonfler
    // `occurrences`. Utilisée par les handlers success/failed, qui peuvent
    // voir un Challenge déjà enregistré par onChallengeCreated.
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
   * Enregistre un Challenge émis. Une ligne par id ; les émissions répétées
   * du même id incrémentent `occurrences`.
   */
  recordChallenge(challenge: Challenge.Challenge, realm: string): void {
    this.#write(this.#insert, challenge, realm)
  }

  /**
   * Garantit l'existence de la ligne **sans** compter une émission.
   * Pour les chemins success/failed, qui peuvent arriver sur un Challenge
   * déjà enregistré (ou jamais vu : redémarrage, autre instance).
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

  /** Marque un paiement abouti. `reference` = hash de transaction (via le Receipt). */
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

  /** Marque un échec avec le code MPP normalisé. Le message d'erreur n'est pas stocké. */
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

/** Type minimal des hooks serveur dont le ledger a besoin. */
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

/** Branche le ledger sur une instance de paiement serveur. */
export function attachLedger(payment: HookTarget, ledger: Ledger): void {
  payment.onChallengeCreated(({ challenge }) => {
    ledger.recordChallenge(challenge, payment.realm)
  })

  payment.onPaymentSuccess(({ challenge, receipt, credential }) => {
    // Le Challenge peut n'avoir jamais été vu (redémarrage, autre instance).
    // `ensureChallenge` crée la ligne au besoin sans compter une émission de plus.
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
