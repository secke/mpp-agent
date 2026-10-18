# NOTES — Phase 0: MPP / HTTP 402 flow spec (TypeScript stack)

> Sourced reference document. **No API is cited here without having been either read in
> the official docs (mpp.dev), verified by introspection of the SDK actually installed,
> or proven by an executed script.** Each section states its source.
> Written on 2026-09-20. Target SDK: **`mppx` 0.10.1** (TypeScript).

---

## 0. State of `CLAUDE.md` after the move to TypeScript

| # | `CLAUDE.md` said | Reality (source) | Status |
|---|---|---|---|
| 1 | "official **mppx** SDK" | ✅ **Correct in TypeScript.** `mppx` is indeed the official TS SDK (repo `wevm/mppx`, npm `mppx@0.10.1`). It was the "(Python)" mention that was wrong: the Python SDK is called `pympp`. | **Resolved** by the move to TS. Remove "(Python)". |
| 2 | "Python 3.12, FastAPI, httpx, Anthropic SDK (Python), pytest" | Abandoned stack. | **`CLAUDE.md` to rewrite** — see table §0.1. |
| 3 | "SQLite (ledger)" | `mppx` exposes **no** SQLite store: `Store.memory`, `Store.redis`, `Store.upstash`, `Store.cloudflare` only (`node_modules/mppx/dist/Store.d.ts`). | SQLite remains possible for **our** business ledger (via `node:sqlite`), but **not** as the `mppx` replay store. See §5.5. |
| 4 | "Start with phase 0 (see `PLAN.md`)" | **`PLAN.md` is still missing from the repo.** | **Blocking for phase 1.** |

### 0.1 Proposed stack correspondence

