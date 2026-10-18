# OpenAPI discovery

**Phase 1** · Code: `server/app.ts` · Tests: `tests/server/app.test.ts`

## What it does

Serves `GET /openapi.json`: an OpenAPI 3.1 document that advertises **what
the paid routes cost, before a client calls them**.

## Why

It is the standard MPP discovery mechanism:

> "You serve a standard OpenAPI 3.1 document at `/openapi.json` with
> `x-payment-info` extensions that advertise one or more payment offers for
> each paid operation. Registries aggregate these documents so agents can find
> paid APIs automatically."
> — <https://mpp.dev/advanced/discovery>

For a marketplace, this is the front door: an agent discovers the service,
reads the price, decides. Without it, you have to take a 402 to learn the
rate.

## Usage

```ts
discovery(app, payment, {
  auto: true,
  info: { title: 'Agentic Research Marketplace', version: '0.1.0' },
})
```

`auto: true` detects the paid routes already declared on the app — no list to
maintain twice. The helper comes from `mppx/hono`.

```bash
curl -s localhost:8787/openapi.json | jq '.paths["/v1/search"].get["x-payment-info"]'
```

## Details that matter

- **The path is `/openapi.json`, not `/.well-known/…`.** I was about to invent
  a `/.well-known/mpp`; the docs mandate `/openapi.json`. Verified before
  writing.
- **Call order matters.** `discovery(app, …)` must be called **after** the paid
  routes, otherwise `auto: true` has nothing to detect.
- The discovery route is **free**: advertising your prices is not billed.

## Tests

2 tests: the document is indeed OpenAPI 3.1 and contains `/v1/search`; the
operation carries an `x-payment-info` mentioning the `tempo` method.
