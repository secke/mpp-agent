import { Challenge } from 'mppx'
import { describe, expect, it } from 'vitest'

import { createApp } from '../../server/app.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'
import { TEST_CONFIG, TEST_SECRET } from '../helpers.ts'

const app = createApp(TEST_CONFIG)
const url = (path: string) => `http://api.test${path}`

describe('GET /healthz', () => {
  it('répond 200 sans paiement', async () => {
    const res = await app.request(url('/healthz'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('GET /v1/search sans Credential', () => {
  it('répond 402 Payment Required', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    expect(res.status).toBe(402)
  })

  it('porte un Challenge Payment dans WWW-Authenticate', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    const header = res.headers.get('WWW-Authenticate')
    expect(header).toBeTruthy()
    expect(header).toMatch(/^Payment /)
  })

  it("applique les en-têtes de sécurité exigés par la spec", async () => {
    // Source : https://mpp.dev/advanced/security
    // « Send Cache-Control: no-store with 402 responses »
    const res = await app.request(url('/v1/search?q=mpp'))
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toMatch(/application\/problem\+json/)
  })

  it('émet un Challenge lié HMAC au secret du serveur', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)

    expect(Challenge.verify(challenge, { secretKey: TEST_SECRET })).toBe(true)
    expect(Challenge.verify(challenge, { secretKey: 'un-autre-secret-de-32-octets-au-moins' })).toBe(
      false,
    )
  })

  it('annonce le prix, le réseau testnet et le destinataire attendus', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)
    const request = challenge.request as {
      amount: string
      currency: string
      recipient: string
      methodDetails: { chainId: number }
    }

    expect(request.amount).toBe('500000') // 0.50 × 10^6
    expect(request.currency.toLowerCase()).toBe(PATH_USD)
    expect(request.recipient.toLowerCase()).toBe(TEST_CONFIG.recipient.toLowerCase())
    expect(request.methodDetails.chainId).toBe(TESTNET_CHAIN_ID)
  })

  it('utilise Authorization comme champ de Credential (pas d\'auth applicative)', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)
    expect(Challenge.credentialHeader(challenge)).toBe('Authorization')
  })

  it('ne divulgue aucun résultat dans la réponse 402', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    expect(await res.text()).not.toMatch(/example\.invalid/)
  })
})

describe('GET /v1/search avec un Credential invalide', () => {
  it('répond 402 (et non 401) avec un Challenge frais', async () => {
    // Source : https://mpp.dev/protocol/http-402 — MPP renvoie 402 y compris
    // quand un Credential échoue la validation.
    const res = await app.request(url('/v1/search?q=mpp'), {
      headers: { Authorization: 'Payment bWFsZm9ybWU' },
    })
    expect(res.status).toBe(402)
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Payment /)
  })
})

describe('GET /openapi.json', () => {
  it('sert un document de découverte OpenAPI 3.1', async () => {
    const res = await app.request(url('/openapi.json'))
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toMatch(/^3\.1/)
    expect(doc.paths).toHaveProperty('/v1/search')
  })

  it('annonce les conditions de paiement de la route payante', async () => {
    const res = await app.request(url('/openapi.json'))
    const doc = (await res.json()) as any
    const paymentInfo = doc.paths['/v1/search'].get['x-payment-info']
    expect(paymentInfo).toBeTruthy()
    expect(JSON.stringify(paymentInfo)).toContain('tempo')
  })
})
