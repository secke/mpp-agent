# Ledger — payments audit log

**Phase 3** · Code: `ledger/schema.sql`, `ledger/db.ts`, `ledger/record.ts`
· Tests: `tests/ledger/record.test.ts`, `tests/ledger/integration.test.ts`

## What it does

One SQLite row per Challenge, updated as its fate unfolds:

```
onChallengeCreated  →  status = 'challenged'
onPaymentSuccess    →  status = 'success'  + reference (tx hash) + payer (DID)
onPaymentFailed     →  status = 'failed'   + normalized MPP error_code
```

Hooked in off the business path:

```ts
const ledger = new Ledger(openLedger('data/ledger.sqlite'))
attachLedger(payment, ledger)
```

## What never goes in

This is the structuring constraint. `docs/NOTES.md` §8 forbids logging
`MPP_SECRET_KEY`, the `Authorization: Payment` /
`Payment-Authorization: Payment` headers, and `Payment-Receipt`. We add
**error messages**: `PaymentError` carries a `details` field that may contain
a Credential or a transaction hash.

The schema makes the leak structurally impossible: there is no column where a
Credential, a raw Receipt or free text could be stored. We store
**references**: Challenge id, transaction hash, payer DID, normalized error
code.

Two tests lock this in:
- a test reads the **SQLite file in binary** and checks the absence of the
  secret, the Credential sent, `Payment-Receipt`, `Authorization` and any
  pattern resembling a private key (`0x` + 64 hex);
- a test asserts the **exact list of columns**, so that no sensitive column
  can be added without breaking the test.

The first includes a guard against a vacuous test: it first checks that the
database does contain writes, otherwise the negative assertions would pass
for nothing.

## 🔍 The Challenge id does not identify a request

Discovery of this phase, and it changes the design.

The id is an HMAC of `realm | method | intent | request | expires | digest |
opaque`. It is a **pure function**: two Challenges with identical terms give
the same id. Yet the only term that varies between two identical requests is
`expires`, to the millisecond. Measured on the provider:

```
50 rapid requests → 31 distinct ids (19 collisions)
```

A log indexed on `challenge_id` therefore **merges distinct requests** and
underestimates traffic. This is exactly what made a test flaky before it was
understood.

**The answer**: keep `challenge_id` as the primary key — it is the protocol
identity, and deduplicating is correct — but add an `occurrences` counter.
Reconciliation multiplies by it:

```sql
sum(cast(amount as integer) * occurrences) as total_base_units
```

Two distinct write operations follow:

| Method | Called by | Effect on `occurrences` |
|---|---|---|
| `recordChallenge` | `onChallengeCreated` | **increments** |
| `ensureChallenge` | `onPaymentSuccess`, `onPaymentFailed` | none |

Without this separation, the defensive insert of the resolved paths inflated
the counter. This is the second bug the test revealed.

⚠️ To remember for phase 6: **a request carrying an invalid Credential issues
two Challenges** (the submitted one, then the fresh retry required by the
spec). `occurrences` counts Challenge issuances, not HTTP requests.

## Reconciliation views

```sql
select * from ledger_reconciliation;
-- status | entries | occurrences | total_base_units | first_at | last_at

select * from ledger_unsettled;
-- Challenges issued and never resolved: the normal case (a client may not pay),
-- but an abnormal volume signals a badly calibrated price or a broken client.
```

## Details that matter

- **Amounts are stored as TEXT.** They are base units, hence potentially large
  integers; SQLite's `REAL` would lose precision. The `cast(... as integer)`
  only appears in the aggregation views, where pathUSD fits comfortably in an
  int64.
- **A completed payment never regresses.** The `update`s carry a
  `where status != 'success'` guard, so a late `onPaymentFailed` cannot erase
  a collection.
- **Writes are synchronous.** Server handlers run inline on the paid request
  path; `better-sqlite3` being synchronous by design, we avoid introducing a
  queue. Statements are prepared once, at construction.
- **Free routes log nothing** — verified by test on `/healthz` and
  `/openapi.json`.

## `better-sqlite3`, not `node:sqlite`

`CLAUDE.md` announced `node:sqlite`. That module only exists from
**Node 22.5**; the project targets Node ≥ 20 and the machine runs 20.20.1
(`require('node:sqlite')` → `ERR_UNKNOWN_BUILTIN_MODULE`). We use
`better-sqlite3`. `CLAUDE.md` is corrected. See
[`DECISIONS.md` D11](../DECISIONS.md).

## Tests

20 tests: writes and state transitions, idempotence, occurrences counter,
non-regression of a success, normalized error codes, reconciliation,
unresolved Challenges, integration with the real provider (route captured
from `opaque`, free routes ignored), and the two anti-leak tests.

Suite run 8 times in a row after the fix to rule out flakiness.
