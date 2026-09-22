/**
 * Stores anti-rejeu partagés.
 *
 * Le défaut de `tempo.charge` est un store **mémoire**
 * (node_modules/mppx/dist/tempo/server/Charge.d.ts : « Non-zero charge flows
 * default to an in-memory store if omitted »). Il a deux angles morts :
 *
 *   1. **multi-processus** — deux instances ne partagent pas leur mémoire,
 *      donc le même Credential passe une fois par instance ;
 *   2. **redémarrage** — les marqueurs sont perdus, donc un Credential
 *      redevient rejouable tant que son Challenge n'a pas expiré.
 *
 * Le second est le plus insidieux : il touche même un déploiement mono-instance.
 *
 * Contrat implémenté : `Store.AtomicStore` — `get`/`put`/`delete`/`update`,
 * plus le chemin rapide `tryClaim` (node_modules/mppx/dist/Store.d.ts).
 */
import Database from 'better-sqlite3'
import type { Store } from 'mppx'

type AnyStore = Store.AtomicStore<Record<string, unknown>>

/** Marqueur de rejeu tel que mppx l'attend en repli de `tryClaim`. */
const REPLAY_TYPE = 'mppx:replay'

// ─────────────────────────────────────────────────────────────────────
// SQLite — partagé entre processus d'une même machine, et durable.
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
  // `insert or ignore` : une seule instruction SQL atomique, donc pas de
  // fenêtre TOCTOU entre le test d'existence et l'écriture.
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
      // better-sqlite3 est synchrone : la transaction garantit l'atomicité
      // de lecture-modification-écriture face aux autres connexions.
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
// Redis — partagé entre machines.
// ─────────────────────────────────────────────────────────────────────

/**
 * Client Redis minimal attendu par `Store.redis`
 * (node_modules/mppx/dist/Store.d.ts, `redis.AtomicParameters`).
 */
export type RedisLike = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
}

/**
 * Adapte un client Redis au contrat `AtomicStore`.
 *
 * ⚠️ `update` est émulé par lecture puis écriture : ce n'est **pas** atomique
 * entre instances. Pour l'anti-rejeu, seul `tryClaim` compte, et il s'appuie
 * sur `SET NX PX` — atomique côté serveur Redis. C'est pourquoi `tryClaim`
 * est fourni explicitement plutôt que laissé au repli de mppx.
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
