import { describe, expect, it } from 'vitest'
import { generatePrivateKey } from 'viem/accounts'

import { toBaseUnits } from '../../agent/amount.ts'
import { loadAgentConfig, WalletError } from '../../agent/wallet.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'

const KEY = generatePrivateKey()

const env = (overrides: Record<string, string | undefined> = {}) =>
  ({
    AGENT_PRIVATE_KEY: KEY,
    AGENT_MAX_PER_CALL: '1.00',
    AGENT_TOTAL_BUDGET: '10.00',
    AGENT_PROVIDER_URL: 'http://localhost:8787',
    MPP_NETWORK: 'testnet',
    ...overrides,
  }) as NodeJS.ProcessEnv

describe('loadAgentConfig', () => {
  it('loads a valid configuration and locks testnet', () => {
    const config = loadAgentConfig(env())
    expect(config.limits.chainId).toBe(TESTNET_CHAIN_ID)
    expect(config.limits.currency).toBe(PATH_USD)
    expect(config.limits.maxPerCall).toBe(toBaseUnits('1.00', 6))
    expect(config.limits.totalBudget).toBe(toBaseUnits('10.00', 6))
    expect(config.account.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('refuses any network other than testnet', () => {
    expect(() => loadAgentConfig(env({ MPP_NETWORK: 'mainnet' }))).toThrow(/testnet-only/)
  })

  it('requires a private key and refuses it if malformed', () => {
    expect(() => loadAgentConfig(env({ AGENT_PRIVATE_KEY: undefined }))).toThrow(
      /AGENT_PRIVATE_KEY is required/,
    )
    expect(() => loadAgentConfig(env({ AGENT_PRIVATE_KEY: '0xabc' }))).toThrow(WalletError)
  })

  it('never puts the key in the error message', () => {
    const secret = '0xdeadbeef'.padEnd(66, '0')
    try {
      loadAgentConfig(env({ AGENT_PRIVATE_KEY: `${secret}zz` }))
      throw new Error('expected: a refusal')
    } catch (error) {
      expect((error as Error).message).not.toContain('deadbeef')
      expect((error as Error).message).toContain('malformed')
    }
  })

  it('refuses a per-call cap above the envelope', () => {
    expect(() =>
      loadAgentConfig(env({ AGENT_MAX_PER_CALL: '20.00', AGENT_TOTAL_BUDGET: '10.00' })),
    ).toThrow(/unreachable/)
  })

  it('reads a recipient allowlist', () => {
    const config = loadAgentConfig(
      env({ AGENT_ALLOWED_RECIPIENTS: ' 0xAAA , 0xBBB ,, ' }),
    )
    expect(config.limits.recipients).toEqual(['0xAAA', '0xBBB'])
  })

  it('imposes no allowlist by default', () => {
    expect(loadAgentConfig(env()).limits.recipients).toBeUndefined()
  })
})
