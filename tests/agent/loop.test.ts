import { describe, expect, it, vi } from 'vitest'

import type { AssistantTurn, LlmClient, LlmMessage, ToolSpec } from '../../agent/llm.ts'
import { runAgent } from '../../agent/loop.ts'
import { SEARCH_TOOL, type ToolResult } from '../../agent/tools.ts'

/** Modèle scripté : rend les tours dans l'ordre, sans réseau. */
function scriptedLlm(turns: AssistantTurn[]) {
  const seen: { messages: readonly LlmMessage[]; tools: readonly ToolSpec[] }[] = []
  let index = 0
  const llm: LlmClient = {
    async turn(messages, tools) {
      seen.push({ messages: [...messages], tools: [...tools] })
      const next = turns[index++]
      if (!next) throw new Error('le modèle a été appelé plus de fois que prévu')
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
  message: 'plus rien',
  hint: 'abandonne',
  retryable: false,
}

describe('runAgent', () => {
  it('rend la réponse directement quand le modèle n’appelle aucun outil', async () => {
    const { llm } = scriptedLlm([says('42')])
    const run = await runAgent({ llm, execute: vi.fn(), prompt: 'question' })

    expect(run).toMatchObject({ answer: '42', turns: 1, stopReason: 'completed' })
    expect(run.steps).toHaveLength(0)
  })

  it('exécute l’outil puis laisse le modèle conclure', async () => {
    const { llm } = scriptedLlm([calls('mpp'), says('voici la réponse')])
    const execute = vi.fn(async () => ok)
    const run = await runAgent({ llm, execute, prompt: 'question' })

    expect(execute).toHaveBeenCalledOnce()
    expect(run).toMatchObject({ answer: 'voici la réponse', turns: 2, stopReason: 'completed' })
    expect(run.steps).toHaveLength(1)
  })

  it('renvoie le résultat de l’outil au modèle comme message `tool`', async () => {
    const { llm, seen } = scriptedLlm([calls('mpp'), says('fini')])
    await runAgent({ llm, execute: async () => ok, prompt: 'question' })

    const second = seen[1]!.messages
    const toolMessage = second.find((m) => m.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(JSON.parse((toolMessage as { content: string }).content)).toMatchObject({ ok: true })
  })

  it('coupe l’outil après un refus terminal, pour que le modèle conclue', async () => {
    const { llm, seen } = scriptedLlm([calls('mpp'), says('je m’arrête là')])
    const run = await runAgent({ llm, execute: async () => denied, prompt: 'question' })

    // Premier tour : l'outil est proposé. Second tour : plus d'outil.
    expect(seen[0]!.tools).toHaveLength(1)
    expect(seen[1]!.tools).toHaveLength(0)
    expect(run.stopReason).toBe('completed')
  })

  it('un refus de budget ne lève pas : la boucle continue', async () => {
    const { llm } = scriptedLlm([calls('mpp'), says('sans achat, voici ce que je sais')])
    await expect(
      runAgent({ llm, execute: async () => denied, prompt: 'question' }),
    ).resolves.toMatchObject({ answer: 'sans achat, voici ce que je sais' })
  })

  it('borne le nombre d’achats', async () => {
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

  it('borne le nombre de tours', async () => {
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

  it('ouvre la conversation avec le prompt système puis la question', async () => {
    const { llm, seen } = scriptedLlm([says('ok')])
    await runAgent({ llm, execute: vi.fn(), prompt: 'ma question' })

    expect(seen[0]!.messages[0]).toMatchObject({ role: 'system' })
    expect(seen[0]!.messages[1]).toMatchObject({ role: 'user', content: 'ma question' })
  })

  it('prévient le modèle que l’outil coûte de l’argent', async () => {
    const { llm, seen } = scriptedLlm([says('ok')])
    await runAgent({ llm, execute: vi.fn(), prompt: 'q' })
    expect((seen[0]!.messages[0] as { content: string }).content).toMatch(/payant/i)
  })
})

describe('étanchéité du contexte modèle', () => {
  it('aucune clé privée ni Credential n’atteint le modèle', async () => {
    const SECRET_KEY = `0x${'a'.repeat(64)}`
    const CREDENTIAL = 'Payment eyJjaGFsbGVuZ2Ui'
    const { llm, seen } = scriptedLlm([calls('mpp'), says('fini')])

    await runAgent({
      llm,
      // L'exécuteur ne renvoie que des données achetées.
      execute: async () => ({ ok: true, data: { results: ['contenu payé'], spent: '0.5' } }),
      prompt: 'question',
    })

    const transmitted = JSON.stringify(seen)
    expect(transmitted).not.toContain(SECRET_KEY)
    expect(transmitted).not.toContain(CREDENTIAL)
    expect(transmitted).not.toMatch(/0x[0-9a-fA-F]{64}/)
    expect(transmitted).not.toMatch(/Authorization/i)
  })
})