| Role | `CLAUDE.md` (Python) | TypeScript equivalent chosen | Justification |
|---|---|---|---|
| Runtime | Python 3.12 | **Node.js ≥ 20** (here v20.20.1) | `mppx` is ESM, `type: "module"` |
| Server framework | FastAPI | **Hono** | native adapter `mppx/hono`; official alternatives: Express, Elysia, Next.js (<https://mpp.dev/sdk/typescript/middlewares/hono>) |
| HTTP client | httpx | **`fetch`** wrapped by `mppx/client` | the SDK is built around `fetch` |
| MPP SDK | `pympp` | **`mppx`** | § above |
| LLM SDK | `anthropic` (Python) | **`@anthropic-ai/sdk`** | paying agent with tool use |
| Tests | pytest | **Vitest** (installed: 4.1.11) | idiomatic TS |
| Crypto/account | eth-account | **`viem`** (installed: 2.56.8) | peer dependency of `mppx` |

> ⚠️ **Hono is a default choice on my part**, the closest to FastAPI (light, typed,
> per-route middleware). Express and Elysia are also natively supported. To be confirmed.

---

## 1. What MPP is

MPP (*Machine Payments Protocol*) is an open machine-to-machine payment standard built
on `HTTP 402 Payment Required`, with a **Challenge → Credential → Receipt** model.
Reference IETF specification: <https://paymentauth.org>.

Source: <https://mpp.dev/> and <https://mpp.dev/protocol/>.

---

## 2. The 402 flow, step by step

Source: <https://mpp.dev/protocol/transports/http> and <https://mpp.dev/protocol/http-402>.

```
1. Client  → Server    GET /api/data
2. Server  → Client    402 Payment Required
                       WWW-Authenticate: Payment id="abc123", realm="...",
                                         method="tempo", intent="charge", request="eyJ..."
3. Client  → Server    GET /api/data
                       Authorization: Payment eyJjaGFsbGVuZ2Ui...
4. Server  → Client    200 OK
                       Payment-Receipt: eyJzdGF0dXMiOiJzdWNjZXNzIi4uLn0
```

### When to answer 402 (and nothing else)

| Condition | Code |
|---|---|
| The resource requires payment | **402** |
| Client not authenticated | 401 |
| Authenticated but not authorized | 403 |
| Nonexistent resource | 404 |

Important point: **MPP returns 402 even when a Credential fails validation**
(where other HTTP auth schemes would return 401), with a **fresh Challenge** each
time. Source: <https://mpp.dev/protocol/http-402> § "Status code comparison".

If the resource *also* requires application authentication: check the token first,
return 401 if it fails, and only return 402 after success — so as not to disclose
pricing conditions to unauthenticated clients. Same source.

### Error body

Payment failure → 402 + `Content-Type: application/problem+json` + `Cache-Control: no-store`.
Normalized types (`https://paymentauth.org/problems/<type>`): `invalid-challenge`,
`malformed-credential`, `method-unsupported` (400), `payment-expired`,
`payment-insufficient`, `payment-required`, `verification-failed`.

✅ **Verified**: `mppx` does emit `Cache-Control: no-store` and
`Content-Type: application/problem+json` by itself on the 402 (see §5.6).

---

## 3. The headers

Source: <https://mpp.dev/protocol/transports/http> § "Headers".

| Direction | Header | Role |
|---|---|---|
| Server → Client | `WWW-Authenticate: Payment ...` | Challenge |
| Client → Server | `Authorization: Payment ...` | Credential (default case) |
| Client → Server | `Payment-Authorization: Payment ...` | Credential when the Challenge carries `header="Payment-Authorization"` |
| Server → Client | `Payment-Receipt: ...` | Receipt (**optional**, for auditability) |

`Payment-Authorization` is for coexisting with an application auth that already uses
`Authorization`. On the `mppx` side: `Mppx.create({ requiresAuth: true })`.

### 3.1 Challenge (`WWW-Authenticate`)

Source: <https://mpp.dev/protocol/challenges>.

**Required** parameters: `id`, `realm`, `method`, `intent`, `request`.
**Optional**: `description`, `digest`, `expires`, `header`, `opaque`.

`request` and `opaque` are **base64url strings of JCS-canonicalized JSON**
([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)). The decoded `request`:

```json
{ "amount": "500000", "currency": "0x20c0…", "recipient": "0xf39F…",
  "methodDetails": { "chainId": 42431 } }
```

`amount` is in **base units** (pathUSD, 6 decimals → `"500000"` = $0.50).

**Challenge binding — security requirement.** The server must bind `id` to the expected
parameters, otherwise a client can reuse an `id` with modified conditions.
Canonical HMAC input:

```
realm | method | intent | request | expires | digest | opaque
```

…and when the Challenge announces `header`, its value is inserted **just before** `opaque`.
Absent optional slots are the empty string; `Authorization` being the implicit default,
it is never announced nor folded into the HMAC.

*Confirmed in the installed SDK*: `node_modules/mppx/dist/Challenge.d.ts`, JSDoc of
`Challenge.from` — "HMAC-SHA256 over the canonical challenge ID input
(`realm|method|intent|request|expires|digest|opaque`)".
The same formula appears word for word in the Python SDK (`pympp`), so it is indeed
cross-implementation.

Several `WWW-Authenticate` headers may be returned to offer several payment methods;
the client picks one and submits **a single** Credential.

🔍 **Measured consequence (phase 3): the Challenge id does not identify a request.**
Since the id is a pure function of its parameters, two requests with identical terms
issued within the **same millisecond** (only `expires` tells them apart, to the
millisecond) receive the **same id**. Measured on the phase 1 provider: **19 collisions
out of 50 rapid requests**. Any log or metric indexed on `challenge.id` therefore
underestimates traffic — hence the ledger's `occurrences` counter (see
`docs/features/ledger.md`).

### 3.2 Credential (`Authorization` / `Payment-Authorization`)

Source: <https://mpp.dev/protocol/credentials>.

Value = `Payment <base64url(JSON)>`, JSON with three fields:

| Field | Role |
|---|---|
| `challenge` | the **unchanged** echo of the Challenge (`request`/`opaque` stay base64url) |
| `source` | payer identity, e.g. `did:pkh:eip155:42431:0x…` |
| `payload` | payment proof specific to the payment method |

Tempo `charge` payloads — all three are in the SDK's zod schema
(`dist/tempo/Methods.d.ts`, union discriminated on `type`):

