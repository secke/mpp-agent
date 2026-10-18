/**
 * Model access, via the DeepSeek API (OpenAI-compatible format).
 *
 * Sources:
 * - base_url and models: https://api-docs.deepseek.com/
 *   "The DeepSeek API uses an API format compatible with OpenAI/Anthropic."
 *   base_url (OpenAI) = https://api.deepseek.com; models `deepseek-flash`,
 *   `deepseek-v4-pro`. Verified via GET https://api.deepseek.com/models.
 * - Tool calls : https://api-docs.deepseek.com/guides/tool_calls
 *
 * The rest of the agent does not depend on the OpenAI SDK: it talks to the
 * `LlmClient` type below. This is what makes it possible to test the loop
 * without a network or credit, and to switch provider without touching the logic.
 */
import OpenAI from 'openai'

export class LlmError extends Error {
  override name = 'LlmError'
}

/** A tool exposed to the model. Standard JSON schema. */
export type ToolSpec = {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export type ToolCall = {
  readonly id: string
  readonly name: string
  /** Raw arguments, as returned by the model (unvalidated JSON). */
  readonly arguments: string
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: readonly ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export type AssistantTurn = {
  readonly content: string | null
  readonly toolCalls: readonly ToolCall[]
  readonly finishReason: string
}

/** Minimal port to the model. A test mock implements this in 5 lines. */
export type LlmClient = {
  turn(messages: readonly LlmMessage[], tools: readonly ToolSpec[]): Promise<AssistantTurn>
}

export type LlmConfig = {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly maxTokens: number
  /**
   * DeepSeek "thinking" mode. Disabled by default here: it burns reasoning
   * tokens with no benefit for such a tightly framed tool loop, and makes
   * responses less deterministic to test.
   */
  readonly thinking: boolean
  /**
   * Injectable transport. Defaults to the OpenAI SDK's own.
   * Lets tests intercept the request without touching the network.
   */
  readonly fetch?: typeof globalThis.fetch | undefined
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env['DEEPSEEK_API_KEY']
  if (!apiKey) throw new LlmError('DEEPSEEK_API_KEY is required (see .env.example)')
  return {
    apiKey,
    baseUrl: env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
    model: env['DEEPSEEK_MODEL'] ?? 'deepseek-flash',
    maxTokens: Number(env['DEEPSEEK_MAX_TOKENS'] ?? '1024'),
    thinking: env['DEEPSEEK_THINKING'] === 'true',
  }
}

/** Translates our messages to the Chat Completions format. */
function toApiMessages(messages: readonly LlmMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        }
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
      default:
        return { role: message.role, content: message.content }
    }
  })
}

export function createLlm(config: LlmConfig): LlmClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  })

  return {
    async turn(messages, tools) {
      // `thinking` is a DeepSeek extension absent from the OpenAI types:
      // https://api-docs.deepseek.com/guides/thinking_mode
      const params = {
        model: config.model,
        max_tokens: config.maxTokens,
        thinking: { type: config.thinking ? 'enabled' : 'disabled' },
        messages: toApiMessages(messages),
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      }

      const response = await client.chat.completions.create(params as never)
      const choice = (response as { choices?: unknown[] }).choices?.[0] as
        | {
            message?: {
              content?: string | null
              tool_calls?: { id: string; function: { name: string; arguments: string } }[]
            }
            finish_reason?: string
          }
        | undefined

      if (!choice?.message) throw new LlmError('Model response without a usable message')

      return {
        content: choice.message.content ?? null,
        toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
        finishReason: choice.finish_reason ?? 'stop',
      }
    },
  }
}
