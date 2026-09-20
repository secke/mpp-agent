import { Challenge } from 'mppx'
import { describe, expect, it } from 'vitest'

import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'
import { assertTestnetChallenge, createPayment, selfCheck } from '../../server/payment.ts'
import { TEST_CONFIG } from '../helpers.ts'

describe('garde-fou testnet', () => {
  it("émet un Challenge ancré sur Moderato, pas sur le réseau principal", async () => {
    const payment = createPayment(TEST_CONFIG)
    const challenge = await payment.challenge.tempo.charge({ amount: '0.50' })
    const request = challenge.request as { currency: string; methodDetails: { chainId: number } }

    expect(request.methodDetails.chainId).toBe(TESTNET_CHAIN_ID)
    expect(request.currency.toLowerCase()).toBe(PATH_USD)
  })

  it('convertit le montant lisible en unités de base (6 décimales)', async () => {
    const payment = createPayment(TEST_CONFIG)
    const challenge = await payment.challenge.tempo.charge({ amount: '0.50' })
    expect((challenge.request as { amount: string }).amount).toBe('500000')
  })

  it('selfCheck passe sur une configuration correcte', async () => {
    const payment = createPayment(TEST_CONFIG)
    await expect(selfCheck(payment, TEST_CONFIG)).resolves.toBeUndefined()
  })

  it('assertTestnetChallenge rejette un Challenge mainnet', () => {
    const mainnet = Challenge.from({
      id: 'faux-challenge',
      realm: 'api.test',
      method: 'tempo',
      intent: 'charge',
      request: {
        amount: '500000',
        currency: '0x20C000000000000000000000b9537d11c60E8b50', // USDC mainnet
        recipient: TEST_CONFIG.recipient,
        methodDetails: { chainId: 4217 },
      },
    })
    expect(() => assertTestnetChallenge(mainnet)).toThrow(/chainId=4217/)
  })

  it('assertTestnetChallenge rejette une devise inattendue sur le bon réseau', () => {
    const wrongCurrency = Challenge.from({
      id: 'faux-challenge-2',
      realm: 'api.test',
      method: 'tempo',
      intent: 'charge',
      request: {
        amount: '500000',
        currency: '0x20C000000000000000000000b9537d11c60E8b50',
        recipient: TEST_CONFIG.recipient,
        methodDetails: { chainId: TESTNET_CHAIN_ID },
      },
    })
    expect(() => assertTestnetChallenge(wrongCurrency)).toThrow(/pathUSD/)
  })

  it('refuse un secret de moins de 32 octets', () => {
    expect(() => createPayment({ ...TEST_CONFIG, secretKey: 'court' })).toThrow(/32 bytes/)
  })
})
