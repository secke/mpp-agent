# Project: Agentic Research Marketplace (MPP)

## Absolute rules
- NEVER invent an API. Before any code using mppx, read the matching doc
  page (mpp.dev) or the types of the installed SDK
  (`node_modules/mppx/dist/**/*.d.ts`), and cite the source in a comment.
- Testnet only. Private keys in .env (gitignored), never hard-coded.
- One phase = one branch + passing `vitest` tests before moving on.
- If the docs and this file contradict each other, the docs win: flag it.

## Stack
Node.js >= 20 (ESM), TypeScript, Hono (HTTP server),
official **mppx** SDK (TypeScript), viem (accounts/signing),
`openai` SDK pointed at **DeepSeek** (OpenAI-compatible API, tool use),
SQLite via `better-sqlite3` (business ledger), vitest, Docker Compose, Prometheus.

> History: phase 0 was first researched in Python (`pympp`).
> The project moved to TypeScript; `mppx` is the official **TS** SDK.
> See `docs/NOTES.md` §0 for the stack correspondence table.

## Structure
server/   # MPP provider (Hono + mppx/hono)
agent/    # paying LLM agent, budget guard
ledger/   # transaction log (SQLite)
tests/    # testnet e2e + unit (vitest)
docs/     # NOTES.md (spec), DECISIONS.md, features/

## Non-negotiable invariants (see docs/NOTES.md)
- Testnet: always `tempo.charge({ testnet: true })`.
  NEVER `chainId` alone — it yields an inconsistent config (NOTES §4.1).
- Agent client: always `Mppx.create({ polyfill: false })`.
  The default `true` patches `globalThis.fetch` and makes the budget guard
  bypassable (NOTES §5.4).
- The budget guard is implemented in the client's `onChallenge` hook.
- Never log: MPP_SECRET_KEY, `Authorization: Payment`,
  `Payment-Authorization: Payment`, `Payment-Receipt` (NOTES §8).
- `MPP_SECRET_KEY` >= 32 bytes (enforced by the SDK).
- Refusing a payment client-side = **throw** from `onChallenge`.
  Returning `undefined` makes it pay (NOTES §5.4).
- The ledger never stores a Credential, a raw Receipt, a secret
  or an error message — only references (NOTES §8).
- A budget guard refusal goes back to the model as a structured `tool_result`,
  never as an exception: it must be able to take it into account.
- No private key, no Credential, no raw error message
  enters the model context.
- Replay protection: never the default mppx memory store in production —
  neither shared between processes, nor durable. `sqlite` (single host) or `redis`.
- Body routes (POST/PUT/PATCH): bind the body to the Challenge via `scope`
  + `BodyDigest.compute`. The mppx TS server has no `body` option.
- `Cache-Control: private` on 200s carrying a `Payment-Receipt`
  (mppx only sets `no-store` on 402s).

## Plan
Phases 0 to 8: see `PLAN.md`.
Every delivered feature is documented in `docs/features/`.
