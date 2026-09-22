/**
 * Outils exposés au modèle.
 *
 * Deux invariants :
 *  1. **Le modèle propose, le budget guard dispose.** Un refus du guard revient
 *     au modèle sous forme de `tool_result` structuré — pas d'exception. Le
 *     modèle doit pouvoir en tenir compte (abandonner, reformuler, s'arrêter),
 *     ce qu'une exception qui casse la boucle ne permet pas.
 *  2. **Rien de sensible ne remonte au modèle.** Pas de clé privée, pas de
 *     Credential, pas de Receipt brut. Le résultat ne contient que les données
 *     achetées et le montant réellement dépensé.
 */
import { fromBaseUnits } from './amount.ts'
import { BudgetDenied, type BudgetGuard } from './budget.ts'
import type { ToolCall, ToolSpec } from './llm.ts'

export const SEARCH_TOOL: ToolSpec = {
  name: 'search_marketplace',
  description:
    "Effectue une recherche documentaire sur la place de marché. Cet appel est PAYANT : " +
    'il déclenche un paiement en stablecoin depuis le budget de l’agent. ' +
    "N'appelle cet outil que si la question l'exige réellement, et une seule fois par sujet.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'La requête de recherche, en langage naturel.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

export type ToolResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false
      /** Code stable, pour que le modèle distingue « réessaie » de « abandonne ». */
      readonly code: string
      readonly message: string
      /** Ce que le modèle est censé faire de ce refus. */
      readonly hint: string
      readonly retryable: boolean
    }

/** Fonction de recherche payante injectée (le `mppx.fetch` de l'agent). */
export type SearchFn = (query: string) => Promise<unknown>

export type ToolExecutorOptions = {
  readonly search: SearchFn
  readonly guard: BudgetGuard
}

/** Les refus de budget qui ne servent à rien de réessayer. */
const TERMINAL_DENIALS = new Set(['budget-exhausted', 'per-call-cap'])

function parseArguments(call: ToolCall): { query?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    return typeof parsed === 'object' && parsed !== null ? (parsed as { query?: unknown }) : null
  } catch {
    return null
  }
}

export function createToolExecutor({ search, guard }: ToolExecutorOptions) {
  return async function execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== SEARCH_TOOL.name)
      return {
        ok: false,
        code: 'unknown-tool',
        message: `Outil inconnu : ${call.name}`,
        hint: `Seul ${SEARCH_TOOL.name} est disponible.`,
        retryable: false,
      }

    const args = parseArguments(call)
    const query = typeof args?.query === 'string' ? args.query.trim() : ''
    if (!query)
      return {
        ok: false,
        code: 'invalid-arguments',
        message: 'Le paramètre `query` est manquant ou vide.',
        hint: 'Rappelle l’outil avec une chaîne `query` non vide.',
        retryable: true,
      }

    const before = guard.committed
    try {
      const data = await search(query)
      return {
        ok: true,
        data: {
          results: data,
          // Le modèle voit ce qu'il a dépensé : c'est une information dont il
          // a besoin pour décider s'il continue. Rien d'autre du paiement.
          spent: fromBaseUnits(guard.committed - before, guard.limits.decimals),
          budgetRemaining: guard.snapshot().remaining,
        },
      }
    } catch (error) {
      if (error instanceof BudgetDenied)
        return {
          ok: false,
          code: error.code,
          message: error.message,
          hint: TERMINAL_DENIALS.has(error.code)
            ? 'Le budget ne permet pas cet achat. N’insiste pas : réponds avec ce que tu sais déjà, en signalant la limite.'
            : 'Cette offre de paiement a été refusée par la politique de dépense. Ne réessaie pas à l’identique.',
          retryable: false,
        }

      // Panne (réseau, signature, provider). On ne divulgue pas le détail au
      // modèle : le message d'erreur brut peut contenir des données de paiement.
      return {
        ok: false,
        code: 'search-unavailable',
        message: 'La recherche a échoué pour une raison technique.',
        hint: 'Tu peux réessayer une fois, puis répondre sans cet outil.',
        retryable: true,
      }
    }
  }
}
