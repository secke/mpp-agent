/**
 * Amount conversion, using integer arithmetic only.
 *
 * MPP amounts travel as **base units** in string form
 * (`"500000"` = 0.50 pathUSD at 6 decimals). We never go through a floating
 * `number`: 0.1 + 0.2 !== 0.3, and here the error costs money.
 */

export class AmountError extends Error {
  override name = 'AmountError'
}

const HUMAN_RE = /^(\d+)(?:\.(\d+))?$/
const BASE_RE = /^\d+$/

/** "0.50", 6 → 500000n. Refuses more decimals than the token has. */
export function toBaseUnits(human: string, decimals: number): bigint {
  const match = HUMAN_RE.exec(human.trim())
  if (!match) throw new AmountError(`Unreadable amount: "${human}"`)

  const [, whole = '0', fraction = ''] = match
  if (fraction.length > decimals)
    throw new AmountError(
      `"${human}" has ${fraction.length} decimals, the token only accepts ${decimals}. ` +
        `Refusing rather than rounding silently.`,
    )

  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

/** 500000n, 6 → "0.5". For display and logs, never for computation. */
export function fromBaseUnits(base: bigint, decimals: number): string {
  const negative = base < 0n
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Reads a base-unit amount coming from the network. Strict: no sign, no whitespace. */
export function parseBaseUnits(value: unknown): bigint {
  if (typeof value !== 'string' || !BASE_RE.test(value))
    throw new AmountError(`Invalid base-unit amount: ${JSON.stringify(value)}`)
  return BigInt(value)
}
