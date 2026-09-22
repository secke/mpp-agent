import { describe, expect, it } from 'vitest'

import { createLlm, LlmError, loadLlmConfig, type LlmMessage } from '../../agent/llm.ts'
import { SEARCH_TOOL } from '../../agent/tools.ts'

const CONFIG = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.test',
  model: 'deepseek-flash',
  maxTokens: 256,
  thinking: false,
}

/** Capture le corps envoyé et rend une réponse Chat Completions figée. */
function intercept(response: unknown) {
  const sent: Record<string, unknown>[] = []
  const fetch = (async (_url: string, init: { body?: string }) => {
    sent.push(JSON.parse(init.body ?? '{}'))
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { sent, fetch }
}

const reply = (message: unknown, finish = 'stop') => ({
  id: 'x',
  object: 'chat.completion',
  choices: [{ index: 0, message, finish_reason: finish }],
})

describe('loadLlmConfig', () => {
  it('applique les valeurs par défaut documentées', () => {
    const config = loadLlmConfig({ DEEPSEEK_API_KEY: 'sk-x' } as NodeJS.ProcessEnv)
    // Source : https://api-docs.deepseek.com/ (base_url OpenAI, modèles).
    expect(config.baseUrl).toBe('https://api.deepseek.com')
    expect(config.model).toBe('deepseek-flash')
    expect(config.thinking).toBe(false)
  })

  it('exige une clé', () => {
    expect(() => loadLlmConfig({} as NodeJS.ProcessEnv)).toThrow(LlmError)
  })
})

describe('createLlm — traduction vers Chat Completions', () => {
  it('envoie le modèle, la borne de tokens et le mode thinking', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'ok' }))
    const llm = createLlm({ ...CONFIG, fetch })
    await llm.turn([{ role: 'user', content: 'salut' }], [])

    expect(sent[0]).toMatchObject({
      model: 'deepseek-flash',
      max_tokens: 256,
      thinking: { type: 'disabled' },
    })
  })

  it('active le thinking quand il est demandé', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'ok' }))
    const llm = createLlm({ ...CONFIG, thinking: true, fetch })
    await llm.turn([{ role: 'user', content: 'salut' }], [])
    expect(sent[0]).toMatchObject({ thinking: { type: 'enabled' } })
  })

  it('traduit les outils au format function calling', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'ok' }))
    const llm = createLlm({ ...CONFIG, fetch })
    await llm.turn([{ role: 'user', content: 'salut' }], [SEARCH_TOOL])

    expect(sent[0]!['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: SEARCH_TOOL.name,
          description: SEARCH_TOOL.description,
          parameters: SEARCH_TOOL.parameters,
        },
      },
    ])
  })

  it('n’envoie pas de champ `tools` quand il n’y en a pas', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'ok' }))
    const llm = createLlm({ ...CONFIG, fetch })
    await llm.turn([{ role: 'user', content: 'salut' }], [])
    expect(sent[0]).not.toHaveProperty('tools')
  })

  it('traduit un tour assistant avec appels d’outils et le message tool', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'fini' }))
    const llm = createLlm({ ...CONFIG, fetch })
    const messages: LlmMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'search_marketplace', arguments: '{"query":"mpp"}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ]
    await llm.turn(messages, [])

    const body = sent[0] as { messages: Record<string, unknown>[] }
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'search_marketplace' } },
      ],
    })
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
  })
})

describe('createLlm — lecture de la réponse', () => {
  it('extrait les appels d’outils', async () => {
    const { fetch } = intercept(
      reply(
        {
          role: 'assistant',
          content: 'je cherche',
          tool_calls: [
            {
              id: 'call_00_abc',
              type: 'function',
              function: { name: 'search_marketplace', arguments: '{"query":"mpp"}' },
            },
          ],
        },
        'tool_calls',
      ),
    )
    const llm = createLlm({ ...CONFIG, fetch })
    const turn = await llm.turn([{ role: 'user', content: 'q' }], [SEARCH_TOOL])

    expect(turn.finishReason).toBe('tool_calls')
    expect(turn.toolCalls).toEqual([
      { id: 'call_00_abc', name: 'search_marketplace', arguments: '{"query":"mpp"}' },
    ])
  })

  it('normalise un contenu absent en null', async () => {
    const { fetch } = intercept(reply({ role: 'assistant' }))
    const llm = createLlm({ ...CONFIG, fetch })
    const turn = await llm.turn([{ role: 'user', content: 'q' }], [])
    expect(turn).toMatchObject({ content: null, toolCalls: [] })
  })

  it('lève sur une réponse inexploitable', async () => {
    const { fetch } = intercept({ id: 'x', choices: [] })
    const llm = createLlm({ ...CONFIG, fetch })
    await expect(llm.turn([{ role: 'user', content: 'q' }], [])).rejects.toBeInstanceOf(LlmError)
  })
})
