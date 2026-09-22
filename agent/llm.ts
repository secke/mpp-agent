/**
 * Accès au modèle, via l'API DeepSeek (format compatible OpenAI).
 *
 * Sources :
 * - base_url et modèles : https://api-docs.deepseek.com/
 *   « The DeepSeek API uses an API format compatible with OpenAI/Anthropic. »
 *   base_url (OpenAI) = https://api.deepseek.com ; modèles `deepseek-flash`,
 *   `deepseek-v4-pro`. Vérifié via GET https://api.deepseek.com/models.
 * - Tool calls : https://api-docs.deepseek.com/guides/tool_calls
 *
 * Le reste de l'agent ne dépend pas du SDK OpenAI : il parle au type
 * `LlmClient` ci-dessous. C'est ce qui permet de tester la boucle sans réseau
 * ni crédit, et de changer de fournisseur sans toucher à la logique.
 */
import OpenAI from 'openai'

export class LlmError extends Error {
  override name = 'LlmError'
}

/** Un outil exposé au modèle. Schéma JSON standard. */
export type ToolSpec = {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export type ToolCall = {
  readonly id: string
  readonly name: string
  /** Arguments bruts, tels que renvoyés par le modèle (JSON non validé). */
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

/** Port minimal vers le modèle. Un mock de test implémente ceci en 5 lignes. */
export type LlmClient = {
  turn(messages: readonly LlmMessage[], tools: readonly ToolSpec[]): Promise<AssistantTurn>
}

export type LlmConfig = {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly maxTokens: number
  /**
   * Mode « thinking » de DeepSeek. Désactivé par défaut ici : il consomme des
   * tokens de raisonnement sans bénéfice pour une boucle d'outils aussi
   * cadrée, et rend les réponses moins déterministes à tester.
   */
  readonly thinking: boolean
  /**
   * Transport injectable. Par défaut celui du SDK OpenAI.
   * Sert aux tests à intercepter la requête sans toucher au réseau.
   */
  readonly fetch?: typeof globalThis.fetch | undefined
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env['DEEPSEEK_API_KEY']
  if (!apiKey) throw new LlmError('DEEPSEEK_API_KEY est requis (voir .env.example)')
  return {
    apiKey,
    baseUrl: env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
    model: env['DEEPSEEK_MODEL'] ?? 'deepseek-flash',
    maxTokens: Number(env['DEEPSEEK_MAX_TOKENS'] ?? '1024'),
    thinking: env['DEEPSEEK_THINKING'] === 'true',
  }
}

/** Traduit nos messages vers le format Chat Completions. */
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
      // `thinking` est une extension DeepSeek absente des types OpenAI :
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

      if (!choice?.message) throw new LlmError('Réponse du modèle sans message exploitable')

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
