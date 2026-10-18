import { describe, expect, it } from 'vitest'

import { BudgetGuard } from '../../agent/budget.ts'
import { createMetrics } from '../../observability/metrics.ts'
import { createApp } from '../../server/app.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'
import { createPayment } from '../../server/payment.ts'
import { TEST_CONFIG, TEST_SECRET } from '../helpers.ts'

const TOKEN = 'metrics-token-0123456789'
const CONFIG = { ...TEST_CONFIG, metricsToken: TOKEN }
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } }
const url = (path: string) => `http://api.test${path}`

function setup() {
  const payment = createPayment(TEST_CONFIG)
  const metrics = createMetrics()
  metrics.attach(payment)
  return { app: createApp(CONFIG, payment, metrics), metrics }
}

describe('GET /metrics', () => {
  it('refuses without a token or with a wrong token', async () => {
    const { app } = setup()
    expect((await app.request(url('/metrics'))).status).toBe(401)
    const bad = { headers: { Authorization: 'Bearer nope' } }
    expect((await app.request(url('/metrics'), bad)).status).toBe(401)
  })

  it('is absent without a configured metricsToken', async () => {
    const payment = createPayment(TEST_CONFIG)
    const app = createApp(TEST_CONFIG, payment, createMetrics())
    expect((await app.request(url('/metrics'), auth)).status).toBe(404)
  })

  it('counts issued Challenges by method/intent', async () => {
    const { app } = setup()
    await app.request(url('/v1/search?q=a'))
    await app.request(url('/v1/search?q=b'))
    const text = await (await app.request(url('/metrics'), auth)).text()
    expect(text).toMatch(/mpp_challenges_total\{method="tempo",intent="charge"\} 2/)
  })

  it('times a request carrying an invalid Credential', async () => {
    const { app } = setup()
    const bad = 'Payment ' + Buffer.from('{"bogus":true}').toString('base64url')
    await app.request(url('/v1/search?q=a'), { headers: { Authorization: bad } })
    const text = await (await app.request(url('/metrics'), auth)).text()
    expect(text).toContain('mpp_settlement_duration_seconds_count{status="failed"} 1')
  })

  it("exposes the agent's spend", async () => {
    const { app, metrics } = setup()
    const guard = new BudgetGuard({
      maxPerCall: 1_000_000n,
      totalBudget: 5_000_000n,
      chainId: TESTNET_CHAIN_ID,
      currency: PATH_USD,
      decimals: 6,
    })
    metrics.attachAgent(guard)
    const text = await (await app.request(url('/metrics'), auth)).text()
    expect(text).toMatch(/agent_spent_pathusd 0/)
    expect(text).toMatch(/agent_budget_remaining_pathusd 5/)
  })

  it("exposes no sensitive value", async () => {
    const { app } = setup()
    const res = await app.request(url('/v1/search?q=secret-query'))
    const id = /id="([^"]+)"/.exec(res.headers.get('WWW-Authenticate')!)![1]!
    const text = await (await app.request(url('/metrics'), auth)).text()
    for (const forbidden of [TEST_SECRET, id, TEST_CONFIG.recipient, 'secret-query', '500000', 'Payment '])
      expect(text).not.toContain(forbidden)
    // Only allowlisted labels appear (`le` = histogram bucket).
    const labels = new Set([...text.matchAll(/(\w+)="/g)].map((m) => m[1]!))
    expect([...labels].filter((l) => !['method', 'intent', 'status', 'code', 'le'].includes(l))).toEqual([])
  })
})
