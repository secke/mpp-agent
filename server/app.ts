/**
 * Application Hono du provider MPP.
 *
 * Routes :
 *   GET /healthz       — gratuit, sonde de vivacité
 *   GET /v1/search     — payant (intent `charge`)
 *   GET /metrics       — gratuit, export Prometheus (si métriques fournies)
 *   GET /openapi.json  — document de découverte, généré par mppx
 *
 * Source découverte : https://mpp.dev/advanced/discovery
 * (« You serve a standard OpenAPI 3.1 document at /openapi.json with
 *   x-payment-info extensions »), helper `discovery(app, mppx, …)` de mppx/hono.
 */
import { Hono } from 'hono'
import { BodyDigest, Credential } from 'mppx'
import { discovery } from 'mppx/hono'

import type { Metrics } from '../observability/metrics.ts'
import { analyze } from './analyze.ts'
import type { Config } from './config.ts'
import { createPayment, type Payment } from './payment.ts'
import { search } from './search.ts'

export function createApp(
  config: Config,
  payment: Payment = createPayment(config),
  metrics?: Metrics,
) {
  const app = new Hono()

  // Latence de règlement : seules les requêtes portant un Credential
  // (`Authorization: Payment …`) sont chronométrées. L'en-tête n'est que testé,
  // jamais lu ni journalisé.
  if (metrics)
    app.use('*', async (c, next) => {
      const paid = c.req.header('Authorization')?.startsWith('Payment ') === true
      const start = performance.now()
      await next()
      if (paid)
        metrics.settlement.observe(
          { status: c.res.status === 200 ? 'success' : 'failed' },
          (performance.now() - start) / 1000,
        )
    })

  /**
   * Une réponse 200 porteuse d'un Receipt ne doit pas être mise en cache par
   * un intermédiaire partagé. mppx pose `no-store` sur les 402 tout seul,
   * mais pas `private` sur les 200 — c'est à notre charge.
   * Source : https://mpp.dev/advanced/security
   * « Send Cache-Control: private on successful responses that include
   *   Payment-Receipt. »
   */
  app.use('*', async (c, next) => {
    await next()
    if (c.res.status === 200 && c.res.headers.has('Payment-Receipt'))
      c.res.headers.set('Cache-Control', 'private')
  })

  if (metrics)
    app.get('/metrics', async (c) =>
      c.body(await metrics.render(), 200, { 'Content-Type': metrics.contentType }),
    )

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

  /**
   * Route POST : le corps est **lié** au Challenge.
   *
   * ⚠️ Le serveur TypeScript de mppx n'expose pas d'option `body`/`digest`
   * sur le middleware (contrairement au SDK Python). On implémente donc la
   * liaison via `scope`, que mppx intègre à `meta` → `opaque` → HMAC du
   * Challenge. Un corps modifié après l'émission produit un scope différent,
   * donc un identifiant de Challenge différent : le Credential ne vérifie plus.
   *
   * Source de l'exigence : https://mpp.dev/advanced/security
   * « Include a digest parameter for POST, PUT, and PATCH requests so clients
   *   cannot change the request body after receiving a Challenge. »
   */
  app.post('/v1/analyze', async (c, next) => {
    // `clone()` : on lit le corps sans le consommer pour la suite de la chaîne.
    const raw = await c.req.raw.clone().text()
    const middleware = payment.charge({
      amount: config.analyzePrice,
      description: 'Analyse documentaire — 1 requête',
      scope: `POST /v1/analyze#${BodyDigest.compute(raw)}`,
    })
    return middleware(c, next)
  })

  app.post('/v1/analyze', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown }
    const header = c.req.header('Authorization')
    const payer = header ? Credential.deserialize(header).source : undefined
    return c.json({ payer, analysis: analyze(typeof body.text === 'string' ? body.text : '') })
  })

  discovery(app, payment, {
    auto: true,
    info: { title: 'Agentic Research Marketplace', version: '0.1.0' },
  })

  return app
}

export type App = ReturnType<typeof createApp>
