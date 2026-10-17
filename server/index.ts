/**
 * Point d'entrée du provider.
 *
 * Lancement : `npm run dev` (= node --env-file=.env --import tsx server/index.ts)
 * `--env-file` est natif depuis Node 20.6 — pas de dépendance dotenv.
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

// Store anti-rejeu. Le défaut mémoire de mppx n'est ni partagé entre
// processus ni durable : `loadConfig` le refuse sans acquittement explicite.
const { store } = await createReplayStore(config)
const payment = createPayment(config, store)

// Échouer au démarrage plutôt qu'à la première requête payante.
await selfCheck(payment, config)

// Journal d'audit : branché sur les hooks, hors du chemin métier.
if (config.ledgerPath !== ':memory:') mkdirSync(dirname(config.ledgerPath), { recursive: true })
const ledger = new Ledger(openLedger(config.ledgerPath))
attachLedger(payment, ledger)

// Export désactivé sans METRICS_TOKEN (voir server/app.ts).
const metrics = config.metricsToken ? createMetrics() : undefined
metrics?.attach(payment)

const app = createApp(config, payment, metrics)

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`provider MPP à l'écoute sur http://localhost:${port}`)
  console.log(`realm=${config.realm} · réseau=Tempo Moderato (42431) · prix=${config.searchPrice}`)
  console.log(`ledger=${config.ledgerPath} · anti-rejeu=${config.replayStore}`)
})
