import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { connectRedis, type RedisClient } from '../../server/redis-client.ts'
import { redisStore, sqliteStore } from '../../server/stores.ts'

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:63790'

type AnyStore = Store.AtomicStore<Record<string, unknown>>

async function redisReachable(): Promise<boolean> {
  try {
    const client = await connectRedis(REDIS_URL)
    await client.set('ping', '1')
    await client.close()
    return true
  } catch {
    return false
  }
}

const hasRedis = await redisReachable()
let dir: string
let redisClient: RedisClient | undefined

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mpp-store-'))
  if (hasRedis) redisClient = await connectRedis(REDIS_URL)
})
afterAll(async () => {
  await redisClient?.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Common contract. Every replay store must pass these tests, whatever its
 * backend — this is what makes the implementations interchangeable.
 */
function contract(name: string, make: () => AnyStore, enabled = true) {
  describe.skipIf(!enabled)(`AtomicStore contract — ${name}`, () => {
    let store: AnyStore
    let n = 0
    const key = () => `mppx:charge:${name}:${Date.now()}:${++n}`

    beforeAll(() => {
      store = make()
    })

    it('returns null for an absent key', async () => {
      await expect(store.get(key())).resolves.toBeNull()
    })

    it('writes then reads back a value', async () => {
      const k = key()
      await store.put(k, { a: 1 })
      await expect(store.get(k)).resolves.toEqual({ a: 1 })
    })

    it('deletes a key', async () => {
      const k = key()
      await store.put(k, { a: 1 })
      await store.delete(k)
      await expect(store.get(k)).resolves.toBeNull()
    })

    it('update applies set, noop and delete', async () => {
      const k = key()
      const set = await store.update(k, () => ({ op: 'set', value: { n: 1 }, result: 'ecrit' }))
      expect(set).toBe('ecrit')
      await expect(store.get(k)).resolves.toEqual({ n: 1 })

      await store.update(k, (current) => ({ op: 'noop', result: current }))
      await expect(store.get(k)).resolves.toEqual({ n: 1 })

      await store.update(k, () => ({ op: 'delete', result: null }))
      await expect(store.get(k)).resolves.toBeNull()
    })

    it('update sees the current value', async () => {
      const k = key()
      await store.put(k, { n: 1 })
      const seen = await store.update(k, (current) => ({ op: 'noop', result: current }))
      expect(seen).toEqual({ n: 1 })
    })

    // ── The heart of replay protection ───────────────────────────────
    // `tryClaim` returns `MaybePromise<boolean>`: the mppx memory store
    // answers synchronously. We normalize rather than assume.
    const claim = (k: string, expires: number) =>
      Promise.resolve(Store.tryClaim(store, k, expires))

    it('tryClaim succeeds once and only once', async () => {
      const k = key()
      const expires = Date.now() + 60_000
      expect(await claim(k, expires)).toBe(true)
      expect(await claim(k, expires)).toBe(false)
      expect(await claim(k, expires)).toBe(false)
    })

    it('tryClaim is concurrency-safe: a single winner', async () => {
      const k = key()
      const expires = Date.now() + 60_000
      const results = await Promise.all(
        Array.from({ length: 20 }, () => claim(k, expires)),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('tryClaim becomes possible again once the marker has expired', async () => {
      const k = key()
      // Short, real TTL, then we wait for it to elapse. An `expires` already in
      // the past would prove nothing: each backend clamps it its own way.
      expect(await claim(k, Date.now() + 60)).toBe(true)
      expect(await claim(k, Date.now() + 60_000)).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await claim(k, Date.now() + 60_000)).toBe(true)
    })

    it('isolates keys from one another', async () => {
      const a = key()
      const b = key()
      expect(await claim(a, Date.now() + 60_000)).toBe(true)
      expect(await claim(b, Date.now() + 60_000)).toBe(true)
    })
  })
}

contract('memory (mppx default)', () => Store.memory() as AnyStore)
contract('sqlite', () => sqliteStore(join(dir, 'replay.sqlite')))
contract('redis', () => redisStore(redisClient!), hasRedis)

describe('sqlite — the blind spots of the memory store', () => {
  it('survives a restart: a Credential does not become replayable', async () => {
    const path = join(dir, 'durable.sqlite')
    const key = 'mppx:charge:durable'
    const expires = Date.now() + 60_000

    const first = sqliteStore(path)
    expect(await first.tryClaim!(key, expires)).toBe(true)
    first.close() // the process stops

    const second = sqliteStore(path) // it restarts
    expect(await second.tryClaim!(key, expires)).toBe(false)
    second.close()
  })

  it('is shared between connections: two instances see the same marker', async () => {
    const path = join(dir, 'shared.sqlite')
    const key = 'mppx:charge:shared'
    const expires = Date.now() + 60_000

    const a = sqliteStore(path)
    const b = sqliteStore(path) // simulates a second process

    expect(await a.tryClaim!(key, expires)).toBe(true)
    expect(await b.tryClaim!(key, expires)).toBe(false)

    a.close()
    b.close()
  })

  it('the memory store, by contrast, shares nothing', async () => {
    const key = 'mppx:charge:memory-store'
    const expires = Date.now() + 60_000
    const a = Store.memory() as AnyStore
    const b = Store.memory() as AnyStore

    expect(await Promise.resolve(Store.tryClaim(a, key, expires))).toBe(true)
    // The same Credential goes through a second time on the other instance.
    expect(await Promise.resolve(Store.tryClaim(b, key, expires))).toBe(true)
  })
})
