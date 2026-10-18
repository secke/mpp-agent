# Paying agent

**Phase 2** · Code: `agent/client.ts`, `agent/wallet.ts`
· Tests: `tests/agent/client.test.ts`, `tests/agent/wallet.test.ts`

## What it does

An HTTP client that takes a 402, pays on its own, and retries — **unless the
[budget guard](budget-guard.md) objects**.

```ts
const { mppx } = createPayingClient({ account, guard })
const res = await mppx.fetch('http://localhost:8787/v1/search?q=mpp')
```

## 🚨 The central pitfall: refusing is done by throwing

This is **the** point not to get wrong, and the docs are misleading.

The docs describe `onChallenge` as "called when a 402 challenge is received
and no event handler supplies a credential" — which suggests that returning
`undefined` amounts to not paying. **That is false.**
`node_modules/mppx/dist/client/internal/Fetch.js`, line 153:

```js
const credential = onChallengeCredential ?? (await createCredential())
```

`undefined` makes the client fall back to the **default** Credential
creation. Measured, with an `onChallenge` returning `undefined`: the client
went all the way to the on-chain transaction and only failed on
`InsufficientBalance(available: 0, required: 500000)`. **A funded wallet
would have paid.**

The only way to refuse is to **throw**. The exception propagates unchanged
out of `mppx.fetch`, and no signature is requested:

```ts
onChallenge: async (challenge, { createCredential }) => {
  guard.authorize(challenge)        // throws BudgetDenied to refuse
  return await createCredential()
}
```

Two tests lock this in: one checks that `createCredential` is **never
called** on a refusal, the other that a single HTTP request goes out (no
paying retry).

## Defense in depth

Two layers, which do not cover the same thing:

| Layer | What it checks | What it ignores |
|---|---|---|
| SDK native guardrails | chain, recipient | how much has already been spent |
| Budget guard | all of that **+** the spend history | — |

The SDK guardrails come from `dist/tempo/client/Charge.d.ts` and act before
any signature:

```ts
tempo({
  account,
  expectedChainId: 42431,      // rejects any Challenge on another chain
  allowedChainIds: [42431],    // ⚠️ omitted = ALL chains allowed
  expectedRecipients: [...],   // also applies to splits
})
```

An omitted `allowedChainIds` allows **all** chains — that is why we pass it
explicitly, even with `expectedChainId` already set.

## `polyfill: false`, always

`Mppx.create` patches `globalThis.fetch` **by default**
(`dist/client/Mppx.d.ts`: "@default true"). In other words, creating the
client would make *every* `fetch` call in the process paying — including
those that do not go through the guard. The guard would be bypassable without
even knowing it.

We therefore pass `polyfill: false` and use `mppx.fetch` explicitly. A test
asserts that `globalThis.fetch` is unchanged after creation.

## Lifecycle of a commitment

```
onChallenge          → guard.authorize()   commits the amount
  ↳ createCredential fails → guard.release()   gives the commitment back
onPaymentResponse    → guard.settle()      the commitment becomes spend
onPaymentFailed      → guard.release()     gives the commitment back
```

⚠️ `onPaymentFailed` receives an **optional** `challenge`
(`client/internal/Fetch.d.ts`) — hence the `if (challenge)` guard. This is
also why `onChallenge` releases by itself when `createCredential` fails: we
cannot count on the hook for every failure.

## The wallet

`agent/wallet.ts` reads `AGENT_PRIVATE_KEY` from the environment, validates
the format (`0x` + 64 hex), and builds a viem account.

**The key never appears in an error message**: the refusal says
"AGENT_PRIVATE_KEY malformed (expected 0x + 64 hex characters)", without
reproducing the value. A test checks it by looking for a fragment of the key
in the message.

The agent's wallet is **distinct** from `MPP_RECIPIENT`: the agent pays, the
provider collects.

## Tests

14 tests: isolated handler (authorizes / refuses without signing / releases
on failure), `polyfill: false`, propagation of the refusal out of
`mppx.fetch`, no retry on refusal, Challenge actually received from the
provider, and 7 wallet configuration tests.

The "completed payment" path is not covered here: it requires a funded wallet
and an on-chain transaction. That is the subject of **phase 5**.
