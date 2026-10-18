/**
 * Builds the replay store from the configuration.
 *
 * Shared between the entry point and the e2e tests, so that the test exercises
 * exactly the production wiring — a test mounting a different store would
 * prove nothing about what actually runs.
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

  // memory: `loadConfig` has already required an explicit acknowledgement.
  return { store: undefined, close: async () => {} }
}
