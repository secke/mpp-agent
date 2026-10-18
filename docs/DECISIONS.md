# DECISIONS — architecture decision log

Format: one decision = context, choice, consequence. Decisions coming from
phase 0 are sourced in `docs/NOTES.md`.

---

## D1 — `mppx` (TypeScript) SDK rather than `pympp` (Python)
**Phase 0 · revised after the stack change**

`CLAUDE.md` announced "official mppx SDK (Python)". That was contradictory:
`mppx` is the **TypeScript** SDK, the Python SDK is called `pympp`. The project
switched to TypeScript, which makes `mppx` correct.

**Consequence**: Node ≥ 20 / ESM stack. All the limits of `pympp`
(no `session`, no `subscription`, no `proof`, no proxy) disappear — see NOTES §6.

---

## D2 — Hono as the server framework
**Phase 1**

`mppx` provides native adapters for Elysia, Express, Hono and Next.js.
Hono is the closest to FastAPI (light, typed, per-route middleware) and its
`app.request()` lets the application be tested in memory, without opening a
port.

**Consequence**: phase 1 tests exercise the real HTTP pipeline without a
network. `@hono/node-server` is only used at the entry point.

---

## D3 — `testnet: true`, never `chainId` alone
**Phase 0 · measured**

Phase 0 measurement (NOTES §4.1): `tempo.charge({ chainId: 42431 })` issues a
Challenge announcing `chainId: 4217` (**mainnet**) with a testnet currency.
`mppx.charge({ chainId })` at route level produces the opposite inconsistency.
Only `testnet: true` aligns chain and currency.

**Consequence**: `testnet: true` is the only allowed setting, backed by two
guards (`MPP_NETWORK` at load time, `assertTestnetChallenge` at runtime) and a
startup self-test. The cost of a mistake here is real money.

---

## D4 — Two guards rather than one
**Phase 1**

A single check (the config) does not protect against an SDK regression or an
upstream default change. We therefore also validate the Challenge **actually
issued**, live, at startup.

**Consequence**: `selfCheck()` blocks the port from opening if the Challenge is
not anchored on 42431 + pathUSD.

---

## D5 — SQLite reserved for the business ledger
**Phase 0**

`mppx` exposes no SQLite store (`Store.memory`, `redis`, `upstash`,
`cloudflare` only). Two distinct needs:

| Need | Building block |
|---|---|
| Credential replay protection (protocol) | `Store.AtomicStore` passed to `tempo.charge({ store })` |
| Business audit log | our code, SQLite |

**Consequence**: do not confuse the two in phase 3. (Phase 8 later adds a
SQLite-backed `Store.AtomicStore` for replay protection — a separate database
from the ledger. See D21.)

---

## D6 — Fake search service in phase 1
**Phase 1**

The point of phase 1 is the payment flow. A real engine would introduce
dependencies and latency while proving nothing about the 402.

**Consequence**: `server/search.ts` is deterministic and has no I/O. The
**shape** of the response is stable; the implementation will be replaced later.

---

## D7 — Refusing a payment is done by throwing, not by returning `undefined`
**Phase 2 · measured · corrects a phase 0 error**

`NOTES.md` §5.4 first claimed that returning `undefined` from `onChallenge`
amounted to not paying — a deduction from the wording of the docs. The code
says the opposite (`client/internal/Fetch.js` l.153):
`const credential = onChallengeCredential ?? (await createCredential())`.

Measured: with `onChallenge` returning `undefined`, the client goes all the way
to the on-chain transaction and only fails on a zero balance. A funded wallet
would have paid.

**Consequence**: `BudgetDenied` is an exception, never a return value. Two
tests lock the invariant (no call to `createCredential` on a refusal, no
request replayed). `NOTES.md` has been corrected.

---

## D8 — Pure budget guard, separate from the client
**Phase 2**

The logic that authorizes a spend depends on neither the network, nor the SDK,
nor a wallet. `agent/budget.ts` only imports the `Challenge` type.

**Consequence**: 26 exhaustive tests in 15 ms, including the twisted cases
(missing amount, missing chain, concurrency). The `onChallenge` handler is
extracted into `createChallengeHandler(guard)` so it is testable with an
injected `createCredential` — which makes it possible to cover the "authorized"
path without paying.

---

## D9 — Reserve at authorization, confirm at payment
**Phase 2**

