# Testnet guard

**Phase 1** · Code: `server/config.ts`, `server/payment.ts`
· Tests: `tests/server/payment.test.ts`

## The problem

`mppx` targets the **main network by default**. Worse, the option that seems
most natural to change it does not do what you would think. Phase 0
measurement (`NOTES.md` §4.1), on `mppx@0.10.1`:

| Configuration | `chainId` issued | currency issued | Verdict |
|---|---|---|---|
| `tempo.charge({})` | 4217 | USDC | consistent mainnet — **real money** |
| **`tempo.charge({ testnet: true })`** | **42431** | **pathUSD** | ✅ correct |
| `tempo.charge({ chainId: 42431 })` | **4217** ⚠️ | pathUSD | ❌ inconsistent |
| `mppx.charge({ chainId: 42431 })` | 42431 | **USDC** ⚠️ | ❌ inconsistent |
| `tempo.charge({ rpcUrl: …moderato })` | 4217 | USDC | ❌ no effect |

In other words: **asking for the testnet through `chainId` yields a Challenge
that advertises the main network**. A client that honors it pays for real.

## The countermeasure: three layers

### 1. When loading the configuration

`MPP_NETWORK` must be `testnet`, otherwise `loadConfig` throws. There is no
code path leading to mainnet.

### 2. When building the payment instance

`server/payment.ts` hard-codes `testnet: true`, with the comment explaining
why and pointing to the measurement. Never `chainId`.

```ts
tempo.charge({
  testnet: true,          // ← the only consistent setting (NOTES §4.1)
  recipient: config.recipient,
  currency: PATH_USD,
  decimals: TOKEN_DECIMALS,
})
```

### 3. On the Challenge actually issued

The first two layers are declarative: they do not protect against an SDK
regression or an upstream default change. We therefore validate the
**produced** Challenge:

```ts
assertTestnetChallenge(challenge)   // chainId === 42431 AND currency === pathUSD
```

And we run it **at startup**, before opening the port:

```ts
await selfCheck(payment, config)    // issues a dummy Challenge, validates it
serve({ fetch: app.fetch, port })   // only reached if the self-check passes
```

Fail at boot rather than on the first paid request.

## Why three layers and not one

The cost of a false negative is not a 500 error: it is a real, irreversible
stablecoin transfer. Layers 1 and 2 catch configuration mistakes; layer 3
catches SDK behavior changes. See [`DECISIONS.md` D3 and D4](../DECISIONS.md).

## To report upstream

The behavior of `chainId` (it influences the currency but not the `chainId` of
the Challenge) looks like a bug in `wevm/mppx`. To be reported — but **without
relying on it** either way in the meantime.

## Tests

6 tests: Challenge anchored on 42431 + pathUSD; conversion `0.50` → `500000`;
passing `selfCheck`; rejection of a mainnet Challenge; rejection of an
unexpected currency on the right network; rejection of a secret shorter than
32 bytes.