| `payload.type` | Client usage | Server verification |
|---|---|---|
| `transaction` | non-zero charge, *pull* mode | signed Tempo transaction, before broadcast |
| `hash` | non-zero charge, *push* mode | on-chain receipt of the submitted transaction |
| `proof` | zero amount (identity flow) | signature over the Challenge ID, no transfer |

✅ Unlike the Python SDK, **`proof` is available in TypeScript** (module
`dist/tempo/Proof.js`). Useful for free identification with no transfer.

**Replay protection**: a proof must be accepted **at most once**. Challenge binding
prevents modifying the conditions but **does not detect replay**.
`mppx` behavior read in `dist/tempo/server/Charge.d.ts` (`store` option):
- **non-zero** charge → **default memory store** if `store` is omitted;
- **zero-amount `proof`** auth → **no protection** unless an explicit `store` is given;
- the store must be a `Store.AtomicStore`, and **shared** between instances in multi-process.

### 3.3 Receipt (`Payment-Receipt`)

Source: <https://mpp.dev/protocol/receipts>. JSON object in base64url:

```json
{ "method": "tempo", "reference": "0x789abc…", "status": "success",
  "timestamp": "2025-01-15T12:00:00Z" }
```

Fields: `method`, `reference`, `status`, `timestamp` + optional `externalId`,
`subscriptionId`. Header **optional** at protocol level, but it is our audit source:
`reference` = transaction hash for an on-chain settlement → **`ledger/` consumes it**.

SDK API: `Receipt.from` / `Receipt.serialize` / `Receipt.deserialize` /
`Receipt.fromResponse` (`dist/Receipt.d.ts`).

---

## 4. Testnet configuration

**Target network: Tempo Moderato (testnet).**

Authoritative source: `node_modules/mppx/dist/tempo/internal/defaults.js`.

| Key | Mainnet | **Testnet (Moderato)** |
|---|---|---|
| Chain ID | `4217` | **`42431`** |
| Default RPC | `https://rpc.tempo.xyz` | **`https://rpc.moderato.tempo.xyz`** |
| Default currency | USDC `0x20C000000000000000000000b9537d11c60E8b50` | **pathUSD `0x20c0000000000000000000000000000000000000`** |
| Escrow contract | `0x33b901018174DDabE4841042ab76ba85D4e24f25` | `0xe1c4d3dce17bc111181ddf716f75bae49e61a336` |
| Decimals (TIP-20) | 6 | 6 |

These constants are **identical** to those of the Python SDK (`pympp`) — cross-checked
during the first pass of phase 0, so the values are reliable.

Verified live against the RPC on 2026-09-20:

```
$ curl -s -X POST https://rpc.moderato.tempo.xyz \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"0xa5bf"}      # 0xa5bf == 42431 ✔
```

### 4.1 ⚠️ The only correct way to switch to testnet: `testnet: true`

**This is the most dangerous pitfall of the project.** I tested the four plausible ways
of asking for the testnet and compared the `methodDetails.chainId` + `currency` actually
issued in the Challenge. **Measured** results on `mppx@0.10.1`:

| Configuration | `chainId` issued | `currency` issued | Verdict |
|---|---|---|---|
| `tempo.charge({})` | `4217` | USDC (mainnet) | consistent mainnet — **default = real money** |
| **`tempo.charge({ testnet: true })`** | **`42431`** | **pathUSD** | ✅ **the only consistent setting** |
| `tempo.charge({ chainId: 42431 })` | `4217` ⚠️ | pathUSD | ❌ **inconsistent**: mainnet chain, testnet currency |
| `mppx.charge({ chainId: 42431 })` (per route) | `42431` | USDC ⚠️ | ❌ **inconsistent** the other way |
| `tempo.charge({ rpcUrl: '…moderato…' })` | `4217` | USDC | ❌ no effect on the Challenge |

Measurement protocol: one Hono server per case, in-memory `app.request()`, then
`Challenge.deserialize(res.headers.get('WWW-Authenticate'))` and reading
`challenge.request`. Script: `smoke3.ts` (session scratchpad).

**Consequences for the plan:**
1. **`testnet: true` everywhere**, never `chainId` alone. To be checked by a Vitest test
   asserting `methodDetails.chainId === 42431` **and** `currency === pathUSD` on every route.
