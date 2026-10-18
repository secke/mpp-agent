# Hardening — body binding, cache, security review

**Phase 8** · Code: `server/app.ts`, `server/analyze.ts`
· Tests: `tests/server/hardening.test.ts`

See also [replay protection](replay-protection.md), the big piece of this phase.

## Request body binding

### The requirement

> "Include a `digest` parameter for `POST`, `PUT`, and `PATCH` requests so
> clients cannot change the request body after receiving a Challenge."
> — <https://mpp.dev/advanced/security>

Without it: a client asks for a Challenge for a small body, pays, then
resubmits the Credential with a body that is far more expensive to process.

### The hole in the SDK

**The `mppx` TypeScript server exposes no `body` or `digest` option** on the
middleware — unlike the Python SDK, which has `mpp.charge(body=…)` and
`@pay(body=…)`. `MethodFn.Options` (`dist/server/Mppx.d.ts`) only offers
`description`, `expires`, `meta` and `scope`.

### The countermeasure: go through `scope`

`scope` is merged into `meta`, serialized in `opaque`, and `opaque` is part of
the Challenge HMAC input. We therefore put the body digest in it:

```ts
app.post('/v1/analyze', async (c, next) => {
  const raw = await c.req.raw.clone().text()   // clone: we do not consume it
  return payment.charge({
    amount: config.analyzePrice,
    scope: `POST /v1/analyze#${BodyDigest.compute(raw)}`,
  })(c, next)
})
```

The middleware is built **per request** — `scope` is a static option, and the
digest is not.

Verified: the Challenge `opaque` decodes to

```json
{"_mppx_scope":"POST /v1/analyze#sha-256=AUNX9X17itJ5cnD9i4zG4d6z98zj4H/DyBtI5GzJKkc="}
```

### The proof

The server recomputes the scope from the **incoming** request. Modified body
⇒ different scope ⇒ different Challenge id ⇒ the Credential no longer
verifies. The test exploits the contrast of error codes:

| Request | Status | Problem type |
|---|---|---|
| Credential + **swapped body** | 402 | `invalid-challenge` |
| Credential + **original body** | 402 | `verification-failed` |

In the second case, the binding passes and the failure is about the payment
proof — this contrast is what proves the binding really discriminates the
body, rather than rejecting everything.

This test costs **no payment**: the rejection happens before the on-chain
verification. The `proof` payload is used because it verifies off-chain — a
`hash` payload would trigger an RPC call.

## `Cache-Control: private`

> "Send `Cache-Control: private` on successful responses that include
> `Payment-Receipt`." — same source

`mppx` sets `no-store` on 402s by itself, but **nothing** on 200s. A global
middleware takes care of it:

```ts
app.use('*', async (c, next) => {
  await next()
  if (c.res.status === 200 && c.res.headers.has('Payment-Receipt'))
    c.res.headers.set('Cache-Control', 'private')
})
```

Three tests: `private` set on a 200 with a Receipt, nothing on free responses,
`no-store` preserved on 402s.

## ⚠️ `MPP_SECRET_KEY` rotation — not implemented

**This is the only box of phase 8 left open, and it is deliberate.**

The spec recommends rotation with overlap: issue with the new key, keep
verifying with the old one while in-flight Challenges expire. But
`Mppx.create` takes **a single** `secretKey?: string`
(`dist/server/Mppx.d.ts`) — no notion of a previous key.

Two possible workarounds, both discarded:

1. **Two `Mppx` instances in cascade** (new key, then old one as a fallback).
   Feasible, but impossible to validate without multiplying real payments —
   and shipping untested security machinery would be worse than nothing.
2. **A `scope` carrying a key identifier.** Solves nothing: it is the HMAC
   verification itself that fails, not the correlation.

**Procedure adopted in the meantime** — coordinated deployment:

1. stop issuing new Challenges (drain paid traffic);
2. wait for in-flight Challenges to expire — **5 minutes** by default
   (mppx `expires`), hence a bounded and known window;
3. swap `MPP_SECRET_KEY`, restart.

The real cost is a short window where clients get a 402 with a fresh
Challenge — degradation, not outage: a compliant client pays again.

To be reopened if `mppx` ever accepts a list of keys.

## Security review — `docs/NOTES.md` §8

| Requirement | Status | Where |
|---|---|---|
| `MPP_SECRET_KEY` ≥ 32 bytes, never hard-coded nor committed | ✅ | `config.ts`, `.gitignore`, test |
| Never log secret / Credential / Receipt | ✅ | ledger structurally unable to store them, binary test |
| `Cache-Control: no-store` on 402s | ✅ | emitted by mppx, test |
| `Cache-Control: private` on 200s with a Receipt | ✅ | global middleware, test |
| `digest` binding the body on POST/PUT/PATCH | ✅ | via `scope`, test |
| `description` never used as an authorization input | ✅ | review: only the budget guard decides, on amount/currency/chain/recipient |
| Shared and durable replay protection | ✅ | [replay protection](replay-protection.md) |
| Key rotation with overlap | ⚠️ | not supported by the SDK — coordinated procedure above |
| `polyfill: false` client side | ✅ | `agent/client.ts`, test |
| Nothing sensitive in the model context | ✅ | `agent/tools.ts`, test |

Nine requirements out of ten are met and tested. The tenth is blocked by the
SDK, documented, and paired with a bounded workaround procedure.

## Tests

13 tests: body binding (5), `Cache-Control` (3), store configuration guards
(5). Plus the 30 tests of the store contract.
