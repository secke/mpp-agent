# PLAN — Agentic Research Marketplace (MPP)

Split into 9 phases. **Rule**: one phase = one branch
(`phase-N-slug`) + green `vitest` tests before moving on.
Every delivered feature is documented in `docs/features/<slug>.md`.

Technical reference: `docs/NOTES.md` (sourced 402 spec, verified pitfalls).
Architecture decisions: `docs/DECISIONS.md`.

---

## Vision

A marketplace where **LLM agents** buy research services per call,
in testnet stablecoin, with no API key and no sign-up — via
HTTP 402 / MPP.

```
  agent/ (payer)                           server/ (provider)
  ┌──────────────────┐                     ┌──────────────────┐
  │ LLM + tool use   │  1. GET /v1/search  │  Hono + mppx     │
  │                  │ ──────────────────► │                  │
  │ budget guard     │  2. 402 + Challenge │  tempo.charge    │
  │ (onChallenge)    │ ◄────────────────── │  testnet:true    │
  │                  │  3. + Credential    │                  │
  │ mppx/client      │ ──────────────────► │ verify + settle  │
  │ polyfill:false   │  4. 200 + Receipt   │                  │
  └────────┬─────────┘ ◄────────────────── └────────┬─────────┘
           │                                        │
           └──────────────► ledger/ ◄───────────────┘
                     (SQLite, audit log)
```

---

## Phase 0 — Spec and documentation base ✅ **done**

**Goal**: understand the protocol before writing a line of code.

- [x] Read the MPP docs (protocol, transports, Tempo method, security)
- [x] Install `mppx` and inspect the real modules
- [x] `docs/NOTES.md`: 402 flow, headers, testnet config, real API, pitfalls

**Output**: `docs/NOTES.md`. Two major pitfalls identified and measured —
`testnet: true` mandatory (§4.1), `polyfill: false` mandatory (§5.4).

---

## Phase 1 — MPP provider: paid skeleton

**Branch**: `phase-1-provider`

**Goal**: a Hono server that answers a real, compliant 402, locked to the
testnet.

- [ ] `server/config.ts` — `.env` loading, strict validation, network guard
      (refuses to start outside testnet)
- [ ] `server/payment.ts` — `Mppx.create` instance + `tempo.charge({ testnet: true })`
- [ ] `server/app.ts` — Hono app, free `/healthz` route, paid `/v1/search`
      route, discovery route `/.well-known/mpp`
- [ ] `server/index.ts` — `@hono/node-server` entry point

**Exit criteria (tests)**
- `GET /healthz` → 200 without payment
- `GET /v1/search` without a Credential → **402**, `WWW-Authenticate: Payment …`
- security headers: `Cache-Control: no-store`, `application/problem+json`
- the decoded Challenge carries `methodDetails.chainId === 42431` **and**
  `currency === pathUSD` (anti-mainnet guard)
- the Challenge is HMAC-bound: `Challenge.verify(ch, { secretKey })` true,
  false with another secret
- `secretKey` < 32 bytes → startup refused

---

## Phase 2 — Paying agent and budget guard ✅ **done**

**Branch**: `phase-2-agent-payeur`

**Goal**: a client that pays on its own, but never beyond a budget.

- [x] `agent/amount.ts` — integer arithmetic (`bigint`), no rounding
- [x] `agent/wallet.ts` — viem account from `.env`, never hard-coded nor logged
- [x] `agent/budget.ts` — pure budget guard: 7 typed refusal reasons,
      reserve/confirm/release
- [x] `agent/client.ts` — `Mppx.create({ polyfill: false, onChallenge })`
      + SDK guardrails (`expectedChainId`, `allowedChainIds`, `expectedRecipients`)

**Exit criteria (tests)** — 40 tests
- [x] `polyfill: false` verified: `globalThis.fetch` unchanged after creation
- [x] above the per-call cap → refusal, **no signature issued**
- [x] total budget exhausted → refusal
- [x] cumulative spend correctly counted (including concurrent commitments)
- [x] malformed amount / unexpected currency / missing chain → refusal (fail-closed)

**Major finding**: returning `undefined` from `onChallenge` **does not refuse**
the payment — you have to throw. Corrects an error in `NOTES.md` §5.4.
See [`DECISIONS.md` D7](docs/DECISIONS.md).

---

## Phase 3 — SQLite ledger ✅ **done**

**Branch**: `phase-3-ledger`

**Goal**: payments audit log, server side and agent side.

- [x] `ledger/schema.sql` + `ledger/db.ts` (**`better-sqlite3`**, not
      `node:sqlite`: unavailable before Node 22.5 — see D11)
- [x] `ledger/record.ts` — written from `onChallengeCreated`,
      `onPaymentSuccess`, `onPaymentFailed`
- [x] `ledger_reconciliation` and `ledger_unsettled` views

**Exit criteria (tests)** — 20 tests
- [x] a 402 cycle → one `challenged` row, then `success` with reference and payer
- [x] a failure writes `failed` with the normalized MPP error code
- [x] **no secret logged**: binary read of the SQLite file +
      assertion on the exact column list