2. The behavior of `chainId` alone looks like an **upstream bug** (`wevm/mppx`): it
   influences currency resolution but not the Challenge's `chainId`. To be reported
   upstream, but **do not rely on it** either way.
3. Plan an application guard: refuse to start if `chainId !== 42431`.

### 4.2 Funding the testnet wallet — **resolved**

The point left open with Python is settled: the `mppx` package ships a CLI
(`bin: mppx`), already available via `npx mppx`. Real output of `npx mppx account fund --help`:

```
mppx account fund — Fund account with testnet tokens
Options:
  --account, -a <string>  Account name (env: MPPX_ACCOUNT)
  --network <testnet>     Tempo network
  --rpc-url, -r <string>  RPC endpoint (env: MPPX_RPC_URL)
```

`--network` accepts **only** `testnet` — impossible to "fund" mainnet by mistake.

Getting-started sequence (docs: <https://mpp.dev/sdk/typescript/cli>, cross-checked with
`npx mppx account --help`):

```bash
npx mppx account create --account main
npx mppx account default --account main
npx mppx account fund --network testnet
npx mppx account view --account main
npx mppx account export --account main   # to inject the key into .env
```

### 4.3 Environment variables (`.env`, gitignored)

| Variable | Who reads it | Source |
|---|---|---|
| `MPP_SECRET_KEY` | `Mppx.create()` if `secretKey` omitted | JSDoc `dist/server/Mppx.d.ts` |
| `MPP_REALM` | `realm` resolution | same (order: explicit value > `MPP_REALM`, `FLY_APP_NAME`, `VERCEL_URL`… > request hostname > `"MPP Payment"`) |
| `PRIVATE_KEY` | `privateKeyToAccount(process.env.PRIVATE_KEY)` client/payer side | <https://mpp.dev/sdk/typescript/middlewares/hono> |
| `MPPX_ACCOUNT`, `MPPX_RPC_URL` | `mppx` CLI | `npx mppx account fund --help` |

**`secretKey` must be at least 32 bytes** — a constraint hardened in the SDK, verified:

```
Mppx.create({ …, secretKey: 'short' })
→ Error: Secret key must be at least 32 bytes.
  Generate one with `openssl rand -base64 32` and set …
```

We will pass `realm` and `secretKey` **explicitly**: environment auto-detection is not
deterministic between a local machine and CI.

---

## 5. The real `mppx` API (introspection + execution)

Installed and verified in this repo:

```
$ npm install mppx viem hono
$ npm install -D typescript tsx vitest @types/node

mppx 0.10.1   (ESM, "type": "module", bin: mppx)
viem 2.56.8 · hono 4.13.8 · vitest 4.1.11 · tsx 4.23.15 · typescript 7.0.2
Node v20.20.1 · npm 10.8.2
```

Peer dependencies declared by `mppx` (npm): `viem >=2.54.0`, `hono >=4.12.25`,
`express >=5`, `elysia >=1`, `next >=16.2.6`, `@modelcontextprotocol/sdk >=1.25.0`,
`@x402/*  >=2.22.0`. Only those of the adapters we use are required.

### 5.1 Entry points (package `exports`)

`.`, `./client`, `./server`, `./server/core`, `./client/node`, `./tempo`, `./evm`,
`./stripe`, `./hono`, `./express`, `./elysia`, `./nextjs`, `./proxy`, `./cli`, `./html`,
`./discovery`, `./validation`, `./attestation`, `./mcp/client`, `./mcp/server`,
`./mcp-sdk/client`, `./mcp-sdk/server`, `./x402` (+ `./x402/hono|next|express|mcp`).

### 5.2 Core types — `mppx`

```ts
import { Challenge, Credential, Receipt, Expires, BodyDigest, Store, Errors, Method } from 'mppx'
```

Signatures **read from the installed `.d.ts`**:

