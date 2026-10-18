/**
 * Exposition `/metrics` du processus agent.
 *
 * L'agent est une commande à exécution courte : on sert l'export pendant le
 * run, puis on le maintient `lingerMs` après la fin pour laisser à Prometheus
 * le temps d'un scrape (voir docs/features/observabilite.md).
 *
 * Même règle que le serveur : jeton bearer obligatoire (fail-closed), aucun
 * label sensible — les séries viennent de `observability/metrics.ts`.
 */
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'

import type { Metrics } from '../observability/metrics.ts'

export function createMetricsApp(metrics: Metrics, token: string) {
  const app = new Hono()
  app.get('/metrics', bearerAuth({ token }), async (c) =>
    c.body(await metrics.render(), 200, { 'Content-Type': metrics.contentType }),
  )
  return app
}

export type MetricsServer = { port: number; close(): Promise<void> }

export function startMetricsServer(
  metrics: Metrics,
  options: { port: number; token: string },
): Promise<MetricsServer> {
  const app = createMetricsApp(metrics, options.token)
  return new Promise((resolve) => {
    const server: ServerType = serve({ fetch: app.fetch, port: options.port }, ({ port }) =>
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    )
  })
}