Counting the spend only at confirmation lets two concurrent calls cross the cap
together. We therefore commit the amount as soon as it is authorized;
`remaining = total − committed − reserved`.

**Consequence**: when an outcome is unknown, the commitment stays committed.
Over-counting stops the agent too early; under-counting makes it overspend.
Only the first error is tolerable.

---

## D10 — Amounts in `bigint`, never `number`
**Phase 2**

MPP amounts are base units in a string. Every conversion goes through
`agent/amount.ts` in integer arithmetic. More decimals than the token has ⇒
**refusal**, never rounding.

**Consequence**: a silent rounding on an amount is a loss of money with no
trace. The refusal is loud, hence fixable.

---

## D11 — `better-sqlite3` rather than `node:sqlite`
**Phase 3 · corrects `CLAUDE.md`**

`CLAUDE.md` announced "SQLite via `node:sqlite`". This built-in module only
exists from **Node 22.5**; the project targets Node ≥ 20 and the machine runs
20.20.1 — `require('node:sqlite')` returns `ERR_UNKNOWN_BUILTIN_MODULE`.

**Consequence**: `better-sqlite3` (synchronous API). Its synchronicity is an
advantage here: mppx server handlers run inline on the paid request path, so
there is no queue to manage. `CLAUDE.md` is corrected.

---

## D12 — The Challenge id does not identify a request: `occurrences` counter
**Phase 3 · measured**

The Challenge id is an HMAC of its parameters, hence a pure function. Between
two identical requests, only `expires` varies — to the millisecond. Measured:
**19 collisions out of 50 rapid requests** on the phase 1 provider.

A log indexed on `challenge_id` therefore merges distinct requests. This is
what made a test flaky before it was understood.

**Consequence**: `challenge_id` stays the primary key (deduplicating is correct
at protocol level), but an `occurrences` column counts issuances, and
reconciliation multiplies by it. Two distinct writes follow: `recordChallenge`
(counts) for `onChallengeCreated`, `ensureChallenge` (does not count) for the
success/failed paths — otherwise the defensive insert of the latter inflates
the counter.

To remember for phase 6: a request with an invalid Credential issues **two**
Challenges (the submitted one + the retry). `occurrences` counts issuances,
not HTTP requests.

---

## D13 — The ledger stores references, never proofs
**Phase 3**

The schema offers no column where a Credential, a raw Receipt or free text
could be stored — error messages included, since `PaymentError.details` may
contain a Credential or a hash. We store the Challenge id, the transaction
hash, the payer DID and the normalized error code.

**Consequence**: the leak is structurally impossible, not merely avoided by
discipline. Two tests lock it in, one of which reads the SQLite file in binary.

---

## D14 — DeepSeek instead of Anthropic
**Phase 4 · corrects `CLAUDE.md`**

No Anthropic credit available. DeepSeek exposes an **OpenAI-compatible** API
(`base_url = https://api.deepseek.com`, `openai` SDK), with tool calling in the
standard format — verified by a real call before writing a single line, as was
the model list (`deepseek-flash`, `deepseek-v4-pro`) via `GET /models`.

**Consequence**: `CLAUDE.md` corrected. DeepSeek's "thinking" mode is disabled
by default: it burns reasoning tokens with no benefit for a framed tool loop.

---

## D15 — The agent talks to a port, not to an SDK
**Phase 4**

`agent/llm.ts` defines `LlmClient { turn(messages, tools) }`. The rest of the
agent only knows this type; the OpenAI SDK only lives in `createLlm`.

**Consequence**: the loop is tested with a scripted model, with no network or
credit consumed in CI (29 tests). Switching provider does not touch the logic.
The `fetch` transport is also injectable, which makes it possible to test the
translation to Chat Completions.

---

## D16 — A guard refusal is a `tool_result`, not an exception
**Phase 4**

If the refusal bubbled up as an exception, the loop would break and the model
would have no way to take it into account. The executor therefore returns
`{ ok: false, code, message, hint, retryable }`, and a non-retryable refusal
disables the tool for the next turn.

**Consequence, observed for real**: on insufficient budget, the model concludes
in two turns explicitly flagging the limit; on a technical failure
(`retryable: true`), it retries once then concludes. The `hint` carries the
instruction, not just the diagnosis.

---

## D17 — The model context is a security boundary
**Phase 4**