```ts
Challenge.from(parameters, options?)   // parameters requires EITHER `id`, OR `secretKey` (OneOf)
Challenge.serialize(challenge): string
Challenge.deserialize(value, options?)
Challenge.fromResponse(response) | fromHeaders(headers) | fromResponseList(...)
Challenge.verify(challenge, { secretKey }): boolean
Challenge.credentialHeader(challenge): string
Challenge.meta(challenge): Record<string,string> | undefined

Credential.from(...) | serialize | deserialize | fromRequest
Receipt.from(...)   | serialize | deserialize | fromResponse
Expires.seconds|minutes|hours|days|weeks|months|years(n): string   // ISO-8601
BodyDigest.compute / verify
```

⚠️ **`Challenge.from` throws if neither `id` nor `secretKey` is provided** (`$ZodError` on the
`id` field). `secretKey` goes **in `parameters`**, not in `options` — `options` only carries
`{ methods }`. Mistake made and fixed during phase 0.

### 5.3 Server — `mppx/server` (and `mppx/hono`)

```ts
import { Mppx, tempo, Store, Expires, Response, Transport } from 'mppx/server'

const payment = Mppx.create({
  methods: [tempo.charge({ testnet: true, recipient, currency, decimals: 6 })],
  realm: 'api.local',
  secretKey: process.env.MPP_SECRET_KEY,
  requiresAuth: false,        // true ⇒ Challenge announces header="Payment-Authorization"
  selectOffers,               // filters composed offers before issuance
  transport,                  // Transport.http() by default; Transport.mcpSdk() for MCP
})
```

⚠️ **Different naming from the Python SDK**: on the TS side it is **`tempo.charge()`** (one
function per intent), where `pympp` had `tempo(intents={"charge": ChargeIntent()})`. Do not
transpose.

The returned instance exposes: the intent functions (`charge`, `session`, …), the nested
form `payment.tempo.charge(...)`, `payment.challenge.tempo.charge(...)`,
`compose`, `validateCredential`, `broadcastCredential`
(`verifyCredential` = backwards-compatible alias of `broadcastCredential`, to avoid), and
the hooks.

