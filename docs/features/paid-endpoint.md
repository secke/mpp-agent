# Paid endpoint and 402 flow

**Phase 1** · Code: `server/app.ts`, `server/payment.ts`, `server/search.ts`
· Tests: `tests/server/app.test.ts`

## What it does

Exposes `GET /v1/search`, guarded by an MPP payment. A client without a
Credential receives a **402** with a Challenge; with a valid Credential, it
receives the results and a Receipt.

Routes served:

| Route | Payment | Role |
|---|---|---|
| `GET /healthz` | no | liveness probe |
| `GET /v1/search?q=…` | **yes** | the service sold |
| `GET /openapi.json` | no | [discovery](openapi-discovery.md) |

## The flow

```
1. Client  → GET /v1/search?q=mpp
2. Server  → 402 Payment Required
             WWW-Authenticate: Payment id="…", realm="api.test",
                               method="tempo", intent="charge", request="eyJ…"
             Cache-Control: no-store
             Content-Type: application/problem+json
3. Client  → GET /v1/search?q=mpp
             Authorization: Payment eyJjaGFsbGVuZ2Ui…
4. Server  → 200 OK  +  Payment-Receipt: …
             { "query": "mpp", "payer": "did:pkh:eip155:42431:0x…", "results": [...] }
```

The decoded `request` of the Challenge:

```json
{ "amount": "500000",
  "currency": "0x20c0000000000000000000000000000000000000",
  "recipient": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "methodDetails": { "chainId": 42431 } }
```

`"500000"` = 0.50 pathUSD: `mppx` converts the readable amount to base units
with 6 decimals.

## Usage

```ts
const payment = createPayment(config)

app.get(
  '/v1/search',
  payment.charge({ amount: config.searchPrice, description: '…' }),
  (c) => c.json({ results: search(c.req.query('q') ?? '') }),
)
```

`payment.charge(...)` returns a standard Hono `MiddlewareHandler`: it slots
into the route like any other middleware.

## Identifying the payer

After verification, the Credential is still on the request. Its `source`
field is a DID:

```ts
const payer = Credential.deserialize(c.req.header('Authorization')!).source
// "did:pkh:eip155:42431:0x…"
```

The field is `Authorization` by default; it becomes `Payment-Authorization`
if the server enables `requiresAuth: true` (coexistence with application
auth). The Challenge announces it — do not hard-code the name, read
`Challenge.credentialHeader(challenge)`.

## Details that matter

- **An invalid Credential gives 402, not 401.** MPP is explicit about this
  (`NOTES.md` §2): a verification failure returns a **fresh Challenge**.
  This is counter-intuitive compared with other HTTP auth schemes; a test
  locks it in.
- **Security headers are emitted by `mppx` by itself**:
  `Cache-Control: no-store` and `application/problem+json` on the 402.
  Verified, not assumed. On the other hand `Cache-Control: private` on 200s
  carrying a Receipt remains **our job** — delivered in phase 8.
- **The 402 discloses no result.** A test asserts it explicitly:
  paying has to be worth something.
- **`mppx` binds the route in `opaque`.** Verified on the running server:
  `opaque` decodes to `{"_mppx_scope":"GET /v1/search"}`. A Challenge issued
  for one route therefore cannot be resubmitted on another — protection
  obtained for free, but not to be broken by manipulating `opaque` yourself.
- **`server/search.ts` is fake and deterministic.** The point of the phase is
  payment, not relevance. The shape of the response, however, is stable.
  See [`DECISIONS.md` D6](../DECISIONS.md).

## Tests

11 tests: 200 without payment on `/healthz`; 402 on `/v1/search`; presence
and shape of `WWW-Authenticate`; security headers; HMAC binding of the
Challenge (valid with the right secret, invalid with another); advertised
amount, currency, recipient and chainId; Credential field; non-disclosure of
results; 402 on a malformed Credential.
