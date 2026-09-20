import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Challenge } from 'mppx'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openLedger } from '../../ledger/db.ts'
import { attachLedger, Ledger } from '../../ledger/record.ts'
import { createApp } from '../../server/app.ts'
import { TESTNET_CHAIN_ID } from '../../server/config.ts'
import { createPayment } from '../../server/payment.ts'
import { TEST_CONFIG, TEST_SECRET } from '../helpers.ts'

function wired() {
  const payment = createPayment(TEST_CONFIG)
  const ledger = new Ledger(openLedger(':memory:'))
  attachLedger(payment, ledger)
  return { app: createApp(TEST_CONFIG, payment), ledger }
}

const url = (p: string) => `http://api.test${p}`

describe('ledger branché sur le provider', () => {
  it('journalise exactement une ligne par Challenge émis', async () => {
    const { app, ledger } = wired()
    const res = await app.request(url('/v1/search?q=mpp'))
    expect(res.status).toBe(402)

    const rows = ledger.all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'challenged',
      method: 'tempo',
      intent: 'charge',
      amount: '500000',
      chain_id: TESTNET_CHAIN_ID,
      realm: 'api.test',
    })
  })

  it('associe la ligne au Challenge réellement envoyé au client', async () => {
    const { app, ledger } = wired()
    const res = await app.request(url('/v1/search?q=mpp'))
    const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)
    expect(ledger.get(challenge.id)).toBeDefined()
  })

  it('capture la route via le scope lié dans opaque', async () => {
    const { app, ledger } = wired()
    await app.request(url('/v1/search?q=mpp'))
    expect(ledger.all()[0]!.route).toBe('GET /v1/search')
  })

  it('journalise un échec avec le code d’erreur MPP', async () => {
    const { app, ledger } = wired()
    await app.request(url('/v1/search?q=mpp'), {
      headers: { Authorization: 'Payment bWFsZm9ybWU' },
    })

    const failed = ledger.all().filter((r) => r.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error_code).toBeTruthy()
    expect(failed[0]!.error_code).not.toBe('unknown')
  })

  it('comptabilise chaque Challenge émis, même quand les ids entrent en collision', async () => {
    const { app, ledger } = wired()
    const REQUESTS = 12
    // Requêtes sans Credential : exactement un Challenge émis par requête.
    for (let i = 0; i < REQUESTS; i++) await app.request(url('/v1/search?q=mpp'))

    // L'id de Challenge est un HMAC de ses paramètres : deux requêtes
    // identiques dans la même milliseconde reçoivent le MÊME id et partagent
    // donc leur ligne. Le nombre de lignes dépend donc du timing — mais le
    // total des occurrences, lui, est exact.
    const rows = ledger.all()
    expect(rows.length).toBeLessThanOrEqual(REQUESTS)
    expect(rows.reduce((sum, r) => sum + r.occurrences, 0)).toBe(REQUESTS)
  })

  it('ne journalise rien pour les routes gratuites', async () => {
    const { app, ledger } = wired()
    await app.request(url('/healthz'))
    await app.request(url('/openapi.json'))
    expect(ledger.all()).toHaveLength(0)
  })
})

describe('aucun secret dans la base', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-secrets-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('le fichier SQLite ne contient ni Credential, ni Receipt, ni secret', async () => {
    const path = join(dir, 'ledger.sqlite')
    const payment = createPayment(TEST_CONFIG)
    const ledger = new Ledger(openLedger(path))
    attachLedger(payment, ledger)
    const app = createApp(TEST_CONFIG, payment)

    // Un Challenge, puis un Credential invalide : les deux chemins d'écriture.
    const credential = 'Payment eyJjaGFsbGVuZ2UiOnsiaWQiOiJzZWNyZXQtY3JlZGVudGlhbCJ9fQ'
    await app.request(url('/v1/search?q=mpp'))
    await app.request(url('/v1/search?q=mpp'), { headers: { Authorization: credential } })
    ledger.close()

    const bytes = readFileSync(path).toString('binary')

    // Garde anti-test-vide : la base doit vraiment contenir les écritures,
    // sinon les assertions négatives ci-dessous passeraient pour rien.
    // (On n'assert pas un nombre de lignes : deux Challenges identiques émis
    // dans la même milliseconde partagent leur id, donc leur ligne.)
    const written = new Ledger(openLedger(path))
    const rows = written.all()
    written.close()
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.some((r) => r.status === 'failed')).toBe(true)
    // >= 2 et non == 2 : une requête portant un Credential invalide émet deux
    // Challenges (celui soumis, puis le retry frais exigé par la spec).
    expect(rows.reduce((sum, r) => sum + r.occurrences, 0)).toBeGreaterThanOrEqual(2)
    expect(bytes).toContain('500000')
    expect(bytes).toContain(rows[0]!.challenge_id)

    // Interdits explicites de docs/NOTES.md §8.
    expect(bytes).not.toContain(TEST_SECRET)
    expect(bytes).not.toContain(credential)
    expect(bytes).not.toContain('eyJjaGFsbGVuZ2UiOnsiaWQiOiJzZWNyZXQtY3JlZGVudGlhbCJ9fQ')
    expect(bytes).not.toContain('Payment-Receipt')
    expect(bytes).not.toMatch(/Authorization/i)
    // Et rien qui ressemble à une clé privée.
    expect(bytes).not.toMatch(/0x[0-9a-fA-F]{64}/)
  })

  it('les colonnes du schéma n’autorisent rien de sensible', () => {
    const db = openLedger(':memory:')
    const columns = (db.prepare(`select name from pragma_table_info('payments')`).all() as {
      name: string
    }[]).map((c) => c.name)
    db.close()

    expect(columns).toEqual([
      'challenge_id', 'realm', 'method', 'intent', 'route', 'amount', 'currency',
      'recipient', 'chain_id', 'status', 'reference', 'payer', 'error_code',
      'occurrences', 'created_at', 'updated_at',
    ])
    // Aucune colonne ne peut accueillir un Credential, un Receipt ou un message.
    for (const forbidden of ['credential', 'authorization', 'receipt', 'secret', 'message', 'header'])
      expect(columns.some((c) => c.includes(forbidden))).toBe(false)
  })
})