Server hooks (source: <https://mpp.dev/sdk/typescript/server/Mppx.create>):

```ts
payment.onChallengeCreated(({ challenge, request }) => …)
payment.onPaymentSuccess(({ receipt, request, requestInput }) => …)
payment.onPaymentFailed(({ challenge, error }) => …)
```

`onPaymentSuccess` receives `requestInput`: the server input resolved **before** the
schema transforms, **including the fields deliberately omitted from the Challenge**. This
is exactly what `ledger/` needs.

Hono adapter (`mppx/hono`) — each intent returns a `MiddlewareHandler`:

```ts
const app = new Hono()
const mppx = Mppx.create({ methods: [tempo.charge({ testnet: true })] })
app.get('/premium', mppx.charge({ amount: '1' }), (c) => c.json({ data: 'paid content' }))
```

Identifying the payer after payment: the Credential is always on the request →
`Credential.deserialize(c.req.header('Authorization')!).source` → DID `did:pkh:eip155:…`.

### 5.4 Client — `mppx/client`

```ts
import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const mppx = Mppx.create({
  methods: [tempo({ account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`) })],
  polyfill: false,          // ⚠️ see below
  maxPaymentRetries: 3,     // default
  onChallenge,              // ← budget guard hook point
  paymentPreferences, orderChallenges, acceptPaymentPolicy, attestation, fetch, transport,
})
const res = await mppx.fetch('https://api.example.com/resource')
```

🚨 **`polyfill` is `true` by default** (`dist/client/Mppx.d.ts`: "Whether to polyfill
`globalThis.fetch` with the payment-aware wrapper. @default true"). In other words,
`Mppx.create()` makes **every** `fetch` in the process able to pay, including calls that
have nothing to do with it. **For an agent with a budget guard this is unacceptable** →
always `polyfill: false` + use `mppx.fetch` explicitly. → To be locked in by a test.

The **`onChallenge(challenge, { createCredential })`** hook is called on receiving a 402:
**this is where** the budget guard decides whether to pay.

🚨 **Correction (phase 2) — returning `undefined` does NOT refuse the payment.**
The first draft of this section claimed it, by deduction from the docs
("Called when a 402 challenge is received and no event handler supplies a
credential"). The code says the opposite —
`node_modules/mppx/dist/client/internal/Fetch.js` l. 153:

```js
const credential = onChallengeCredential ?? (await createCredential())
```

`undefined` therefore makes the client fall back to the **default** Credential
creation, and it pays. Measured: with an `onChallenge` returning `undefined`, the
client went all the way to the on-chain transaction — it only failed on
`InsufficientBalance(available: 0, required: 500000)`, in other words a funded wallet
would have paid.

**To refuse, you must throw.** An exception from `onChallenge` propagates unchanged
out of `mppx.fetch`, and no signature is requested. Verified both ways
(`tests/agent/client.test.ts`).

Observation hooks: `onChallengeReceived`, `onCredentialCreated`,
`onPaymentFailed`, `onPaymentResponse` — each returns its unsubscribe function.
⚠️ `onPaymentFailed` receives an **optional** `challenge`
(`client/internal/Fetch.d.ts`): do not assume it is always there.

⚠️ Client side, the constructor is **`tempo({ account })`** (not `tempo.charge()`).
Client/server asymmetry not to be confused.

**Native client guardrails** (`dist/tempo/client/Charge.d.ts`), to be used in addition
to the budget guard — they act before any signature:

| Option | Effect |
|---|---|
| `expectedChainId` | rejects any Challenge whose `methodDetails.chainId` differs |
| `allowedChainIds` | allowed chains; **omitted = all**, empty array = none |
| `expectedRecipients` | address allowlist; also applies to `splits` |
| `mode` | `'push'` (the client broadcasts) / `'pull'` (the server broadcasts) |

### 5.5 Stores (replay protection) — `mppx` `Store`

`Store.memory()`, `Store.redis(client)`, `Store.upstash(redis)`, `Store.cloudflare(kv)`,
`Store.from(store)`, `Store.tryClaim(store, key, expires)` (`dist/Store.d.ts`).

**No SQLite store provided.** Two distinct needs not to be confused:

| Need | Building block |
|---|---|
| Credential replay protection (protocol requirement) | `Store.AtomicStore` passed to `tempo.charge({ store })` — `Store.memory()` in dev, Redis/Upstash if multi-instance |
| Business transaction log (`ledger/`) | **our** code, SQLite via `node:sqlite` — independent of `mppx` |

> Later correction: the ledger uses `better-sqlite3` (D11), and phase 8 adds our own
> SQLite-backed `Store.AtomicStore` for replay protection (D21).

### 5.6 End-to-end proof (executed, no network, no money)

Hono server mounted in memory, request via `app.request()`:

```
1. explicit id?            explicit-cha …
   round-trip id equal     true
   credentialHeader        Authorization
   Expires.minutes(5)      2026-09-20T13:45:28.179Z
2. verify right secret     true
   verify wrong secret     false
3. status                  402
   WWW-Authenticate        Payment id="B0rN7J1_1zPcao3u0mCNu86MdXjSDi9Uq6DjaJTf484",
                           realm="api.local", method="tempo", intent="charge", …
   Cache-Control           no-store
   Content-Type            application/problem+json
   request decoded         {"amount":"500000","currency":"0x20c00000…0000",
                            "methodDetails":{"chainId":42431},
                            "recipient":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}
   HMAC verified by us     true
