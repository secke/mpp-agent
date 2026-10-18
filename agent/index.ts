/**
 * Demo entry point: the model decides by itself whether to buy a search
 * on the marketplace.
 *
 * Run with: `npm run agent -- "your question"`
 * (the provider must be running: `npm run dev`)
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { createMetrics } from '../observability/metrics.ts'
import { fromBaseUnits } from './amount.ts'
import { BudgetGuard } from './budget.ts'
import { createPayingClient } from './client.ts'
import { startMetricsServer } from './metrics-server.ts'
import { createLlm, loadLlmConfig } from './llm.ts'
import { runAgent } from './loop.ts'
import { createToolExecutor } from './tools.ts'
import { loadAgentConfig } from './wallet.ts'

// Optional Prometheus export: only active with AGENT_METRICS_PORT *and*
// METRICS_TOKEN (≥ 16 chars). Without a token, nothing is exposed.
const metricsPort = Number(process.env['AGENT_METRICS_PORT'] ?? 0)
const metricsToken = process.env['METRICS_TOKEN'] ?? ''
const question = process.argv.slice(2).join(' ').trim()
if (!question) {
  console.error('Usage: npm run agent -- "your question"')
  process.exit(2)
}

// With no key configured, we make up an ephemeral account: the full loop
// remains demonstrable (the budget refusal, the model's conclusion), but no
// payment can succeed for lack of funds.
let ephemeral = false
if (!process.env['AGENT_PRIVATE_KEY']) {
  process.env['AGENT_PRIVATE_KEY'] = generatePrivateKey()
  ephemeral = true
}

const agent = loadAgentConfig()
const llmConfig = loadLlmConfig()
const guard = new BudgetGuard(agent.limits)
const { mppx } = createPayingClient({ account: agent.account, guard })

const execute = createToolExecutor({
  guard,
  search: async (query) => {
    const url = new URL('/v1/search', agent.providerUrl)
    url.searchParams.set('q', query)
    const response = await mppx.fetch(url.toString())
    if (!response.ok) throw new Error(`provider ${response.status}`)
    return await response.json()
  },
})

const metricsServer =
  metricsPort > 0 && metricsToken.length >= 16
    ? await (async () => {
        const metrics = createMetrics()
        metrics.attachAgent(guard)
        return startMetricsServer(metrics, { port: metricsPort, token: metricsToken })
      })()
    : undefined

console.log(`model    : ${llmConfig.model} (${llmConfig.baseUrl})`)
console.log(`payer    : ${agent.account.address}${ephemeral ? '  ⚠️ ephemeral, unfunded' : ''}`)
console.log(
  `budget   : ${fromBaseUnits(agent.limits.maxPerCall, 6)} / call, ` +
    `${fromBaseUnits(agent.limits.totalBudget, 6)} total`,
)
console.log(`question : ${question}\n`)

const run = await runAgent({
  llm: createLlm(llmConfig),
  execute,
  prompt: question,
})

for (const step of run.steps) {
  const verdict = step.result.ok ? '✓ paid' : `✗ ${step.result.code}`
  console.log(`tool     : ${step.call.name}(${step.call.arguments}) → ${verdict}`)
}

console.log(`\nanswer   : ${run.answer ?? '(the model did not conclude)'}`)
console.log(`stopped  : ${run.stopReason} after ${run.turns} turn(s)`)
console.log(`spent    : ${guard.snapshot().committed} / remaining ${guard.snapshot().remaining}`)

// Let Prometheus scrape the final state before exiting.
if (metricsServer) {
  const linger = Number(process.env['AGENT_METRICS_LINGER'] ?? 30)
  console.log(`metrics  : :${metricsServer.port}/metrics kept up for ${linger}s`)
  await new Promise((r) => setTimeout(r, linger * 1000))
  await metricsServer.close()
}
