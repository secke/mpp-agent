/**
 * Application Hono du provider MPP.
 *
 * Routes :
 *   GET /healthz       — gratuit, sonde de vivacité
 *   GET /v1/search     — payant (intent `charge`)
 *   GET /openapi.json  — document de découverte, généré par mppx
 *
 * Source découverte : https://mpp.dev/advanced/discovery
 * (« You serve a standard OpenAPI 3.1 document at /openapi.json with
 *   x-payment-info extensions »), helper `discovery(app, mppx, …)` de mppx/hono.
 */
import { Hono } from 'hono'
import { Credential } from 'mppx'
import { discovery } from 'mppx/hono'

import type { Config } from './config.ts'
import { createPayment, type Payment } from './payment.ts'
import { search } from './search.ts'

export function createApp(config: Config, payment: Payment = createPayment(config)) {
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ status: 'ok', realm: config.realm }))

  app.get(
    '/v1/search',
    payment.charge({
      amount: config.searchPrice,
      description: 'Recherche documentaire — 1 requête',
    }),
    (c) => {
      const query = c.req.query('q') ?? ''
      // Le paiement est vérifié : le Credential est encore sur la requête.
      // `source` est un DID (did:pkh:eip155:42431:0x…).
      // Source : https://mpp.dev/sdk/typescript/middlewares/hono § Identifying the payer
      const header = c.req.header('Authorization')
      const payer = header ? Credential.deserialize(header).source : undefined
      return c.json({ query, payer, results: search(query) })
    },
  )

  discovery(app, payment, {
    auto: true,
    info: { title: 'Agentic Research Marketplace', version: '0.1.0' },
  })

  return app
}

export type App = ReturnType<typeof createApp>