```

What is proven: Challenge serialization/deserialization, HMAC binding (and its rejection
on a wrong secret), issuance of a real 402 by the Hono middleware, automatic security
headers, conversion `'0.50'` → `'500000'` (6 decimals), and testnet anchoring
`chainId: 42431` + pathUSD. Script: `smoke.ts` (session scratchpad) — **to be converted
into a Vitest test as of phase 1**.

---

## 6. TypeScript SDK capabilities

Source: <https://mpp.dev/sdk/features>, cross-checked with the installed tree.
**Moving to TS lifts all the limits that blocked the Python version.**

| Feature | Python (`pympp`) | **TypeScript (`mppx`)** |
|---|---|---|
| `charge` intent | ✓ | ✓ |
| `session` intent (pay-as-you-go) | ✗ | **✓** `dist/tempo/session/`, `mppx.session()` |
| `subscription` intent | ✗ | **✓** `dist/tempo/server/Subscription.js` |
| `proof` payload (zero amount) | ✗ | **✓** `dist/tempo/Proof.js` |
| Billed SSE streaming / WebSocket | ✗ | **✓** `session/server/Sse.js`, `Ws.js` |
| Proxy of an existing API | ✗ | **✓** `mppx/proxy` |
| x402 compatibility | — | **✓** `mppx/x402` (+ hono/next/express/mcp) |
| MCP transport | ✓ | ✓ `mppx/mcp-sdk/server` |
| Card payments (Stripe) | ✓ | ✓ `mppx/stripe` |
| Split payments, fee payer, attribution memo | partial | ✓ |
| HTML rendering of a payment page | ✗ | **✓** `tempo.charge({ html: true })` |

**Consequence for the plan**: the marketplace is no longer constrained to the
"one payment = one request" model. Sessions (usage-based billing) and subscriptions are
available — which opens phases that were out of reach in Python.
I still recommend **starting with `charge`** and only adding `session` once the nominal
flow is covered by tests.

---

## 7. Doc ↔ installed SDK discrepancies

Far fewer than in Python (where the docs documented a nonexistent `@requires_payment`
decorator and a wrong `Credential` constructor). On `mppx@0.10.1`:

1. ✅ Docs and SDK agree on `Mppx.create`, `tempo.charge`, the hooks, the Hono adapter
   and the CLI — verified by execution.
2. ⚠️ `verifyCredential`: the docs call it a "deprecated alias" of `broadcastCredential`;
   the `.d.ts` is milder ("retained as a backwards-compatible alias"), without an
   `@deprecated` tag. Either way, use `validateCredential` (non-mutating) /
   `broadcastCredential` (mutating) — not `verifyCredential`.
3. ⚠️ `tempo.charge({ chainId })` does not propagate to the Challenge (§4.1) —
   undocumented, measured behavior. To be treated as an upstream bug.

---

## 8. Security — to apply from phase 1

Source: <https://mpp.dev/advanced/security>.

- `MPP_SECRET_KEY` = **root trust material**. Whoever obtains it can forge Challenges
  that look issued by our `realm`. Never hard-coded, never in git, never in an image, one
  key **per environment**. ≥ 32 bytes (enforced by the SDK): `openssl rand -base64 32`.
- **Never log**: `MPP_SECRET_KEY`, `Authorization: Payment`,
  `Payment-Authorization: Payment`, `Payment-Receipt`. Neither in logs, nor in traces, nor
  in error messages. Log instead: request id, challenge id, status, method.
  **Direct impact: `ledger/` stores references, not Credentials.**
- `Cache-Control: no-store` on 402s (✅ `mppx` does it by itself, §5.6);
  `Cache-Control: private` on 200s carrying a `Payment-Receipt` (**our job**).
- **Bind the request body**: `digest` mandatory for `POST`/`PUT`/`PATCH`, otherwise the
  client can change the body after receiving the Challenge → `BodyDigest.compute/verify`.
- `description` is display text: **never** an authorization input.
- Rotation of `MPP_SECRET_KEY` with overlap (issue with the new one, verify the old one
  during a window ≥ the Challenge TTL).
- Agent-specific: `polyfill: false` (§5.4), otherwise the budget guard can be bypassed by
  any `fetch` in the process.

---

## 9. Decisions adopted

| # | Decision | Reason |
|---|---|---|
| D1 | SDK = **`mppx`** (TypeScript), Node ≥ 20, ESM | user choice; `mppx` is the official TS one (§0) |
| D2 | Server = **Hono** via `mppx/hono` | native adapter, closest to FastAPI — **to be confirmed** (§0.1) |
| D3 | Testnet = **`tempo.charge({ testnet: true })`**, never `chainId` alone | the only consistent setting, measured (§4.1) |
| D4 | Guard: test asserting `chainId === 42431` **and** `currency === pathUSD` | the SDK default is mainnet (§4.1) |
| D5 | Agent client: **`polyfill: false`** + explicit `mppx.fetch` | otherwise the budget guard is bypassable (§5.4) |
| D6 | Budget guard implemented in the **`onChallenge`** hook | the only place where we can refuse to pay before signing (§5.4) |
| D7 | Replay protection = `Store.memory()` in dev, Redis if multi-instance; **SQLite reserved for the business `ledger/`** | `mppx` has no SQLite store (§5.5) |
| D8 | `ledger/` fed by `onPaymentSuccess` (`requestInput` field) + `Payment-Receipt` | decoupled from the business path (§5.3) |
| D9 | `realm` and `secretKey` passed **explicitly** | auto-detection not deterministic local/CI (§4.3) |
| D10 | Start with the **`charge`** intent; `session` later | reduce surface before having green tests (§6) |

(These phase 0 numbers are a separate list from the architecture log in
[`DECISIONS.md`](DECISIONS.md), which is the up-to-date reference.)

## 10. Open points before phase 1 *(historical — items 1–5 resolved, item 6 still open)*

1. **`PLAN.md` is missing** — phases 1→8 are defined nowhere. *Blocking.*
2. **`CLAUDE.md` to rewrite**: Python stack → TypeScript (§0.1), and "SQLite (ledger)"
   to clarify (business ledger, not the `mppx` store).
3. **Confirm Hono** rather than Express / Elysia / Next.js.
4. **The directory is not a git repository** — yet the project rule is "one phase = one
   branch". `git init` + `.gitignore` (`.env`, `node_modules/`, `.venv/`) to do before phase 1.
5. **Python leftover to remove**: `.venv/` (≈ `pympp` environment from the first pass).
6. Report upstream (`wevm/mppx`) the `chainId` behavior described in §4.1.

---

## Appendix — sources consulted

**Docs** (fetched as raw Markdown via `curl https://mpp.dev/<path>`; ⚠️ URLs whose last
segment contains a dot — `Mppx.create` — return HTML: go through `llms-full.txt`):

