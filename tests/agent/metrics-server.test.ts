import { describe, expect, it } from 'vitest'

import { BudgetGuard } from '../../agent/budget.ts'
import { createMetricsApp, startMetricsServer } from '../../agent/metrics-server.ts'
import { createMetrics } from '../../observability/metrics.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'

const TOKEN = 'agent-metrics-token-0123'

function setup() {
  const guard = new BudgetGuard({
    maxPerCall: 1_000_000n,
    totalBudget: 5_000_000n,
    chainId: TESTNET_CHAIN_ID,
    currency: PATH_USD,
    decimals: 6,
  })
  const metrics = createMetrics()
  metrics.attachAgent(guard)
  return { metrics }
}

describe('metrics-server (agent)', () => {
  it('refuse sans jeton valide', async () => {
    const app = createMetricsApp(setup().metrics, TOKEN)
    expect((await app.request('http://a/metrics')).status).toBe(401)
    const bad = { headers: { Authorization: 'Bearer nope' } }
    expect((await app.request('http://a/metrics', bad)).status).toBe(401)
  })

  it("expose la dépense et le budget restant de l'agent", async () => {
    const app = createMetricsApp(setup().metrics, TOKEN)
    const res = await app.request('http://a/metrics', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toMatch(/agent_spent_pathusd 0/)
    expect(text).toMatch(/agent_budget_remaining_pathusd 5/)
    expect(text).not.toContain(TOKEN)
  })

  it('écoute réellement sur un port et se ferme', async () => {
    const server = await startMetricsServer(setup().metrics, { port: 0, token: TOKEN })
    const url = `http://127.0.0.1:${server.port}/metrics`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    await server.close()
  })
})
