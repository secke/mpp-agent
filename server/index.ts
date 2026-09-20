/**
 * Point d'entrée du provider.
 *
 * Lancement : `npm run dev` (= node --env-file=.env --import tsx server/index.ts)
 * `--env-file` est natif depuis Node 20.6 — pas de dépendance dotenv.
 */
import { serve } from '@hono/node-server'

import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createPayment, selfCheck } from './payment.ts'

const config = loadConfig()
const payment = createPayment(config)

// Échouer au démarrage plutôt qu'à la première requête payante.
await selfCheck(payment, config)

const app = createApp(config, payment)

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`provider MPP à l'écoute sur http://localhost:${port}`)
  console.log(`realm=${config.realm} · réseau=Tempo Moderato (42431) · prix=${config.searchPrice}`)
})
