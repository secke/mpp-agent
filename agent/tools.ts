/**
 * Tools exposed to the model.
 *
 * Two invariants:
 *  1. **The model proposes, the budget guard disposes.** A guard refusal comes
 *     back to the model as a structured `tool_result` — not an exception. The
 *     model must be able to take it into account (give up, rephrase, stop),
 *     which an exception breaking the loop does not allow.
 *  2. **Nothing sensitive reaches the model.** No private key, no Credential,
 *     no raw Receipt. The result only contains the purchased data and the
 *     amount actually spent.
 */
import { fromBaseUnits } from './amount.ts'
import { BudgetDenied, type BudgetGuard } from './budget.ts'
import type { ToolCall, ToolSpec } from './llm.ts'

export const SEARCH_TOOL: ToolSpec = {
  name: 'search_marketplace',
  description:
    'Runs a document search on the marketplace. This call is PAID: ' +
    "it triggers a stablecoin payment from the agent's budget. " +
    'Only call this tool if the question really requires it, and only once per topic.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query, in natural language.',
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
      /** Stable code, so the model can tell "retry" from "give up". */
      readonly code: string
      readonly message: string
      /** What the model is expected to do with this refusal. */
      readonly hint: string
      readonly retryable: boolean
    }

/** Injected paid search function (the agent's `mppx.fetch`). */
export type SearchFn = (query: string) => Promise<unknown>

export type ToolExecutorOptions = {
  readonly search: SearchFn
  readonly guard: BudgetGuard
}

/** Budget refusals that are pointless to retry. */
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
        message: `Unknown tool: ${call.name}`,
        hint: `Only ${SEARCH_TOOL.name} is available.`,
        retryable: false,
      }

    const args = parseArguments(call)
    const query = typeof args?.query === 'string' ? args.query.trim() : ''
    if (!query)
      return {
        ok: false,
        code: 'invalid-arguments',
        message: 'The `query` parameter is missing or empty.',
        hint: 'Call the tool again with a non-empty `query` string.',
        retryable: true,
      }

    const before = guard.committed
    try {
      const data = await search(query)
      return {
        ok: true,
        data: {
          results: data,
          // The model sees what it spent: it needs this to decide whether to
          // continue. Nothing else about the payment.
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
            ? 'The budget does not allow this purchase. Do not insist: answer with what you already know, and mention the limit.'
            : 'This payment offer was refused by the spending policy. Do not retry it unchanged.',
          retryable: false,
        }

      // Outage (network, signing, provider). We do not disclose the detail to
      // the model: the raw error message may contain payment data.
      return {
        ok: false,
        code: 'search-unavailable',
        message: 'The search failed for a technical reason.',
        hint: 'You may retry once, then answer without this tool.',
        retryable: true,
      }
    }
  }
}
