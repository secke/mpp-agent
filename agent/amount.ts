/**
 * Conversion de montants, en arithmétique entière uniquement.
 *
 * Les montants MPP circulent en **unités de base** sous forme de chaîne
 * (`"500000"` = 0,50 pathUSD à 6 décimales). On ne passe jamais par un
 * `number` flottant : 0.1 + 0.2 !== 0.3, et ici l'erreur coûte de l'argent.
 */

export class AmountError extends Error {
  override name = 'AmountError'
}

const HUMAN_RE = /^(\d+)(?:\.(\d+))?$/
const BASE_RE = /^\d+$/

/** « 0.50 », 6 → 500000n. Refuse plus de décimales que le jeton n'en a. */
export function toBaseUnits(human: string, decimals: number): bigint {
  const match = HUMAN_RE.exec(human.trim())
  if (!match) throw new AmountError(`Montant illisible : « ${human} »`)

  const [, whole = '0', fraction = ''] = match
  if (fraction.length > decimals)
    throw new AmountError(
      `« ${human} » a ${fraction.length} décimales, le jeton n'en accepte que ${decimals}. ` +
        `Refus plutôt qu'arrondi silencieux.`,
    )

  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

/** 500000n, 6 → « 0.5 ». Pour l'affichage et les journaux, jamais pour un calcul. */
export function fromBaseUnits(base: bigint, decimals: number): string {
  const negative = base < 0n
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Lit un montant en unités de base venu du réseau. Strict : pas de signe, pas d'espace. */
export function parseBaseUnits(value: unknown): bigint {
  if (typeof value !== 'string' || !BASE_RE.test(value))
    throw new AmountError(`Montant en unités de base invalide : ${JSON.stringify(value)}`)
  return BigInt(value)
}
