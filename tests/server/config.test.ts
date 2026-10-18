import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../../server/config.ts'
import { env } from '../helpers.ts'

describe('loadConfig', () => {
  it('accepts a valid testnet configuration', () => {
    const config = loadConfig(env())
    expect(config.realm).toBe('api.test')
    expect(config.searchPrice).toBe('0.50')
    expect(config.port).toBe(8787)
  })

  it('refuses any network other than testnet', () => {
    expect(() => loadConfig(env({ MPP_NETWORK: 'mainnet' }))).toThrow(ConfigError)
    expect(() => loadConfig(env({ MPP_NETWORK: 'mainnet' }))).toThrow(/testnet only/)
  })

  it('refuses a MPP_SECRET_KEY shorter than 32 bytes', () => {
    expect(() => loadConfig(env({ MPP_SECRET_KEY: 'too-short' }))).toThrow(/32 bytes/)
  })

  it('refuses a malformed recipient address', () => {
    expect(() => loadConfig(env({ MPP_RECIPIENT: 'not-an-address' }))).toThrow(/valid 0x address/)
  })

  it('refuses a malformed or over-precise price', () => {
    expect(() => loadConfig(env({ MPP_SEARCH_PRICE: '1e-3' }))).toThrow(/MPP_SEARCH_PRICE/)
    expect(() => loadConfig(env({ MPP_SEARCH_PRICE: '0.1234567' }))).toThrow(/MPP_SEARCH_PRICE/)
  })

  it('requires the mandatory variables', () => {
    expect(() => loadConfig(env({ MPP_SECRET_KEY: undefined }))).toThrow(/MPP_SECRET_KEY is required/)
    expect(() => loadConfig(env({ MPP_RECIPIENT: undefined }))).toThrow(/MPP_RECIPIENT is required/)
  })
})
