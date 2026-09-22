/**
 * Boucle d'agent : le modèle raisonne, appelle des outils, et conclut.
 *
 * Garde-fous de la boucle elle-même (indépendants du budget guard) :
 *  - `maxTurns` borne le nombre d'aller-retours avec le modèle ;
 *  - `maxToolCalls` borne le nombre total d'achats tentés ;
 *  - un refus terminal du guard coupe les outils pour le tour suivant, afin
 *    que le modèle conclue au lieu de boucler sur un achat impossible.
 */
import type { AssistantTurn, LlmClient, LlmMessage, ToolSpec } from './llm.ts'
import { SEARCH_TOOL, type ToolResult } from './tools.ts'

export const DEFAULT_SYSTEM_PROMPT = [
  'Tu es un agent de recherche. Tu disposes d’un outil payant pour interroger',
  'une place de marché documentaire : chaque appel dépense du budget réel.',
  'Utilise-le avec parcimonie, uniquement quand la question l’exige.',
  'Si un appel est refusé pour cause de budget, n’insiste pas : réponds avec',
  'ce que tu sais et signale explicitement la limite rencontrée.',
].join(' ')

export type AgentStep = {
  readonly call: { id: string; name: string; arguments: string }
  readonly result: ToolResult
}

export type AgentRun = {
  /** Réponse finale du modèle, ou `null` s'il n'a pas conclu. */
  readonly answer: string | null
  readonly steps: readonly AgentStep[]
  readonly turns: number
  /** Pourquoi la boucle s'est arrêtée. */
  readonly stopReason: 'completed' | 'max-turns' | 'max-tool-calls'
  readonly messages: readonly LlmMessage[]
}

export type RunAgentOptions = {
  readonly llm: LlmClient
  readonly execute: (call: AgentStep['call']) => Promise<ToolResult>
  readonly prompt: string
  readonly systemPrompt?: string | undefined
  readonly tools?: readonly ToolSpec[] | undefined
  readonly maxTurns?: number | undefined
  readonly maxToolCalls?: number | undefined
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRun> {
  const {
    llm,
    execute,
    prompt,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    tools = [SEARCH_TOOL],
    maxTurns = 6,
    maxToolCalls = 4,
  } = options

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]
  const steps: AgentStep[] = []
  let toolsDisabled = false

  for (let turn = 1; turn <= maxTurns; turn++) {
    const available = toolsDisabled ? [] : tools
    const reply: AssistantTurn = await llm.turn(messages, available)

    messages.push({
      role: 'assistant',
      content: reply.content,
      ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}),
    })

    // Le modèle a conclu.
    if (reply.toolCalls.length === 0)
      return { answer: reply.content, steps, turns: turn, stopReason: 'completed', messages }

    for (const call of reply.toolCalls) {
      if (steps.length >= maxToolCalls)
        return { answer: reply.content, steps, turns: turn, stopReason: 'max-tool-calls', messages }

      const result = await execute(call)
      steps.push({ call, result })

      // Un refus non réessayable coupe l'outil : sans ça, le modèle peut
      // reproposer le même achat jusqu'à épuiser `maxTurns` pour rien.
      if (!result.ok && !result.retryable) toolsDisabled = true

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(result),
      })
    }
  }

  return { answer: null, steps, turns: maxTurns, stopReason: 'max-turns', messages }
}
