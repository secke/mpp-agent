/**
 * Budget guard — l'autorité qui décide si un Challenge est payable.
 *
 * Module **pur** : aucune I/O, aucune dépendance au SDK au-delà du type
 * `Challenge`. C'est délibéré — la logique qui protège l'argent doit être
 * testable exhaustivement sans réseau ni wallet.
 *
 * Principe : **fail-closed**. Tout ce qui n'est pas explicitement reconnu
 * est refusé. Un champ manquant, une devise inattendue, un montant illisible
 * ⇒ refus. On préfère un agent bloqué à un agent qui paie n'importe quoi.
 */
import type { Challenge } from 'mppx'

import { AmountError, fromBaseUnits, parseBaseUnits } from './amount.ts'

export type DenyCode =
  | 'unsupported-method'
  | 'unexpected-chain'
  | 'unexpected-currency'
  | 'unexpected-recipient'
  | 'malformed-amount'
  | 'per-call-cap'
  | 'budget-exhausted'

/**
 * Refus du guard. **Lever est la seule façon de refuser un paiement.**
 *
 * Vérifié sur mppx@0.10.1 (node_modules/mppx/dist/client/internal/Fetch.js,
 * ligne 153) : `const credential = onChallengeCredential ?? (await createCredential())`.
 * Renvoyer `undefined` depuis `onChallenge` **ne refuse pas** — le client
 * retombe sur la création de Credential par défaut et paie. Mesuré : avec un
 * `onChallenge` renvoyant `undefined`, le client est allé jusqu'à la
 * transaction on-chain (échouée pour solde nul, pas pour refus).
 */
export class BudgetDenied extends Error {
  override name = 'BudgetDenied'
  constructor(
    readonly code: DenyCode,
    message: string,
  ) {
    super(message)
  }
}

export type BudgetLimits = {
  /** Plafond par appel, en unités de base. */
  readonly maxPerCall: bigint
  /** Enveloppe totale sur la durée de vie du guard, en unités de base. */
  readonly totalBudget: bigint
  /** Chaîne acceptée (Tempo Moderato). */
  readonly chainId: number
  /** Adresse de jeton acceptée (pathUSD). Comparaison insensible à la casse. */
  readonly currency: string
  /** Si fourni, seuls ces destinataires sont payables. */
  readonly recipients?: readonly string[] | undefined
  /** Décimales du jeton, pour les messages lisibles. */
  readonly decimals: number
}

type ChallengeRequest = {
  amount?: unknown
  currency?: unknown
  recipient?: unknown
  methodDetails?: { chainId?: unknown }
}

export class BudgetGuard {
  readonly limits: BudgetLimits
  /** Dépense confirmée (paiement abouti). */
  #committed = 0n
  /** Montants engagés mais pas encore confirmés, par id de Challenge. */
  readonly #reserved = new Map<string, bigint>()

  constructor(limits: BudgetLimits) {
    if (limits.maxPerCall <= 0n) throw new RangeError('maxPerCall doit être > 0')
    if (limits.totalBudget <= 0n) throw new RangeError('totalBudget doit être > 0')
    this.limits = limits
  }

  /** Dépense confirmée. */
  get committed(): bigint {
    return this.#committed
  }

  /** Total engagé et non encore confirmé. */
  get reserved(): bigint {
    let sum = 0n
    for (const amount of this.#reserved.values()) sum += amount
    return sum
  }

  /**
   * Ce qui reste réellement dépensable : l'enveloppe moins le confirmé
   * **et** moins l'engagé. Les réservations comptent tout de suite, sinon
   * deux appels concurrents peuvent chacun passer sous le plafond et le
   * franchir ensemble.
   */
  get remaining(): bigint {
    const left = this.limits.totalBudget - this.#committed - this.reserved
    return left > 0n ? left : 0n
  }

  /**
   * Valide un Challenge et engage son montant.
   * @throws {BudgetDenied} si le paiement doit être refusé.
   * @returns le montant engagé, en unités de base.
   */
  authorize(challenge: Challenge.Challenge): bigint {
    // Réautorisation du même Challenge (retry) : on ne réengage pas deux fois.
    const already = this.#reserved.get(challenge.id)
    if (already !== undefined) return already

    if (challenge.method !== 'tempo' || challenge.intent !== 'charge')
      throw new BudgetDenied(
        'unsupported-method',
        `Méthode non prise en charge : ${challenge.method}/${challenge.intent}. ` +
          `Seul tempo/charge est autorisé.`,
      )

    const request = (challenge.request ?? {}) as ChallengeRequest

    const chainId = request.methodDetails?.chainId
    if (chainId !== this.limits.chainId)
      throw new BudgetDenied(
        'unexpected-chain',
        `Challenge sur chainId=${String(chainId)}, attendu ${this.limits.chainId}.`,
      )

    const currency = request.currency
    if (typeof currency !== 'string' || currency.toLowerCase() !== this.limits.currency.toLowerCase())
      throw new BudgetDenied(
        'unexpected-currency',
        `Devise ${String(currency)} inattendue, attendu ${this.limits.currency}.`,
      )

    const recipient = request.recipient
    if (this.limits.recipients) {
      const allowed =
        typeof recipient === 'string' &&
        this.limits.recipients.some((r) => r.toLowerCase() === recipient.toLowerCase())
      if (!allowed)
        throw new BudgetDenied(
          'unexpected-recipient',
          `Destinataire ${String(recipient)} hors liste blanche.`,
        )
    }

    let amount: bigint
    try {
      amount = parseBaseUnits(request.amount)
    } catch (error) {
      throw new BudgetDenied(
        'malformed-amount',
        error instanceof AmountError ? error.message : 'Montant illisible',
      )
    }

    const human = (value: bigint) => fromBaseUnits(value, this.limits.decimals)

    if (amount > this.limits.maxPerCall)
      throw new BudgetDenied(
        'per-call-cap',
        `Montant ${human(amount)} au-dessus du plafond par appel ${human(this.limits.maxPerCall)}.`,
      )

    if (amount > this.remaining)
      throw new BudgetDenied(
        'budget-exhausted',
        `Montant ${human(amount)} au-dessus du budget restant ${human(this.remaining)} ` +
          `(enveloppe ${human(this.limits.totalBudget)}, déjà dépensé ${human(this.#committed)}).`,
      )

    this.#reserved.set(challenge.id, amount)
    return amount
  }

  /** Le paiement a abouti : l'engagement devient une dépense. */
  settle(challengeId: string): void {
    const amount = this.#reserved.get(challengeId)
    if (amount === undefined) return
    this.#reserved.delete(challengeId)
    this.#committed += amount
  }

  /** Le paiement a échoué : on rend l'engagement à l'enveloppe. */
  release(challengeId: string): void {
    this.#reserved.delete(challengeId)
  }

  /** Instantané pour les journaux et les métriques. Aucune donnée sensible. */
  snapshot(): { committed: string; reserved: string; remaining: string; inFlight: number } {
    const d = this.limits.decimals
    return {
      committed: fromBaseUnits(this.#committed, d),
      reserved: fromBaseUnits(this.reserved, d),
      remaining: fromBaseUnits(this.remaining, d),
      inFlight: this.#reserved.size,
    }
  }
}