- [x] idempotence: replaying the same `challenge.id` does not duplicate a row

**Major finding**: the Challenge id **does not identify a request** —
19 collisions out of 50 rapid requests. Hence the `occurrences` counter.
See [`DECISIONS.md` D12](docs/DECISIONS.md).

---

## Phase 4 — LLM agent with tool use ✅ **done**

**Branch**: `phase-4-agent-llm`

**Goal**: the model decides *by itself* to buy a search.

- [x] `agent/llm.ts` — `LlmClient` port + **DeepSeek** client (OpenAI-compatible
      API; no `@anthropic-ai/sdk`, see D14)
- [x] `agent/tools.ts` — `search_marketplace` tool and its executor
- [x] `agent/loop.ts` — tool use loop, bounded in turns and purchases
- [x] `agent/index.ts` — demo (`npm run agent -- "…"`)
- [x] The budget guard remains the final authority

**Exit criteria (tests)** — 29 tests
- [x] loop tested with a scripted model (no network call in CI)
- [x] a guard refusal comes back as a usable `tool_result`, never as an
      exception; a terminal refusal disables the tool so the model concludes
- [x] no private key, no Credential, no raw error message reaches the model
      context

**Demonstrated for real** against the provider and the DeepSeek model:
insufficient budget → `per-call-cap` refusal, the model concludes in 2 turns
mentioning the limit; sufficient budget but empty wallet → `search-unavailable`,
the model retries once. `spent: 0` in both cases — the reservation is indeed
released.

---

## Phase 5 — Real testnet E2E ✅ **done**

**Branch**: `phase-5-e2e-testnet`

**Goal**: a real on-chain payment on Moderato.

- [x] `agent` (payer, funded) and `provider` (recipient) accounts
- [x] `tests/e2e/payment.e2e.test.ts`: agent → server → real pathUSD
      transfer → `Payment-Receipt`
- [x] Verification of the transaction hash on the RPC **and** of the balance delta

**Exit criteria**
- [x] `*.e2e.test.ts` test excluded from `npm test`, run by `npm run test:e2e`,
      skipped without `AGENT_PRIVATE_KEY`
- [x] the Receipt `reference` matches a transaction confirmed on 42431
      (block 36470584, `status: 0x1`)
- [x] the recipient balance increases **exactly** by the price (+0.50 pathUSD)
- [x] replay protection proven: the captured and replayed Credential → **402**

---

## Phase 6 — Prometheus observability ✅ **done** (one caveat)

**Branch**: `phase-6-observabilite`

- [x] `/metrics`: issued challenges, successful/failed payments, settlement
      latency, cumulative agent spend
- [x] Safe labels only (method, intent, status) — never a payment identifier
      nor a nominal amount

**Exit criteria**: a test that asserts the presence of the series and
the **absence** of any sensitive value in the export. ✅ (4 tests)

`/metrics` protected by a bearer token (`METRICS_TOKEN`); the agent gauges
are served by the agent process (`agent/metrics-server.ts`, branch
`phase-6b-metriques-agent`). ⚠️ Short-lived agent: bounded scrape window.

---

## Phase 7 — Docker Compose ✅ **done**

**Branch**: `phase-7-docker`

- [x] `Dockerfile` (multi-stage, non-root), `compose.yml`: server + agent +
      Prometheus
- [x] Secrets injected by the environment, never in the image

**Exit criteria**: `docker compose up` → `/healthz` and `/metrics`
respond; `docker history` reveals no secret. ✅ (`/metrics` requires the
token). The full `agent` service was also run end to end under Compose.

---

## Phase 8 — Hardening ✅ **done** (one caveat)

**Branch**: `phase-8-durcissement` — *handled before phases 6 and 7,
to close the one real security hole.*

- [x] Body binding on `POST /v1/analyze` — via `scope` + `BodyDigest`,
      the mppx TS server having **no** `body` option (see D20)
- [x] Shared **and durable** replay store: `sqlite` (default) or `redis`,
      the memory store refused without an explicit acknowledgement (D21)
- [ ] ⚠️ `MPP_SECRET_KEY` rotation with overlap — **not implemented**:
      `Mppx.create` takes a single key. A coordinated procedure is documented
      instead, window bounded to 5 min (D22)
- [x] `Cache-Control: private` on 200s carrying a Receipt
- [x] Security review against `docs/NOTES.md` §8 — 9 requirements out of 10

**Exit criteria**
- [x] body modified after Challenge issuance → `invalid-challenge`
      (versus `verification-failed` with the original body: the contrast
      is what proves the discrimination)
- [x] replayed Credential → 402, marker **persisted to disk**
- [x] §8 checklist: 9/10, the tenth blocked by the SDK and documented

---

## Out of scope (for the record)

Available in `mppx` but deliberately postponed: `session` intent
(usage-based billing), `subscription` intent, billed SSE streaming,
x402 compatibility, card payments (Stripe). See `docs/NOTES.md` §6.
We will consider them once the `charge` flow is covered end to end.
