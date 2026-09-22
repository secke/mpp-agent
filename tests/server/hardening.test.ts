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

/** Credential syntaxiquement valide, payload `proof` (vérifié hors-chaîne). */
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

describe('liaison du corps de requête', () => {
  it('lie le digest du corps au Challenge via `scope`', async () => {
    const body = { text: 'corps original' }
    const challenge = await challengeOf(body)
    const opaque = JSON.parse(
      Buffer.from(String(challenge.opaque), 'base64url').toString(),
    ) as Record<string, string>

    expect(opaque['_mppx_scope']).toBe(
      `POST /v1/analyze#${BodyDigest.compute(JSON.stringify(body))}`,
    )
  })

  it('émet des Challenges différents pour des corps différents', async () => {
    const a = await challengeOf({ text: 'A' })
    const b = await challengeOf({ text: 'B' })
    expect(a.id).not.toBe(b.id)
  })

  it('rejette un Credential redéposé avec un corps modifié', async () => {
    // Le cœur de l'exigence : un client ne doit pas pouvoir changer le corps
    // après avoir reçu le Challenge.
    // Source : https://mpp.dev/advanced/security
    const original = { text: 'corps original' }
    const credential = credentialFor(await challengeOf(original))

    const swapped = await post({ text: 'corps SUBSTITUE' }, { Authorization: credential })
    expect(swapped.status).toBe(402)
    expect(await problemType(swapped)).toBe('invalid-challenge')
  })

  it('accepte le Challenge quand le corps est inchangé', async () => {
    // Même Credential bidon, bon corps : le Challenge passe la liaison et
    // l'échec porte désormais sur la preuve de paiement, pas sur le Challenge.
    // C'est ce contraste qui prouve que la liaison discrimine bien le corps.
    const original = { text: 'corps original' }
    const credential = credentialFor(await challengeOf(original))

    const same = await post(original, { Authorization: credential })
    expect(same.status).toBe(402)
    expect(await problemType(same)).toBe('verification-failed')
  })

  it('sert la route POST derrière un paiement', async () => {
    const response = await post({ text: 'bonjour' })
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toMatch(/^Payment /)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('Cache-Control sur les réponses payées', () => {
  it('pose `private` sur un 200 porteur d’un Payment-Receipt', async () => {
    // On simule la réponse finale : le middleware est global, donc il suffit
    // qu'une réponse 200 porte l'en-tête Receipt pour être marquée `private`.
    const probe = createApp(TEST_CONFIG)
    probe.get('/faux-paye', (c) => {
      c.header('Payment-Receipt', 'eyJzdGF0dXMiOiJzdWNjZXNzIn0')
      return c.json({ ok: true })
    })

    const response = await probe.request(url('/faux-paye'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private')
  })

  it('ne touche pas aux réponses sans Receipt', async () => {
    const response = await app.request(url('/healthz'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBeNull()
  })

  it('laisse `no-store` sur les 402', async () => {
    const response = await app.request(url('/v1/search?q=mpp'))
    expect(response.status).toBe(402)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('garde-fous de configuration du store anti-rejeu', () => {
  it('refuse le store mémoire sans acquittement explicite', () => {
    expect(() => loadConfig(env({ REPLAY_STORE: 'memory' }))).toThrow(ConfigError)
    expect(() => loadConfig(env({ REPLAY_STORE: 'memory' }))).toThrow(/rejouable/)
  })

  it('accepte le store mémoire quand le risque est acquitté', () => {
    const config = loadConfig(
      env({ REPLAY_STORE: 'memory', REPLAY_STORE_MEMORY_ACK: 'i-know' }),
    )
    expect(config.replayStore).toBe('memory')
  })

  it('exige REDIS_URL pour le store redis', () => {
    expect(() => loadConfig(env({ REPLAY_STORE: 'redis' }))).toThrow(/REDIS_URL/)
    expect(
      loadConfig(env({ REPLAY_STORE: 'redis', REDIS_URL: 'redis://localhost:6379' }))
        .replayStore,
    ).toBe('redis')
  })

  it('refuse un support inconnu', () => {
    expect(() => loadConfig(env({ REPLAY_STORE: 'postgres' }))).toThrow(/inconnu/)
  })

  it('utilise sqlite par défaut — pas la mémoire', () => {
    const { REPLAY_STORE: _omit, ...rest } = env()
    expect(loadConfig(rest).replayStore).toBe('sqlite')
  })
})