Only the purchased data, the amount spent and the remaining budget go up to the
model. **Raw error messages** are held back on a par with Credentials: a
signing failure may contain a transaction hash or a Credential. The model
receives a generic `search-unavailable`.

**Consequence**: a test sweeps all the messages sent and looks for any `0x` +
64 hex pattern, any `Authorization`, any Credential.

---

## D18 — The e2e checks the funds, not just the Receipt
**Phase 5**

A Receipt is declarative: the server asserts the payment took place. The test
therefore re-reads the recipient's pathUSD balance **before and after**, and
requires a delta exactly equal to the price — then confirms the transaction via
`eth_getTransactionReceipt`.

**Consequence**: payer and recipient are two distinct accounts (`agent` and
`provider`), otherwise the delta would prove nothing.

---

## D19 — Tests that spend are isolated and self-skipping
**Phase 5**

`*.e2e.test.ts` is excluded from `npm test` and run by `npm run test:e2e`.
Without `AGENT_PRIVATE_KEY`, the test skips itself instead of failing.

**Consequence**: CI spends nothing and does not break for lack of a wallet.
`loadDotEnv` stays confined to the e2e tests: unit tests depend on no secret
and no local file, and must not start doing so.

---

## D20 — Body binding goes through `scope`, for lack of a `body` option
**Phase 8**

The spec requires a `digest` binding the body on POST/PUT/PATCH. The
`mppx` TypeScript server exposes **neither `body` nor `digest`** on its
middleware (`MethodFn.Options`: `description`, `expires`, `meta`, `scope`) —
unlike the Python SDK, which has `mpp.charge(body=…)`.

We therefore put the digest in `scope`, which mppx merges into `meta` →
`opaque` → the Challenge HMAC input. The middleware is built **per request**,
`scope` being a static option.

**Consequence**: modified body ⇒ different scope ⇒ different Challenge id ⇒
`invalid-challenge`. The test relies on the contrast with
`verification-failed` (original body), which proves the discrimination without
spending a cent.

---

## D21 — The memory store can no longer be chosen by accident
**Phase 8**

The `tempo.charge` default is a memory store: neither shared between processes,
**nor durable**. The second point is the more insidious — a restart reopens the
replay window even on a single instance.

`REPLAY_STORE` defaults to `sqlite`; `memory` requires
`REPLAY_STORE_MEMORY_ACK=i-know` otherwise the server refuses to start.

**Consequence**: a common store contract is run against the three backends
(including a real Redis in a container), which makes them truly
interchangeable. The e2e test uses `createReplayStore(config)` — the same
wiring as in production, otherwise it would prove nothing.

---

## D22 — Secret rotation: coordinated procedure, no untested machinery
**Phase 8 · accepted caveat**

`Mppx.create` takes a single `secretKey?: string`: no notion of a previous key,
hence no native overlap. Two workarounds were discarded — a cascade of two
instances (cannot be validated without multiplying real payments) and a key
identifier in the `scope` (no effect, it is the HMAC that fails).

**Decision**: do not ship untested security machinery. Instead, a coordinated
deployment procedure, with a **bounded and known** window (5 min, the mppx
default `expires`): drain, wait, swap.

**Consequence**: a short window of 402s with a fresh Challenge during rotation
— degradation, not outage. To be reopened if `mppx` ever accepts a list of
keys.

---

## D23 — `/metrics` is opt-in and token-protected
**Phase 6**

The Prometheus export reveals traffic and failure volumes. It is therefore
**absent by default**: without `METRICS_TOKEN` (≥ 16 chars), the route does not
exist (404); with it, `Authorization: Bearer …` is required (constant-time
comparison via `hono/bearer-auth`). Labels are limited to `method`, `intent`,
`status` and a normalized error `code` — never a Challenge id, payer, reference
or amount.

**Consequence**: a test checks the allowlist of label names and the absence of
the secret, id, recipient, query and amount in the export.

---

## D24 — The agent serves its own `/metrics`, then lingers
**Phase 6b**

The agent is a short-lived command, so a scrape target that disappears with the
process is awkward. `agent/metrics-server.ts` serves `/metrics` (same bearer
token) during the run and keeps it up for `AGENT_METRICS_LINGER` seconds after
the end, giving Prometheus time for a scrape.

**Consequence**: simple, no extra service, but a missed scrape window loses the
final value. A Pushgateway would be the robust alternative, at the cost of one
more service. Under Compose, run the agent with `--use-aliases` so `agent:9464`
resolves.
