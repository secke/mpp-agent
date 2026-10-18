/**
 * Provider entry point.
 *
 * Run with: `npm run dev` (= node --env-file=.env --import tsx server/index.ts)
 * `--env-file` is native since Node 20.6 — no dotenv dependency.
 */
import { serve } from '@hono/node-server'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { attachLedger, Ledger } from '../ledger/record.ts'
import { openLedger } from '../ledger/db.ts'
import { createMetrics } from '../observability/metrics.ts'
import { createApp } from './app.ts'
import { createReplayStore } from './bootstrap.ts'
import { loadConfig } from './config.ts'
import { createPayment, selfCheck } from './payment.ts'

const config = loadConfig()

// Replay store. The mppx in-memory default is neither shared between
// processes nor durable: `loadConfig` refuses it without an explicit acknowledgement.
const { store } = await createReplayStore(config)
const payment = createPayment(config, store)

// Fail at startup rather than on the first paid request.
await selfCheck(payment, config)

// Audit ledger: hooked in, off the business path.
if (config.ledgerPath !== ':memory:') mkdirSync(dirname(config.ledgerPath), { recursive: true })
const ledger = new Ledger(openLedger(config.ledgerPath))
attachLedger(payment, ledger)

// Export disabled without METRICS_TOKEN (see server/app.ts).
const metrics = config.metricsToken ? createMetrics() : undefined
metrics?.attach(payment)

const app = createApp(config, payment, metrics)

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`MPP provider listening on http://localhost:${port}`)
  console.log(`realm=${config.realm} · network=Tempo Moderato (42431) · price=${config.searchPrice}`)
  console.log(`ledger=${config.ledgerPath} · replay-store=${config.replayStore}`)
})
