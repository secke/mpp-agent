/**
 * Agent loop: the model reasons, calls tools, and concludes.
 *
 * Guardrails of the loop itself (independent of the budget guard):
 *  - `maxTurns` bounds the number of round-trips with the model;
 *  - `maxToolCalls` bounds the total number of purchases attempted;
 *  - a terminal guard refusal disables the tools for the next turn, so the
 *    model concludes instead of looping on an impossible purchase.
 */
import type { AssistantTurn, LlmClient, LlmMessage, ToolSpec } from './llm.ts'
import { SEARCH_TOOL, type ToolResult } from './tools.ts'

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a research agent. You have a paid tool to query a document',
  'marketplace: every call spends real budget.',
  'Use it sparingly, only when the question requires it.',
  'If a call is refused because of budget, do not insist: answer with',
  'what you know and explicitly mention the limit you hit.',
  'Answer in the language of the question.',
].join(' ')

export type AgentStep = {
  readonly call: { id: string; name: string; arguments: string }
  readonly result: ToolResult
}

export type AgentRun = {
  /** Final answer from the model, or `null` if it did not conclude. */
  readonly answer: string | null
  readonly steps: readonly AgentStep[]
  readonly turns: number
  /** Why the loop stopped. */
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

    // The model has concluded.
    if (reply.toolCalls.length === 0)
      return { answer: reply.content, steps, turns: turn, stopReason: 'completed', messages }

    for (const call of reply.toolCalls) {
      if (steps.length >= maxToolCalls)
        return { answer: reply.content, steps, turns: turn, stopReason: 'max-tool-calls', messages }

      const result = await execute(call)
      steps.push({ call, result })

      // A non-retryable refusal disables the tool: without this, the model may
      // re-propose the same purchase until it exhausts `maxTurns` for nothing.
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
