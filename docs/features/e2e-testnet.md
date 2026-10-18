# Testnet E2E — the real payment

**Phase 5** · Code: `tests/e2e/payment.e2e.test.ts`, `tests/e2e/loadEnv.ts`

## What it proves

A complete, end-to-end payment with real tokens on **Tempo Moderato** — the
one thing phases 1 to 4 could not demonstrate.

```bash
npm run test:e2e
```

The test is **excluded from the default run** (`npm test`) and skips itself if
`AGENT_PRIVATE_KEY` is not configured: CI must neither spend funds nor fail
for lack of a wallet.

## The chain verified

| Step | Assertion |
|---|---|
| Response | `200`, non-empty content |
| Payer | `payer === did:pkh:eip155:42431:<agent address>` |
| Receipt | `Payment-Receipt` present, `status: success`, `reference` = 0x+64 hash |
| Budget | `guard.committed` exactly equals the price |
| Ledger | `success` row, `reference` identical to the Receipt's |
| On-chain | `eth_getTransactionReceipt` → `status: 0x1`, `from` = agent, `to` = pathUSD |
| Funds | the recipient's pathUSD balance increased **exactly** by the price |
| Replay protection | the same Credential served again → **402** |

The funds check is the most important: it does not just trust the Receipt, it
re-reads the on-chain balance before and after and verifies the delta.

## Real measurement

```
tool    : search_marketplace({"query": "MPP protocol definition"}) → ✓ paid
stopped : completed after 2 turn(s)      spent : 0.5 / remaining 9.5
```

Ledger:

```
status    amount    reference                                  payer
success   500000    0x554b601913629aa7fef5c78afb48f8a2972e…    did:pkh:eip155:42431:0x6F57…5338
```

Transaction confirmed:

```
status    : 0x1 (success)          block : 36470584
from      : 0x6f57…5338 (agent)    to    : 0x20c0…0000 (pathUSD)
gas used  : 46695
transfer  : 0.500000 pathUSD  →  0xc249…7d29 (provider)
```

Balances: the provider gains **+0.500000**, the agent loses **0.500900** — the
price plus 0.0009 pathUSD in fees. On Tempo, gas is paid **in the token**, not
in a native currency: that is why the agent only needs pathUSD.

## Replay protection

This is the security property that distinguishes a real payment from a demo.
The test captures the Credential actually sent (by intercepting the
`Authorization` header in the injected `fetch`), then replays it as-is on the
same route. The server answers **402** with a fresh Challenge.

Protection provided by the `store` of `tempo.charge`: by default an in-memory
store for non-zero charges
(`node_modules/mppx/dist/tempo/server/Charge.d.ts`). ⚠️ **With several
instances, this default is not enough** — a shared `Store.AtomicStore` is
needed. This is covered in phase 8 (see
[replay-protection.md](replay-protection.md)).

## Preparing a wallet

```bash
npx mppx account create --account agent
npx mppx account fund --network testnet --account agent
npx mppx account export --account agent     # → AGENT_PRIVATE_KEY in .env

npx mppx account create --account provider  # → MPP_RECIPIENT
openssl rand -base64 32                     # → MPP_SECRET_KEY
```

Payer and recipient are **two distinct accounts**: otherwise the balance delta
check would prove nothing.

## Details that matter

- **`loadDotEnv` is confined to the e2e tests.** Vitest does not apply Node's
  `--env-file`. Unit tests, for their part, depend on no secret and no local
  file — and must not start doing so.
- **One payment per run.** Every run really spends; the test stays minimal on
  purpose.
- **No port opened**: the app is mounted in memory via `app.fetch`, only the
  Tempo RPC is called for real.

## Tests

1 e2e test, 8 families of assertions. Run twice in a row (two distinct real
payments), green both times.
