/**
 * Construction du store anti-rejeu à partir de la configuration.
 *
 * Partagé entre le point d'entrée et les tests e2e, pour que le test exerce
 * exactement le câblage de production — un test qui monterait un store
 * différent ne prouverait rien sur ce qui tourne réellement.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Store } from 'mppx'

import type { Config } from './config.ts'
import { connectRedis } from './redis-client.ts'
import { redisStore, sqliteStore } from './stores.ts'

export type ReplayStore = {
  readonly store: Store.AtomicStore | undefined
  close(): Promise<void>
}

export async function createReplayStore(config: Config): Promise<ReplayStore> {
  if (config.replayStore === 'sqlite') {
    if (config.replayStorePath !== ':memory:')
      mkdirSync(dirname(config.replayStorePath), { recursive: true })
    const store = sqliteStore(config.replayStorePath)
    return { store, close: async () => store.close() }
  }

  if (config.replayStore === 'redis') {
    const client = await connectRedis(config.redisUrl!)
    return { store: redisStore(client), close: () => client.close() }
  }

  // memory : `loadConfig` a déjà exigé un acquittement explicite.
  return { store: undefined, close: async () => {} }
}
