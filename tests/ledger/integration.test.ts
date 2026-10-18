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

describe('ledger wired to the provider', () => {
  it('logs exactly one row per issued Challenge', async () => {
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

  it('ties the row to the Challenge actually sent to the client', async () => {
    const { app, ledger } = wired()
    const res = await app.request(url('/v1/search?q=mpp'))
    const challenge = Challenge.deserialize(res.headers.get('WWW-Authenticate')!)
    expect(ledger.get(challenge.id)).toBeDefined()
  })

  it('captures the route via the scope bound in opaque', async () => {
    const { app, ledger } = wired()
    await app.request(url('/v1/search?q=mpp'))
    expect(ledger.all()[0]!.route).toBe('GET /v1/search')
  })

  it('logs a failure with the MPP error code', async () => {
    const { app, ledger } = wired()
    await app.request(url('/v1/search?q=mpp'), {
      headers: { Authorization: 'Payment bWFsZm9ybWU' },
    })

    const failed = ledger.all().filter((r) => r.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error_code).toBeTruthy()
    expect(failed[0]!.error_code).not.toBe('unknown')
  })

  it('counts every issued Challenge, even when ids collide', async () => {
    const { app, ledger } = wired()
    const REQUESTS = 12
    // Requests without a Credential: exactly one Challenge issued per request.
    for (let i = 0; i < REQUESTS; i++) await app.request(url('/v1/search?q=mpp'))

    // The Challenge id is an HMAC of its parameters: two identical requests
    // within the same millisecond get the SAME id and therefore share their
    // row. The number of rows thus depends on timing — but the total of
    // occurrences is exact.
    const rows = ledger.all()
    expect(rows.length).toBeLessThanOrEqual(REQUESTS)
    expect(rows.reduce((sum, r) => sum + r.occurrences, 0)).toBe(REQUESTS)
  })

  it('logs nothing for free routes', async () => {
    const { app, ledger } = wired()
    await app.request(url('/healthz'))
    await app.request(url('/openapi.json'))
    expect(ledger.all()).toHaveLength(0)
  })
})

describe('no secret in the database', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-secrets-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('the SQLite file contains no Credential, no Receipt, no secret', async () => {
    const path = join(dir, 'ledger.sqlite')
    const payment = createPayment(TEST_CONFIG)
    const ledger = new Ledger(openLedger(path))
    attachLedger(payment, ledger)
    const app = createApp(TEST_CONFIG, payment)

    // A Challenge, then an invalid Credential: both write paths.
    const credential = 'Payment eyJjaGFsbGVuZ2UiOnsiaWQiOiJzZWNyZXQtY3JlZGVudGlhbCJ9fQ'
    await app.request(url('/v1/search?q=mpp'))
    await app.request(url('/v1/search?q=mpp'), { headers: { Authorization: credential } })
    ledger.close()

    const bytes = readFileSync(path).toString('binary')

    // Guard against a vacuous test: the database must really contain the writes,
    // otherwise the negative assertions below would pass for nothing.
    // (We do not assert a row count: two identical Challenges issued within
    // the same millisecond share their id, hence their row.)
    const written = new Ledger(openLedger(path))
    const rows = written.all()
    written.close()
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.some((r) => r.status === 'failed')).toBe(true)
    // >= 2 and not == 2: a request carrying an invalid Credential issues two
    // Challenges (the submitted one, then the fresh retry required by the spec).
    expect(rows.reduce((sum, r) => sum + r.occurrences, 0)).toBeGreaterThanOrEqual(2)
    expect(bytes).toContain('500000')
    expect(bytes).toContain(rows[0]!.challenge_id)

    // Explicit prohibitions from docs/NOTES.md §8.
    expect(bytes).not.toContain(TEST_SECRET)
    expect(bytes).not.toContain(credential)
    expect(bytes).not.toContain('eyJjaGFsbGVuZ2UiOnsiaWQiOiJzZWNyZXQtY3JlZGVudGlhbCJ9fQ')
    expect(bytes).not.toContain('Payment-Receipt')
    expect(bytes).not.toMatch(/Authorization/i)
    // And nothing that looks like a private key.
    expect(bytes).not.toMatch(/0x[0-9a-fA-F]{64}/)
  })

  it('the schema columns allow nothing sensitive', () => {
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
    // No column can hold a Credential, a Receipt or a message.
    for (const forbidden of ['credential', 'authorization', 'receipt', 'secret', 'message', 'header'])
      expect(columns.some((c) => c.includes(forbidden))).toBe(false)
  })
})
