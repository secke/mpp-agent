import { BodyDigest, Challenge, Credential } from 'mppx'
import { describe, expect, it } from 'vitest'

import { createApp } from '../../server/app.ts'
import { ConfigError, loadConfig } from '../../server/config.ts'
import { env, TEST_CONFIG } from '../helpers.ts'

const app = createApp(TEST_CONFIG)
const url = (p: string) => `http://api.test${p}`

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request(url('/v1/analyze'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const challengeOf = async (body: unknown) =>
  Challenge.deserialize((await post(body)).headers.get('WWW-Authenticate')!)

/** Syntactically valid Credential, `proof` payload (verified off-chain). */
const credentialFor = (challenge: Challenge.Challenge) =>
  Credential.serialize(
    Credential.from({
      challenge,
      payload: { type: 'proof', signature: `0x${'22'.repeat(65)}` },
      source: 'did:pkh:eip155:42431:0x0000000000000000000000000000000000000001',
    }) as never,
  )

const problemType = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as { type?: string }
  return body.type?.split('/').pop()
}

describe('request body binding', () => {
  it('binds the body digest to the Challenge via `scope`', async () => {
    const body = { text: 'original body' }
    const challenge = await challengeOf(body)
    const opaque = JSON.parse(
      Buffer.from(String(challenge.opaque), 'base64url').toString(),
    ) as Record<string, string>

    expect(opaque['_mppx_scope']).toBe(
      `POST /v1/analyze#${BodyDigest.compute(JSON.stringify(body))}`,
    )
  })

  it('issues different Challenges for different bodies', async () => {
    const a = await challengeOf({ text: 'A' })
    const b = await challengeOf({ text: 'B' })
    expect(a.id).not.toBe(b.id)
  })

  it('rejects a Credential resubmitted with a modified body', async () => {
    // The heart of the requirement: a client must not be able to change the
    // body after receiving the Challenge.
    // Source: https://mpp.dev/advanced/security
    const original = { text: 'original body' }
    const credential = credentialFor(await challengeOf(original))

    const swapped = await post({ text: 'SWAPPED body' }, { Authorization: credential })
    expect(swapped.status).toBe(402)
    expect(await problemType(swapped)).toBe('invalid-challenge')
  })

  it('accepts the Challenge when the body is unchanged', async () => {
    // Same bogus Credential, right body: the Challenge passes the binding and
    // the failure is now about the payment proof, not the Challenge.
    // This contrast is what proves the binding really discriminates the body.
    const original = { text: 'original body' }
    const credential = credentialFor(await challengeOf(original))

    const same = await post(original, { Authorization: credential })
    expect(same.status).toBe(402)
    expect(await problemType(same)).toBe('verification-failed')
  })

  it('serves the POST route behind a payment', async () => {
    const response = await post({ text: 'hello' })
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Payment /)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('Cache-Control on paid responses', () => {
  it('sets `private` on a 200 carrying a Payment-Receipt', async () => {
    // We simulate the final response: the middleware is global, so it is enough
    // for a 200 response to carry the Receipt header to be marked `private`.
    const probe = createApp(TEST_CONFIG)
    probe.get('/fake-paid', (c) => {
      c.header('Payment-Receipt', 'eyJzdGF0dXMiOiJzdWNjZXNzIn0')
      return c.json({ ok: true })
    })

    const response = await probe.request(url('/fake-paid'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private')
  })

  it('leaves responses without a Receipt alone', async () => {
    const response = await app.request(url('/healthz'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBeNull()
  })

  it('keeps `no-store` on 402s', async () => {
    const response = await app.request(url('/v1/search?q=mpp'))
    expect(response.status).toBe(402)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('replay store configuration guards', () => {
  it('refuses the memory store without an explicit acknowledgement', () => {
    expect(() => loadConfig(env({ REPLAY_STORE: 'memory' }))).toThrow(ConfigError)
    expect(() => loadConfig(env({ REPLAY_STORE: 'memory' }))).toThrow(/replayable/)
  })

  it('accepts the memory store when the risk is acknowledged', () => {
    const config = loadConfig(
      env({ REPLAY_STORE: 'memory', REPLAY_STORE_MEMORY_ACK: 'i-know' }),
    )
    expect(config.replayStore).toBe('memory')
  })

  it('requires REDIS_URL for the redis store', () => {
    expect(() => loadConfig(env({ REPLAY_STORE: 'redis' }))).toThrow(/REDIS_URL/)
    expect(
      loadConfig(env({ REPLAY_STORE: 'redis', REDIS_URL: 'redis://localhost:6379' }))
        .replayStore,
    ).toBe('redis')
  })

  it('refuses an unknown backend', () => {
    expect(() => loadConfig(env({ REPLAY_STORE: 'postgres' }))).toThrow(/unknown/)
  })

  it('uses sqlite by default — not memory', () => {
    const { REPLAY_STORE: _omit, ...rest } = env()
    expect(loadConfig(rest).replayStore).toBe('sqlite')
  })
})
