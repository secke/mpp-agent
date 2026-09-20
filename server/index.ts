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
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createPayment, selfCheck } from './payment.ts'

const config = loadConfig()
const payment = createPayment(config)

// Échouer au démarrage plutôt qu'à la première requête payante.
await selfCheck(payment, config)

// Journal d'audit : branché sur les hooks, hors du chemin métier.
if (config.ledgerPath !== ':memory:') mkdirSync(dirname(config.ledgerPath), { recursive: true })
const ledger = new Ledger(openLedger(config.ledgerPath))
attachLedger(payment, ledger)

const app = createApp(config, payment)

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`provider MPP à l'écoute sur http://localhost:${port}`)
  console.log(`realm=${config.realm} · réseau=Tempo Moderato (42431) · prix=${config.searchPrice}`)
  console.log(`ledger=${config.ledgerPath}`)
})
