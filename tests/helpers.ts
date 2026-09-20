import type { Config } from '../server/config.ts'

/** Secret de test : 38 octets, au-dessus du minimum de 32 imposé par mppx. */
export const TEST_SECRET = 'test-secret-key-for-vitest-32-bytes-ok'

export const TEST_CONFIG: Config = {
  realm: 'api.test',
  secretKey: TEST_SECRET,
  recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  port: 8787,
  searchPrice: '0.50',
  ledgerPath: ':memory:',
}

export function env(overrides: Record<string, string | undefined> = {}) {
  return {
    MPP_SECRET_KEY: TEST_SECRET,
    MPP_RECIPIENT: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    MPP_REALM: 'api.test',
    MPP_SEARCH_PRICE: '0.50',
    PORT: '8787',
    MPP_NETWORK: 'testnet',
    ...overrides,
  } as NodeJS.ProcessEnv
}
