/**
 * Shared replay-protection stores.
 *
 * The `tempo.charge` default is an **in-memory** store
 * (node_modules/mppx/dist/tempo/server/Charge.d.ts: "Non-zero charge flows
 * default to an in-memory store if omitted"). It has two blind spots:
 *
 *   1. **multi-process** — two instances do not share memory, so the same
 *      Credential passes once per instance;
 *   2. **restart** — markers are lost, so a Credential becomes replayable
 *      again until its Challenge expires.
 *
 * The second is the more insidious: it affects even a single-instance deployment.
 *
 * Contract implemented: `Store.AtomicStore` — `get`/`put`/`delete`/`update`,
 * plus the fast path `tryClaim` (node_modules/mppx/dist/Store.d.ts).
 */
import Database from 'better-sqlite3'
import type { Store } from 'mppx'

type AnyStore = Store.AtomicStore<Record<string, unknown>>

/** Replay marker as mppx expects it as a fallback to `tryClaim`. */
const REPLAY_TYPE = 'mppx:replay'

// ─────────────────────────────────────────────────────────────────────
// SQLite — shared between processes on one machine, and durable.
// ─────────────────────────────────────────────────────────────────────

const SCHEMA = `
create table if not exists replay (
  key     text primary key,
  value   text not null,
  expires integer
);
create index if not exists replay_expires_idx on replay (expires);
`

export type SqliteStore = AnyStore & { close(): void }

export function sqliteStore(path: string): SqliteStore {
  const db = new Database(path)
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  const now = () => Date.now()
  const prune = db.prepare(`delete from replay where expires is not null and expires <= ?`)
  const select = db.prepare(`select value, expires from replay where key = ?`)
  const upsert = db.prepare(
    `insert into replay (key, value, expires) values (@key, @value, @expires)
       on conflict(key) do update set value = @value, expires = @expires`,
  )
  const remove = db.prepare(`delete from replay where key = ?`)
  // `insert or ignore`: a single atomic SQL statement, so there is no
  // TOCTOU window between the existence check and the write.
  const claim = db.prepare(
    `insert or ignore into replay (key, value, expires) values (?, ?, ?)`,
  )

  const read = (key: string): unknown => {
    const row = select.get(key) as { value: string; expires: number | null } | undefined
    if (!row) return null
    if (row.expires !== null && row.expires <= now()) {
      remove.run(key)
      return null
    }
    return JSON.parse(row.value)
  }

  const expiryOf = (value: unknown): number | null => {
    const marker = value as { type?: unknown; expires?: unknown } | null
    return marker?.type === REPLAY_TYPE && typeof marker.expires === 'number'
      ? marker.expires
      : null
  }

  return {
    async get(key) {
      return read(key) as never
    },
    async put(key, value) {
      upsert.run({ key, value: JSON.stringify(value), expires: expiryOf(value) })
    },
    async delete(key) {
      remove.run(key)
    },
    async update(key, fn) {
      // better-sqlite3 is synchronous: the transaction guarantees the
      // read-modify-write is atomic with respect to other connections.
      const run = db.transaction(() => {
        const change = fn(read(key) as never)
        if (change.op === 'set')
          upsert.run({
            key,
            value: JSON.stringify(change.value),
            expires: expiryOf(change.value),
          })
        else if (change.op === 'delete') remove.run(key)
        return change.result
      })
      return run()
    },
    async tryClaim(key, expires) {
      prune.run(now())
      const marker = JSON.stringify({ expires, type: REPLAY_TYPE })
      return claim.run(key, marker, expires).changes === 1
    },
    close() {
      db.close()
    },
  } satisfies AnyStore & { close(): void }
}

// ─────────────────────────────────────────────────────────────────────
// Redis — shared between machines.
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal Redis client expected by `Store.redis`
 * (node_modules/mppx/dist/Store.d.ts, `redis.AtomicParameters`).
 */
export type RedisLike = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
}

/**
 * Adapts a Redis client to the `AtomicStore` contract.
 *
 * ⚠️ `update` is emulated as read-then-write: it is **not** atomic across
 * instances. For replay protection only `tryClaim` matters, and it relies on
 * `SET NX PX` — atomic on the Redis server. That is why `tryClaim` is
 * provided explicitly rather than left to the mppx fallback.
 */
export function redisStore(
  client: RedisLike & {
    setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>
  },
  keyPrefix = 'mppx:',
): AnyStore {
  const k = (key: string) => `${keyPrefix}${key}`

  return {
    async get(key) {
      const raw = await client.get(k(key))
      return (raw === null ? null : JSON.parse(raw)) as never
    },
    async put(key, value) {
      await client.set(k(key), JSON.stringify(value))
    },
    async delete(key) {
      await client.del(k(key))
    },
    async update(key, fn) {
      const raw = await client.get(k(key))
      const change = fn((raw === null ? null : JSON.parse(raw)) as never)
      if (change.op === 'set') await client.set(k(key), JSON.stringify(change.value))
      else if (change.op === 'delete') await client.del(k(key))
      return change.result
    },
    async tryClaim(key, expires) {
      const ttl = Math.max(1, expires - Date.now())
      return client.setNxPx(k(key), JSON.stringify({ expires, type: REPLAY_TYPE }), ttl)
    },
  } satisfies AnyStore
}
