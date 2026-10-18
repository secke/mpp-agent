import { describe, expect, it, vi } from 'vitest'

import type { AssistantTurn, LlmClient, LlmMessage, ToolSpec } from '../../agent/llm.ts'
import { runAgent } from '../../agent/loop.ts'
import { SEARCH_TOOL, type ToolResult } from '../../agent/tools.ts'

/** Scripted model: returns the turns in order, with no network. */
function scriptedLlm(turns: AssistantTurn[]) {
  const seen: { messages: readonly LlmMessage[]; tools: readonly ToolSpec[] }[] = []
  let index = 0
  const llm: LlmClient = {
    async turn(messages, tools) {
      seen.push({ messages: [...messages], tools: [...tools] })
      const next = turns[index++]
      if (!next) throw new Error('the model was called more times than expected')
      return next
    },
  }
  return { llm, seen }
}

const says = (content: string): AssistantTurn => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
})

const calls = (query: string, id = 'call_1'): AssistantTurn => ({
  content: null,
  toolCalls: [{ id, name: SEARCH_TOOL.name, arguments: JSON.stringify({ query }) }],
  finishReason: 'tool_calls',
})

const ok: ToolResult = { ok: true, data: { results: ['r'] } }
const denied: ToolResult = {
  ok: false,
  code: 'budget-exhausted',
  message: 'nothing left',
  hint: 'abandonne',
  retryable: false,
}

describe('runAgent', () => {
  it('returns the answer directly when the model calls no tool', async () => {
    const { llm } = scriptedLlm([says('42')])
    const run = await runAgent({ llm, execute: vi.fn(), prompt: 'question' })

    expect(run).toMatchObject({ answer: '42', turns: 1, stopReason: 'completed' })
    expect(run.steps).toHaveLength(0)
  })

  it('runs the tool then lets the model conclude', async () => {
    const { llm } = scriptedLlm([calls('mpp'), says('here is the answer')])
    const execute = vi.fn(async () => ok)
    const run = await runAgent({ llm, execute, prompt: 'question' })

    expect(execute).toHaveBeenCalledOnce()
    expect(run).toMatchObject({ answer: 'here is the answer', turns: 2, stopReason: 'completed' })
    expect(run.steps).toHaveLength(1)
  })

  it('feeds the tool result back to the model as a `tool` message', async () => {
    const { llm, seen } = scriptedLlm([calls('mpp'), says('fini')])
    await runAgent({ llm, execute: async () => ok, prompt: 'question' })

    const second = seen[1]!.messages
    const toolMessage = second.find((m) => m.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(JSON.parse((toolMessage as { content: string }).content)).toMatchObject({ ok: true })
  })

  it('disables the tool after a terminal refusal, so the model concludes', async () => {
    const { llm, seen } = scriptedLlm([calls('mpp'), says('I stop here')])
    const run = await runAgent({ llm, execute: async () => denied, prompt: 'question' })

    // First turn: the tool is offered. Second turn: no tool.
    expect(seen[0]!.tools).toHaveLength(1)
    expect(seen[1]!.tools).toHaveLength(0)
    expect(run.stopReason).toBe('completed')
  })

  it('a budget refusal does not throw: the loop continues', async () => {
    const { llm } = scriptedLlm([calls('mpp'), says('without a purchase, here is what I know')])
    await expect(
      runAgent({ llm, execute: async () => denied, prompt: 'question' }),
    ).resolves.toMatchObject({ answer: 'without a purchase, here is what I know' })
  })

  it('bounds the number of purchases', async () => {
    const { llm } = scriptedLlm([
      calls('a', 'c1'),
      calls('b', 'c2'),
      calls('c', 'c3'),
      calls('d', 'c4'),
    ])
    const run = await runAgent({
      llm,
      execute: async () => ok,
      prompt: 'question',
      maxToolCalls: 2,
    })

    expect(run.steps).toHaveLength(2)
    expect(run.stopReason).toBe('max-tool-calls')
  })

  it('bounds the number of turns', async () => {
    const { llm } = scriptedLlm([calls('a', 'c1'), calls('b', 'c2'), calls('c', 'c3')])
    const run = await runAgent({
      llm,
      execute: async () => ok,
      prompt: 'question',
      maxTurns: 3,
      maxToolCalls: 10,
    })

    expect(run.stopReason).toBe('max-turns')
    expect(run.answer).toBeNull()
    expect(run.turns).toBe(3)
  })

  it('opens the conversation with the system prompt then the question', async () => {
    const { llm, seen } = scriptedLlm([says('ok')])
    await runAgent({ llm, execute: vi.fn(), prompt: 'ma question' })

    expect(seen[0]!.messages[0]).toMatchObject({ role: 'system' })
    expect(seen[0]!.messages[1]).toMatchObject({ role: 'user', content: 'ma question' })
  })

  it('warns the model that the tool costs money', async () => {
    const { llm, seen } = scriptedLlm([says('ok')])
    await runAgent({ llm, execute: vi.fn(), prompt: 'q' })
    expect((seen[0]!.messages[0] as { content: string }).content).toMatch(/paid/i)
  })
})

describe('model context isolation', () => {
  it('no private key or Credential reaches the model', async () => {
    const SECRET_KEY = `0x${'a'.repeat(64)}`
    const CREDENTIAL = 'Payment eyJjaGFsbGVuZ2Ui'
    const { llm, seen } = scriptedLlm([calls('mpp'), says('fini')])

    await runAgent({
      llm,
      // The executor only returns purchased data.
      execute: async () => ({ ok: true, data: { results: ['paid content'], spent: '0.5' } }),
      prompt: 'question',
    })

    const transmitted = JSON.stringify(seen)
    expect(transmitted).not.toContain(SECRET_KEY)
    expect(transmitted).not.toContain(CREDENTIAL)
    expect(transmitted).not.toMatch(/0x[0-9a-fA-F]{64}/)
    expect(transmitted).not.toMatch(/Authorization/i)
  })
})
