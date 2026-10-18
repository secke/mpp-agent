import type { Config } from '../server/config.ts'

/** Test secret: 38 bytes, above the 32-byte minimum enforced by mppx. */
export const TEST_SECRET = 'test-secret-key-for-vitest-32-bytes-ok'

export const TEST_CONFIG: Config = {
  realm: 'api.test',
  secretKey: TEST_SECRET,
  recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  port: 8787,
  searchPrice: '0.50',
  ledgerPath: ':memory:',
  replayStore: 'sqlite',
  replayStorePath: ':memory:',
  redisUrl: undefined,
  analyzePrice: '1.00',
}

export function env(overrides: Record<string, string | undefined> = {}) {
  return {
    MPP_SECRET_KEY: TEST_SECRET,
    MPP_RECIPIENT: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    MPP_REALM: 'api.test',
    MPP_SEARCH_PRICE: '0.50',
    PORT: '8787',
    MPP_NETWORK: 'testnet',
    REPLAY_STORE: 'sqlite',
    REPLAY_STORE_PATH: ':memory:',
    ...overrides,
  } as NodeJS.ProcessEnv
}
