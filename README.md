# Agentic Research Marketplace (MPP)

A minimal marketplace where **LLM agents buy services per call**, in **testnet**
stablecoin, **with no API key and no sign-up** — via HTTP 402 and the
[Machine Payments Protocol](https://mpp.dev) (official [`mppx`](https://mpp.dev) SDK).

> ⚠️ **Testnet only.** The server refuses to start outside Tempo Moderato
> (chain 42431, `pathUSD` token). Never put real funds in the accounts used here.

```
  agent/ (payer)                           server/ (provider)
  ┌──────────────────┐                     ┌──────────────────┐
  │ LLM + tool use   │  1. GET /v1/search  │  Hono + mppx     │
  │                  │ ──────────────────► │                  │
  │ budget guard     │  2. 402 + Challenge │  tempo.charge    │
  │ (onChallenge)    │ ◄────────────────── │  testnet: true   │
  │                  │  3. + Credential    │                  │
  │ mppx/client      │ ──────────────────► │ verify + settle  │
  │ polyfill: false  │  4. 200 + Receipt   │                  │
  └────────┬─────────┘ ◄────────────────── └────────┬─────────┘
           └──────────────► ledger/ ◄───────────────┘
                     (SQLite, audit log)
```

## Why this project

An agent that has to pay for a resource today has two bad options: a human API
key (sign-up, monthly billing) or no guarantee at all about what it spends. This
repository shows a third way, complete and tested:

- **For the seller**: a normal HTTP endpoint that answers `402 Payment Required`
  with a price, then serves the resource once payment is verified.
- **For the agent**: a client that pays on its own, but **whose spending is
  bounded by a budget guard** that a model cannot bypass.
- **For the auditor**: a SQLite payment log, Prometheus metrics, and a security
  review against the MPP requirements.

What the project adds beyond the example in the docs:

| Topic | What is done |
|---|---|
| Budget | Per-call cap + total envelope, integer arithmetic, 7 typed refusal reasons, reserve/release for concurrent calls. |
| Refusals | A guard refusal comes back to the model as a structured `tool_result`, never as an exception. |
| Secrets | No private key, Credential or raw error message enters the model context or the logs. |
| Replay protection | `sqlite` (durable) or `redis` (shared) store. The memory store is refused without an explicit acknowledgement. |
| Request body | `POST /v1/analyze` binds the body to the Challenge (`scope` + `BodyDigest`). |
| Audit | SQLite ledger (never a raw Credential/Receipt), reconciliation views. |
| Observability | Token-protected Prometheus `/metrics`, safe labels only. |

The pitfalls hit along the way (and measured) are documented in
[`docs/NOTES.md`](docs/NOTES.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Prerequisites

- Node.js **≥ 20**
- A **DeepSeek** API key (for the LLM agent) — [api-docs.deepseek.com](https://api-docs.deepseek.com/)
- Docker + Docker Compose (optional, for the full stack)
- Network access to the Tempo testnet RPC (`https://rpc.moderato.tempo.xyz`)

## Step-by-step quick start

### 1. Install

```bash
git clone https://github.com/secke/mpp-agent.git
cd mpp-agent
npm install
cp .env.example .env
```

`.env` is ignored by git. **Never commit a secret.**

### 2. Create two testnet accounts

The provider **collects**, the agent **pays**: two distinct accounts.

```bash
npx mppx account create --account main      # recipient (provider)
npx mppx account create --account agent     # payer
npx mppx account fund --network testnet --account agent
npx mppx account view --account main        # address → MPP_RECIPIENT
npx mppx account export --account agent     # key     → AGENT_PRIVATE_KEY
```

### 3. Fill in `.env`

| Variable | Role |
|---|---|
| `MPP_SECRET_KEY` | HMAC secret for Challenges, **≥ 32 bytes** (`openssl rand -base64 32`). |
| `MPP_RECIPIENT` | Address that collects the payments. |
| `AGENT_PRIVATE_KEY` | Key of the paying wallet (testnet). |
| `DEEPSEEK_API_KEY` | Model key. |
| `AGENT_MAX_PER_CALL` / `AGENT_TOTAL_BUDGET` | Per-call cap / total envelope. |
| `REPLAY_STORE` | `sqlite` (default) or `redis` (+ `REDIS_URL`). |
| `METRICS_TOKEN` | Optional, ≥ 16 chars. Without it, `/metrics` does not exist. |

Every variable is commented in [`.env.example`](.env.example).

### 4. Run the provider

```bash
npm run dev
curl -i http://localhost:8787/healthz           # 200, free
curl -i "http://localhost:8787/v1/search?q=mpp" # 402 + WWW-Authenticate: Payment …
```

### 5. Run the agent

In a second terminal:

```bash
npm run agent -- "What does the MPP documentation say about Credential replay?"
```

The model decides to call the paid tool, the agent pays (0.50 pathUSD by default),
the budget guard approves the spend, and the model answers. To see a refusal, set
`AGENT_MAX_PER_CALL=0.10` — the model receives a `per-call-cap` and concludes by
mentioning it, without any signature being issued.

> The search service (`server/search.ts`) is **fake and deterministic**: it
> validates the payment chain, not the quality of results. See "Evolving the project".

### 6. Run the tests

```bash
npm test            # unit + integration, no network, no funds
npm run typecheck
npm run test:e2e    # ⚠️ SPENDS testnet funds and calls the public RPC
```

`npm run test:e2e` is skipped without `AGENT_PRIVATE_KEY`. It proves a payment
confirmed on-chain, the exact balance delta, and the rejection of a replayed
Credential.

### 7. Full stack with Docker Compose

```bash
export METRICS_TOKEN=$(openssl rand -hex 16)   # or in .env
docker compose up -d --build                   # server + Prometheus
docker compose --profile agent run --rm --use-aliases agent "your question"
```

- The server listens on `127.0.0.1:8787`, Prometheus on `127.0.0.1:9090`.
- `--use-aliases` is required so Prometheus can resolve `agent:9464`.
- Secrets are injected at runtime; the image contains none.

Details: [`docs/features/docker.md`](docs/features/docker.md),
[`docs/features/observability.md`](docs/features/observability.md).

## Layout

```
server/         MPP provider (Hono + mppx/hono), config, replay stores
agent/          paying client, budget guard, LLM loop, tools
ledger/         SQLite audit log
observability/  Prometheus metrics
tests/          unit, integration, testnet e2e (vitest)
docs/           NOTES.md (spec), DECISIONS.md, features/ (one page per feature)
```

## Evolving the project

### Sell another service

1. Replace `server/search.ts` with your engine (keep the `SearchResult[]` shape
   or adapt the route).
2. Add a route in `server/app.ts` protected by `payment.charge({ amount, description })`.
3. For a **POST/PUT/PATCH** route, bind the body to the Challenge as
   `/v1/analyze` does (`scope` + `BodyDigest.compute`): the TS mppx server has no
   `body` option.
4. Add the test in `tests/server/`: 402 without a Credential, right amount, right network.

### Give the agent a new tool

A tool = a definition + an executor in `agent/tools.ts`. Keep the rule: the
executor calls `mppx.fetch`, **the guard stays the final authority**, and every
error is converted to a structured `tool_result` — never a raw message to the model.

### Switch model

`agent/llm.ts` defines an `LlmClient` port. The DeepSeek client goes through the
`openai` SDK (compatible API); implement the same port for another provider.
`agent/loop.ts` is tested with a scripted model, with no network.

### Go beyond the testnet

The testnet guard is deliberate (`server/config.ts`, `server/payment.ts`).
Switching network is a security decision, not a setting: re-read
[`docs/NOTES.md`](docs/NOTES.md) §4 and §8 and update the guard tests before
touching `testnet: true`.

### Not done yet

`session` and `subscription` intents, billed SSE streaming, `MPP_SECRET_KEY`
rotation with overlap (the SDK only accepts one key — see D22), a Pushgateway
for short-lived agent metrics. See [`PLAN.md`](PLAN.md).

## Using it in your own projects

The repository is not published on npm (`"private": true`). Two ways to reuse it:

**Copy the provider** — you already have a Hono API:

```ts
import { Mppx, tempo } from 'mppx/hono'

const payment = Mppx.create({
  methods: [tempo.charge({ testnet: true, recipient, currency, decimals: 6, store })],
  realm, secretKey,
})
app.get('/my-route', payment.charge({ amount: '0.10' }), (c) => c.json({ ok: true }))
```

Take `server/payment.ts` (consistent configuration, `testnet: true`, never
`chainId` alone) and `server/stores.ts` (durable replay store).

**Copy the paying agent** — you already have an agent:

- `agent/client.ts`: `Mppx.create({ polyfill: false, onChallenge })`. Keep
  `polyfill: false` — the default patches `globalThis.fetch` and makes the guard bypassable.
- `agent/budget.ts`: the guard is pure (no network) and reusable on its own.
- Refusing a payment = **throw** from `onChallenge`; returning `undefined` pays.

In both cases, read [`docs/NOTES.md`](docs/NOTES.md) first: each pitfall is
measured there, with its source.

## Security

- Testnet only; keys in `.env` (gitignored), never hard-coded.
- Never log: `MPP_SECRET_KEY`, `Authorization: Payment`, `Payment-Receipt`.
- The ledger only stores references, never a Credential or an error message.
- `/metrics` requires a bearer token and is absent by default.
- `MPP_SECRET_KEY` rotation: coordinated procedure documented in D22
  (window bounded to 5 min), no automatic overlap.

To report a vulnerability, open a private GitHub security advisory rather than a
public issue.

## Documentation

- [`docs/NOTES.md`](docs/NOTES.md) — 402 flow specification and verified pitfalls
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architecture decisions
- [`docs/features/`](docs/features/README.md) — one page per feature
- [`PLAN.md`](PLAN.md) — phases 0 to 8

## License

[MIT](LICENSE) © 2026 secke
