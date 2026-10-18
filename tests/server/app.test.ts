import { Challenge } from 'mppx'
import { describe, expect, it } from 'vitest'

import { createApp } from '../../server/app.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'
import { TEST_CONFIG, TEST_SECRET } from '../helpers.ts'

const app = createApp(TEST_CONFIG)
const url = (path: string) => `http://api.test${path}`

describe('GET /healthz', () => {
  it('responds 200 without payment', async () => {
    const res = await app.request(url('/healthz'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })
})

describe('GET /v1/search without a Credential', () => {
  it('responds 402 Payment Required', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    expect(res.status).toBe(402)
  })

  it('carries a Payment Challenge in WWW-Authenticate', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    const header = res.headers.get('WWW-Authenticate')
    expect(header).toBeTruthy()
    expect(header).toMatch(/^Payment /)
  })

  it("applies the security headers required by the spec", async () => {
    // Source : https://mpp.dev/advanced/security
    // "Send Cache-Control: no-store with 402 responses"
    const res = await app.request(url('/v1/search?q=mpp'))
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toMatch(/application\/problem\+json/)
  })

  it('issues a Challenge HMAC-bound to the server secret', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)

    expect(Challenge.verify(challenge, { secretKey: TEST_SECRET })).toBe(true)
    expect(Challenge.verify(challenge, { secretKey: 'another-secret-of-at-least-32-bytes' })).toBe(
      false,
    )
  })

  it('advertises the expected price, testnet network and recipient', async () => {
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

  it('uses Authorization as the Credential field (no application auth)', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)
    expect(Challenge.credentialHeader(challenge)).toBe('Authorization')
  })

  it('discloses no result in the 402 response', async () => {
    const res = await app.request(url('/v1/search?q=mpp'))
    expect(await res.text()).not.toMatch(/example\.invalid/)
  })
})

describe('GET /v1/search with an invalid Credential', () => {
  it('responds 402 (not 401) with a fresh Challenge', async () => {
    // Source: https://mpp.dev/protocol/http-402 — MPP returns 402 even
    // when a Credential fails validation.
    const res = await app.request(url('/v1/search?q=mpp'), {
      headers: { Authorization: 'Payment bWFsZm9ybWU' },
    })
    expect(res.status).toBe(402)
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Payment /)
  })
})

describe('GET /openapi.json', () => {
  it('serves an OpenAPI 3.1 discovery document', async () => {
    const res = await app.request(url('/openapi.json'))
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toMatch(/^3\.1/)
    expect(doc.paths).toHaveProperty('/v1/search')
  })

  it('advertises the payment terms of the paid route', async () => {
    const res = await app.request(url('/openapi.json'))
    const doc = (await res.json()) as any
    const paymentInfo = doc.paths['/v1/search'].get['x-payment-info']
    expect(paymentInfo).toBeTruthy()
    expect(JSON.stringify(paymentInfo)).toContain('tempo')
  })
})
