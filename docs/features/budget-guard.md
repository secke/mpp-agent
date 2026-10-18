# Budget guard

**Phase 2** · Code: `agent/budget.ts`, `agent/amount.ts`
· Tests: `tests/agent/budget.test.ts`, `tests/agent/amount.test.ts`

## What it does

Decides whether a received Challenge is payable. It is the agent's **final
authority**: the model proposes, the guard disposes.

Seven refusal reasons, all typed (`DenyCode`):

| Code | Trigger |
|---|---|
| `unsupported-method` | anything other than `tempo`/`charge` |
| `unexpected-chain` | `methodDetails.chainId` ≠ 42431, or missing |
| `unexpected-currency` | currency ≠ pathUSD |
| `unexpected-recipient` | recipient outside the allowlist (if defined) |
| `malformed-amount` | amount that is not a string of digits |
| `per-call-cap` | above the per-call cap |
| `budget-exhausted` | above the remaining envelope |

## Two design principles

### Pure module

No I/O, no dependency on the SDK beyond the `Challenge` type. The logic that
protects the money must be exhaustively coverable without a network or a
wallet — 18 tests in 15 ms.

### Fail-closed

Anything not explicitly recognized is refused. Missing field, unknown
currency, unreadable amount ⇒ refusal. A blocked agent can be debugged; an
agent that pays for anything cannot.

Concrete case covered: a Challenge **without** a `chainId` is refused, not
treated as "probably the right network".

## Integer arithmetic only

MPP amounts travel as **base units** in string form (`"500000"` = 0.50
pathUSD). `agent/amount.ts` does all conversions in `bigint`, never in
`number`:

```ts
toBaseUnits('0.50', 6)    // 500000n
toBaseUnits('0.1234567', 6)  // ✗ AmountError: 7 decimals for a 6-decimal token
toBaseUnits('1e-3', 6)       // ✗ AmountError: not a plain decimal amount
```

A test checks that `toBaseUnits('0.1') + toBaseUnits('0.2') === toBaseUnits('0.3')`
— which is false in floating point. **More decimals than the token has ⇒
refusal, never rounding.** A silent rounding on an amount is a loss of money
that leaves no trace.

## Reserve, then confirm

The guard does not count the spend at payment time, but in two steps:

```
authorize(challenge)  →  commits the amount     (reserved += amount)
settle(challengeId)   →  the commitment becomes spend  (committed += amount)
release(challengeId)  →  gives the commitment back to the envelope
```

`remaining = totalBudget − committed − reserved`.

**Why count commitments**: without this, two concurrent calls each pass under
the cap and cross it together. A test locks it in (two reservations of 1.00
on a 2.50 envelope ⇒ the third call at 0.60 is refused, although none is
confirmed yet).

If the outcome of a payment stays unknown, the commitment **stays committed**:
over-counting makes the agent stop too early, under-counting makes it spend
too much. Only the first error is acceptable.

Re-authorizing the same `challenge.id` (retry) does not commit twice.

## Usage

```ts
const guard = new BudgetGuard({
  maxPerCall: toBaseUnits('1.00', 6),
  totalBudget: toBaseUnits('10.00', 6),
  chainId: 42431,
  currency: PATH_USD,
  decimals: 6,
  recipients: ['0xf39F…'],   // optional
})

guard.authorize(challenge)   // throws BudgetDenied to refuse
guard.snapshot()             // { committed: '0.5', reserved: '0', remaining: '9.5', inFlight: 0 }
```

`snapshot()` only contains amounts — nothing identifying, nothing sensitive.
This is what goes into logs and metrics (phase 6).

## Tests

26 tests (18 guard + 8 arithmetic): nominal authorization, reservation,
confirmation, release, retry, per-call cap (including exactly at the cap),
envelope exhaustion, concurrency, and the seven refusal reasons.
