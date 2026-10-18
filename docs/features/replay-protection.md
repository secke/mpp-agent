# Replay protection — shared and durable stores

**Phase 8** · Code: `server/stores.ts`, `server/redis-client.ts`, `server/bootstrap.ts`
· Tests: `tests/server/stores.test.ts`

## The problem

`tempo.charge` falls back to an **in-memory** store when none is passed:

> "Non-zero charge flows default to an in-memory store if omitted."
> — `node_modules/mppx/dist/tempo/server/Charge.d.ts`

This default has two blind spots:

| Blind spot | Consequence |
|---|---|
| **Multi-process** | two instances do not share memory: the same Credential goes through once per instance |
| **Restart** | markers are lost: a Credential becomes replayable again until its Challenge has expired |

The second is the more insidious — it affects **even a single-instance
deployment**, and a plain `systemctl restart` is enough to reopen the window.

## The countermeasure

Two implementations of the `Store.AtomicStore` contract, chosen by `REPLAY_STORE`:

| Backend | Shared | Durable | For |
|---|---|---|---|
| `memory` (mppx default) | ✗ | ✗ | never in production |
| **`sqlite`** (our default) | between processes on one machine | ✓ | single host |
| `redis` | between machines | ✓ | multi-host |

**The memory store can no longer be chosen by accident**: `loadConfig`
refuses to start without `REPLAY_STORE_MEMORY_ACK=i-know`.

## What carries the guarantee

`tryClaim(key, expires)` — "true if this call set the key, false if it already
existed and has not expired". Everything rests on its atomicity.

- **SQLite**: `insert or ignore` — a single SQL statement, hence no TOCTOU
  window between the existence check and the write.
- **Redis**: `SET key value NX PX ttl` — atomic on the server side.

`update` (read-modify-write) is atomic in SQLite through a transaction. ⚠️ On
the Redis side it is **emulated** by get then set, hence not atomic across
instances — this is documented in the code. For replay protection only
`tryClaim` matters, and it is atomic; that is why it is provided explicitly
rather than left to the mppx fallback.

## The Redis client

~100 lines of RESP over TCP (`server/redis-client.ts`), **dependency-free**.
Four commands are enough: `GET`, `SET`, `DEL`, `SET … NX PX`. Commands are
serialized — one reply at a time, in order.

This avoids shipping a full client for four verbs, and keeps the Docker image
lighter.

## Tests

A **common contract** run against the three backends: what makes the
implementations truly interchangeable rather than "probably equivalent". The
contract covers get/put/delete, the three branches of `update`, and above all:

- `tryClaim` succeeds **once and only once**;
- 20 concurrent `tryClaim`s on the same key → **a single winner**;
- the key becomes claimable again once the marker has expired;
- keys are isolated.

Redis is a **real server** (Docker container), not a fake.

Three tests explicitly target the blind spots of the memory store:
persistence after a "restart" (closing then reopening the file), sharing
between two connections, and — by contrast — the demonstration that two memory
stores **share nothing**.

## Verified in real conditions

The phase 5 e2e test now uses `createReplayStore(config)`, the **same wiring
as in production** — a test mounting a different store would prove nothing
about what runs. After a real payment:

```
1 marker(s) recorded
  mppx:charge:0xc1d44afc1fa6ece0a013076e5046a748e09d1596edade5 | expires 2026-09-22T22:39:46Z
```

The marker is **on disk**, so it survives a restart.

## Two pitfalls encountered

- **`tryClaim` can be synchronous.** Its type is `MaybePromise<boolean>` and
  the mppx memory store answers without a promise. The contract normalizes with
  `Promise.resolve` instead of assuming.
- **Testing expiration with an `expires` already in the past proves nothing**:
  each backend clamps it its own way (SQLite purges, Redis forces a minimal
  1 ms TTL). The contract sets a short but real TTL, then waits.