- <https://mpp.dev/protocol/http-402>, `/protocol/challenges`, `/protocol/credentials`,
  `/protocol/receipts`, `/protocol/transports/http`
- <https://mpp.dev/payment-methods/tempo/charge>
- <https://mpp.dev/advanced/security>
- <https://mpp.dev/sdk/typescript/>, `/sdk/typescript/middlewares/hono`, `/sdk/typescript/cli`
- <https://mpp.dev/sdk/features>
- <https://mpp.dev/quickstart/server>, <https://mpp.dev/quickstart/agent>
- <https://mpp.dev/llms-full.txt> (32,721 lines — **the most complete source**, contains
  the server `Mppx.create` (l. 23884) and client (l. 19005) sections, `Method.tempo.charge`
  (l. 21639), `Response.requirePayment` (l. 24886))
- IETF specification: <https://paymentauth.org>
- Official docs MCP: `search_docs` on `https://mpp.dev/api/mcp`

**Code read** (`node_modules/mppx/dist/`):

- `tempo/internal/defaults.{d.ts,js}` — **network constants (testnet source of truth)**
- `tempo/server/Charge.d.ts` — `tempo.charge()` options (`testnet`, `store`, `relay`,
  `feePayerPolicy`, `sponsorBudget`, `waitForConfirmation`, `validateSender`…)
- `tempo/Methods.d.ts` — zod schema of `request` and union of Credential payloads
- `tempo/server/index.d.ts`, `tempo/index.d.ts` — inventory of available intents
- `server/Mppx.d.ts` — `create.Config`, 32-byte constraint on `secretKey`, `realm`
  resolution order
- `client/Mppx.d.ts` — `create.Config`, **`polyfill` @default true**, `onChallenge`
- `Challenge.d.ts`, `Credential.d.ts`, `Receipt.d.ts`, `Expires.d.ts`, `Store.d.ts`
- `package.json` (exports, bin, peerDependencies)
- CLI: `npx mppx account --help`, `npx mppx account fund --help`
- Upstream repo: <https://github.com/wevm/mppx>

**Scripts executed** (session scratchpad, to be ported to Vitest tests):
`smoke.ts` (Challenge round-trip + HMAC + real Hono 402),
`smoke2.ts` / `smoke3.ts` (testnet matrix of §4.1, `secretKey` guard).
