/**
 * Point d'entrée de démonstration : le modèle décide lui-même s'il achète
 * une recherche sur la place de marché.
 *
 * Lancement : `npm run agent -- "ta question"`
 * (le provider doit tourner : `npm run dev`)
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

// Export Prometheus optionnel : actif seulement avec AGENT_METRICS_PORT *et*
// METRICS_TOKEN (≥ 16 car.). Sans jeton, rien n'est exposé.
const metricsPort = Number(process.env['AGENT_METRICS_PORT'] ?? 0)
const metricsToken = process.env['METRICS_TOKEN'] ?? ''
const question = process.argv.slice(2).join(' ').trim()
if (!question) {
  console.error('Usage : npm run agent -- "ta question"')
  process.exit(2)
}

// Sans clé configurée, on fabrique un compte éphémère : la boucle complète
// reste démontrable (le refus de budget, la conclusion du modèle), mais aucun
// paiement ne peut aboutir faute de fonds.
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

console.log(`modèle    : ${llmConfig.model} (${llmConfig.baseUrl})`)
console.log(`payeur    : ${agent.account.address}${ephemeral ? '  ⚠️ éphémère, non financé' : ''}`)
console.log(
  `budget    : ${fromBaseUnits(agent.limits.maxPerCall, 6)} / appel, ` +
    `${fromBaseUnits(agent.limits.totalBudget, 6)} au total`,
)
console.log(`question  : ${question}\n`)

const run = await runAgent({
  llm: createLlm(llmConfig),
  execute,
  prompt: question,
})

for (const step of run.steps) {
  const verdict = step.result.ok ? '✓ payé' : `✗ ${step.result.code}`
  console.log(`outil     : ${step.call.name}(${step.call.arguments}) → ${verdict}`)
}

console.log(`\nréponse   : ${run.answer ?? '(le modèle n’a pas conclu)'}`)
console.log(`arrêt     : ${run.stopReason} en ${run.turns} tour(s)`)
console.log(`dépense   : ${guard.snapshot().committed} / reste ${guard.snapshot().remaining}`)

// Laisse Prometheus scraper l'état final avant de quitter.
if (metricsServer) {
  const linger = Number(process.env['AGENT_METRICS_LINGER'] ?? 30)
  console.log(`métriques : :${metricsServer.port}/metrics maintenues ${linger}s`)
  await new Promise((r) => setTimeout(r, linger * 1000))
  await metricsServer.close()
}
