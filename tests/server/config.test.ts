import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../../server/config.ts'
import { env } from '../helpers.ts'

describe('loadConfig', () => {
  it('accepte une configuration testnet valide', () => {
    const config = loadConfig(env())
    expect(config.realm).toBe('api.test')
    expect(config.searchPrice).toBe('0.50')
    expect(config.port).toBe(8787)
  })

  it('refuse tout réseau autre que testnet', () => {
    expect(() => loadConfig(env({ MPP_NETWORK: 'mainnet' }))).toThrow(ConfigError)
    expect(() => loadConfig(env({ MPP_NETWORK: 'mainnet' }))).toThrow(/testnet uniquement/)
  })

  it('refuse un MPP_SECRET_KEY de moins de 32 octets', () => {
    expect(() => loadConfig(env({ MPP_SECRET_KEY: 'trop-court' }))).toThrow(/32 octets/)
  })

  it('refuse une adresse destinataire malformée', () => {
    expect(() => loadConfig(env({ MPP_RECIPIENT: 'pas-une-adresse' }))).toThrow(/adresse 0x/)
  })

  it('refuse un prix malformé ou trop précis', () => {
    expect(() => loadConfig(env({ MPP_SEARCH_PRICE: '1e-3' }))).toThrow(/MPP_SEARCH_PRICE/)
    expect(() => loadConfig(env({ MPP_SEARCH_PRICE: '0.1234567' }))).toThrow(/MPP_SEARCH_PRICE/)
  })

  it('exige les variables obligatoires', () => {
    expect(() => loadConfig(env({ MPP_SECRET_KEY: undefined }))).toThrow(/MPP_SECRET_KEY est requis/)
    expect(() => loadConfig(env({ MPP_RECIPIENT: undefined }))).toThrow(/MPP_RECIPIENT est requis/)
  })
})
