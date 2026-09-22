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
 * Contrat commun. Tout store anti-rejeu doit passer ces tests, quel que soit
 * son support — c'est ce qui rend les implémentations interchangeables.
 */
function contract(name: string, make: () => AnyStore, enabled = true) {
  describe.skipIf(!enabled)(`contrat AtomicStore — ${name}`, () => {
    let store: AnyStore
    let n = 0
    const key = () => `mppx:charge:${name}:${Date.now()}:${++n}`

    beforeAll(() => {
      store = make()
    })

    it('rend null pour une clé absente', async () => {
      await expect(store.get(key())).resolves.toBeNull()
    })

    it('écrit puis relit une valeur', async () => {
      const k = key()
      await store.put(k, { a: 1 })
      await expect(store.get(k)).resolves.toEqual({ a: 1 })
    })

    it('supprime une clé', async () => {
      const k = key()
      await store.put(k, { a: 1 })
      await store.delete(k)
      await expect(store.get(k)).resolves.toBeNull()
    })

    it('update applique set, noop et delete', async () => {
      const k = key()
      const set = await store.update(k, () => ({ op: 'set', value: { n: 1 }, result: 'ecrit' }))
      expect(set).toBe('ecrit')
      await expect(store.get(k)).resolves.toEqual({ n: 1 })

      await store.update(k, (current) => ({ op: 'noop', result: current }))
      await expect(store.get(k)).resolves.toEqual({ n: 1 })

      await store.update(k, () => ({ op: 'delete', result: null }))
      await expect(store.get(k)).resolves.toBeNull()
    })

    it('update voit la valeur courante', async () => {
      const k = key()
      await store.put(k, { n: 1 })
      const seen = await store.update(k, (current) => ({ op: 'noop', result: current }))
      expect(seen).toEqual({ n: 1 })
    })

    // ── Le cœur de l'anti-rejeu ──────────────────────────────────────
    // `tryClaim` renvoie `MaybePromise<boolean>` : le store mémoire de mppx
    // répond de façon synchrone. On normalise plutôt que de supposer.
    const claim = (k: string, expires: number) =>
      Promise.resolve(Store.tryClaim(store, k, expires))

    it('tryClaim réussit une fois et une seule', async () => {
      const k = key()
      const expires = Date.now() + 60_000
      expect(await claim(k, expires)).toBe(true)
      expect(await claim(k, expires)).toBe(false)
      expect(await claim(k, expires)).toBe(false)
    })

    it('tryClaim est sûr en concurrence : un seul gagnant', async () => {
      const k = key()
      const expires = Date.now() + 60_000
      const results = await Promise.all(
        Array.from({ length: 20 }, () => claim(k, expires)),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('tryClaim redevient possible une fois le marqueur expiré', async () => {
      const k = key()
      // TTL court et réel, puis on attend qu'il s'écoule. Un `expires` déjà
      // dans le passé ne prouverait rien : chaque support le clampe à sa façon.
      expect(await claim(k, Date.now() + 60)).toBe(true)
      expect(await claim(k, Date.now() + 60_000)).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await claim(k, Date.now() + 60_000)).toBe(true)
    })

    it('isole les clés les unes des autres', async () => {
      const a = key()
      const b = key()
      expect(await claim(a, Date.now() + 60_000)).toBe(true)
      expect(await claim(b, Date.now() + 60_000)).toBe(true)
    })
  })
}

contract('memory (défaut mppx)', () => Store.memory() as AnyStore)
contract('sqlite', () => sqliteStore(join(dir, 'replay.sqlite')))
contract('redis', () => redisStore(redisClient!), hasRedis)

describe('sqlite — les angles morts du store mémoire', () => {
  it('survit au redémarrage : un Credential ne redevient pas rejouable', async () => {
    const path = join(dir, 'durable.sqlite')
    const key = 'mppx:charge:durable'
    const expires = Date.now() + 60_000

    const first = sqliteStore(path)
    expect(await first.tryClaim!(key, expires)).toBe(true)
    first.close() // le processus s'arrête

    const second = sqliteStore(path) // il redémarre
    expect(await second.tryClaim!(key, expires)).toBe(false)
    second.close()
  })

  it('est partagé entre connexions : deux instances voient le même marqueur', async () => {
    const path = join(dir, 'partage.sqlite')
    const key = 'mppx:charge:partage'
    const expires = Date.now() + 60_000

    const a = sqliteStore(path)
    const b = sqliteStore(path) // simule un second processus

    expect(await a.tryClaim!(key, expires)).toBe(true)
    expect(await b.tryClaim!(key, expires)).toBe(false)

    a.close()
    b.close()
  })

  it('le store mémoire, lui, ne partage rien', async () => {
    const key = 'mppx:charge:memoire'
    const expires = Date.now() + 60_000
    const a = Store.memory() as AnyStore
    const b = Store.memory() as AnyStore

    expect(await Promise.resolve(Store.tryClaim(a, key, expires))).toBe(true)
    // Le même Credential passe une seconde fois sur l'autre instance.
    expect(await Promise.resolve(Store.tryClaim(b, key, expires))).toBe(true)
  })
})
