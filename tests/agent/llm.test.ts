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

/** Captures the body sent and returns a canned Chat Completions response. */
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
  it('applies the documented defaults', () => {
    const config = loadLlmConfig({ DEEPSEEK_API_KEY: 'sk-x' } as NodeJS.ProcessEnv)
    // Source: https://api-docs.deepseek.com/ (OpenAI base_url, models).
    expect(config.baseUrl).toBe('https://api.deepseek.com')
    expect(config.model).toBe('deepseek-flash')
    expect(config.thinking).toBe(false)
  })

  it('requires a key', () => {
    expect(() => loadLlmConfig({} as NodeJS.ProcessEnv)).toThrow(LlmError)
  })
})

describe('createLlm — traduction vers Chat Completions', () => {
  it('sends the model, the token bound and the thinking mode', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'ok' }))
    const llm = createLlm({ ...CONFIG, fetch })
    await llm.turn([{ role: 'user', content: 'salut' }], [])

    expect(sent[0]).toMatchObject({
      model: 'deepseek-flash',
      max_tokens: 256,
      thinking: { type: 'disabled' },
    })
  })

  it('enables thinking when requested', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'ok' }))
    const llm = createLlm({ ...CONFIG, thinking: true, fetch })
    await llm.turn([{ role: 'user', content: 'salut' }], [])
    expect(sent[0]).toMatchObject({ thinking: { type: 'enabled' } })
  })

  it('translates tools to the function calling format', async () => {
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

  it('sends no `tools` field when there are none', async () => {
    const { sent, fetch } = intercept(reply({ role: 'assistant', content: 'ok' }))
    const llm = createLlm({ ...CONFIG, fetch })
    await llm.turn([{ role: 'user', content: 'salut' }], [])
    expect(sent[0]).not.toHaveProperty('tools')
  })

  it('translates an assistant turn with tool calls and the tool message', async () => {
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

describe('createLlm — reading the response', () => {
  it('extracts the tool calls', async () => {
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

  it('normalizes absent content to null', async () => {
    const { fetch } = intercept(reply({ role: 'assistant' }))
    const llm = createLlm({ ...CONFIG, fetch })
    const turn = await llm.turn([{ role: 'user', content: 'q' }], [])
    expect(turn).toMatchObject({ content: null, toolCalls: [] })
  })

  it('throws on an unusable response', async () => {
    const { fetch } = intercept({ id: 'x', choices: [] })
    const llm = createLlm({ ...CONFIG, fetch })
    await expect(llm.turn([{ role: 'user', content: 'q' }], [])).rejects.toBeInstanceOf(LlmError)
  })
})
