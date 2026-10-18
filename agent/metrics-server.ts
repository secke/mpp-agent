/**
 * `/metrics` exposure of the agent process.
 *
 * The agent is a short-lived command: we serve the export during the run,
 * then keep it up for `lingerMs` after it ends to give Prometheus time for a
 * scrape (see docs/features/observability.md).
 *
 * Same rule as the server: bearer token required (fail-closed), no sensitive
 * label — the series come from `observability/metrics.ts`.
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
