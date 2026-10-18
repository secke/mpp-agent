/**
 * Budget guard — the authority deciding whether a Challenge is payable.
 *
 * **Pure** module: no I/O, no dependency on the SDK beyond the `Challenge`
 * type. This is deliberate — the logic protecting the money must be
 * exhaustively testable without a network or a wallet.
 *
 * Principle: **fail-closed**. Anything not explicitly recognized is refused.
 * A missing field, an unexpected currency, an unreadable amount ⇒ refusal.
 * We prefer a blocked agent to an agent that pays for anything.
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
 * Guard refusal. **Throwing is the only way to refuse a payment.**
 *
 * Verified on mppx@0.10.1 (node_modules/mppx/dist/client/internal/Fetch.js,
 * line 153): `const credential = onChallengeCredential ?? (await createCredential())`.
 * Returning `undefined` from `onChallenge` **does not refuse** — the client
 * falls back to the default Credential creation and pays. Measured: with an
 * `onChallenge` returning `undefined`, the client went all the way to the
 * on-chain transaction (which failed for a zero balance, not because of a refusal).
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
  /** Per-call cap, in base units. */
  readonly maxPerCall: bigint
  /** Total envelope over the guard's lifetime, in base units. */
  readonly totalBudget: bigint
  /** Accepted chain (Tempo Moderato). */
  readonly chainId: number
  /** Accepted token address (pathUSD). Case-insensitive comparison. */
  readonly currency: string
  /** If provided, only these recipients are payable. */
  readonly recipients?: readonly string[] | undefined
  /** Token decimals, for readable messages. */
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
  /** Confirmed spend (completed payment). */
  #committed = 0n
  /** Amounts committed but not yet confirmed, by Challenge id. */
  readonly #reserved = new Map<string, bigint>()

  constructor(limits: BudgetLimits) {
    if (limits.maxPerCall <= 0n) throw new RangeError('maxPerCall must be > 0')
    if (limits.totalBudget <= 0n) throw new RangeError('totalBudget must be > 0')
    this.limits = limits
  }

  /** Confirmed spend. */
  get committed(): bigint {
    return this.#committed
  }

  /** Total committed and not yet confirmed. */
  get reserved(): bigint {
    let sum = 0n
    for (const amount of this.#reserved.values()) sum += amount
    return sum
  }

  /**
   * What is actually still spendable: the envelope minus the confirmed
   * **and** minus the committed. Reservations count immediately, otherwise
   * two concurrent calls could each pass under the cap and cross it together.
   */
  get remaining(): bigint {
    const left = this.limits.totalBudget - this.#committed - this.reserved
    return left > 0n ? left : 0n
  }

  /**
   * Validates a Challenge and commits its amount.
   * @throws {BudgetDenied} if the payment must be refused.
   * @returns the committed amount, in base units.
   */
  authorize(challenge: Challenge.Challenge): bigint {
    // Re-authorization of the same Challenge (retry): we do not commit twice.
    const already = this.#reserved.get(challenge.id)
    if (already !== undefined) return already

    if (challenge.method !== 'tempo' || challenge.intent !== 'charge')
      throw new BudgetDenied(
        'unsupported-method',
        `Unsupported method: ${challenge.method}/${challenge.intent}. ` +
          `Only tempo/charge is allowed.`,
      )

    const request = (challenge.request ?? {}) as ChallengeRequest

    const chainId = request.methodDetails?.chainId
    if (chainId !== this.limits.chainId)
      throw new BudgetDenied(
        'unexpected-chain',
        `Challenge on chainId=${String(chainId)}, expected ${this.limits.chainId}.`,
      )

    const currency = request.currency
    if (typeof currency !== 'string' || currency.toLowerCase() !== this.limits.currency.toLowerCase())
      throw new BudgetDenied(
        'unexpected-currency',
        `Unexpected currency ${String(currency)}, expected ${this.limits.currency}.`,
      )

    const recipient = request.recipient
    if (this.limits.recipients) {
      const allowed =
        typeof recipient === 'string' &&
        this.limits.recipients.some((r) => r.toLowerCase() === recipient.toLowerCase())
      if (!allowed)
        throw new BudgetDenied(
          'unexpected-recipient',
          `Recipient ${String(recipient)} is not on the allowlist.`,
        )
    }

    let amount: bigint
    try {
      amount = parseBaseUnits(request.amount)
    } catch (error) {
      throw new BudgetDenied(
        'malformed-amount',
        error instanceof AmountError ? error.message : 'Unreadable amount',
      )
    }

    const human = (value: bigint) => fromBaseUnits(value, this.limits.decimals)

    if (amount > this.limits.maxPerCall)
      throw new BudgetDenied(
        'per-call-cap',
        `Amount ${human(amount)} exceeds the per-call cap ${human(this.limits.maxPerCall)}.`,
      )

    if (amount > this.remaining)
      throw new BudgetDenied(
        'budget-exhausted',
        `Amount ${human(amount)} exceeds the remaining budget ${human(this.remaining)} ` +
          `(envelope ${human(this.limits.totalBudget)}, already spent ${human(this.#committed)}).`,
      )

    this.#reserved.set(challenge.id, amount)
    return amount
  }

  /** The payment completed: the commitment becomes spend. */
  settle(challengeId: string): void {
    const amount = this.#reserved.get(challengeId)
    if (amount === undefined) return
    this.#reserved.delete(challengeId)
    this.#committed += amount
  }

  /** The payment failed: the commitment goes back to the envelope. */
  release(challengeId: string): void {
    this.#reserved.delete(challengeId)
  }

  /** Snapshot for logs and metrics. No sensitive data. */
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
