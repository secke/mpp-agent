import { describe, expect, it, vi } from 'vitest'

import { toBaseUnits } from '../../agent/amount.ts'
import {
  BudgetDenied,
  BudgetGuard,
  type BudgetLimits,
  type DenyCode,
} from '../../agent/budget.ts'
import type { ToolCall } from '../../agent/llm.ts'
import { createToolExecutor, SEARCH_TOOL } from '../../agent/tools.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'

const LIMITS: BudgetLimits = {
  maxPerCall: toBaseUnits('1.00', 6),
  totalBudget: toBaseUnits('2.50', 6),
  chainId: TESTNET_CHAIN_ID,
  currency: PATH_USD,
  decimals: 6,
}

const call = (args: string, name = SEARCH_TOOL.name): ToolCall => ({
  id: 'call_1',
  name,
  arguments: args,
})

describe('createToolExecutor', () => {
  it('renvoie les résultats et la dépense engagée', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async (q) => [{ title: `resultat ${q}` }],
    })

    const result = await execute(call('{"query":"mpp"}'))
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      data: { results: [{ title: 'resultat mpp' }], spent: '0', budgetRemaining: '2.5' },
    })
  })

  it('rend compte de la dépense réelle au modèle', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async () => {
        // Simule un paiement abouti pendant l'appel.
        const fake = { id: 'c1' } as never
        guard.authorize({
          id: 'c1',
          method: 'tempo',
          intent: 'charge',
          request: {
            amount: '500000',
            currency: PATH_USD,
            methodDetails: { chainId: TESTNET_CHAIN_ID },
          },
        } as never)
        guard.settle('c1')
        void fake
        return ['ok']
      },
    })

    const result = await execute(call('{"query":"mpp"}'))
    expect(result).toMatchObject({ ok: true, data: { spent: '0.5', budgetRemaining: '2' } })
  })

  it('transforme un refus de budget en tool_result, pas en exception', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async () => {
        throw new BudgetDenied('budget-exhausted', 'plus rien')
      },
    })

    const result = await execute(call('{"query":"mpp"}'))
    expect(result).toMatchObject({ ok: false, code: 'budget-exhausted', retryable: false })
    expect((result as { hint: string }).hint).toMatch(/N’insiste pas/)
  })

  it('distingue un refus terminal d’un refus ponctuel', async () => {
    const guard = new BudgetGuard(LIMITS)
    const mk = (code: DenyCode) =>
      createToolExecutor({
        guard,
        search: async () => {
          throw new BudgetDenied(code, 'refus')
        },
      })

    expect(await mk('budget-exhausted')(call('{"query":"a"}'))).toMatchObject({
      hint: expect.stringMatching(/N’insiste pas/),
    })
    expect(await mk('unexpected-currency')(call('{"query":"a"}'))).toMatchObject({
      hint: expect.stringMatching(/Ne réessaie pas à l’identique/),
    })
  })

  it('ne divulgue jamais le détail d’une panne au modèle', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async () => {
        throw new Error('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef fuite')
      },
    })

    const result = await execute(call('{"query":"mpp"}'))
    expect(result).toMatchObject({ ok: false, code: 'search-unavailable', retryable: true })
    expect(JSON.stringify(result)).not.toContain('0xdeadbeef')
    expect(JSON.stringify(result)).not.toContain('fuite')
  })

  it('refuse des arguments invalides sans appeler la recherche', async () => {
    const search = vi.fn()
    const execute = createToolExecutor({ guard: new BudgetGuard(LIMITS), search })

    for (const bad of ['{}', 'pas du json', '{"query":"   "}', '{"query":42}', 'null']) {
      const result = await execute(call(bad))
      expect(result, bad).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(search).not.toHaveBeenCalled()
  })

  it('refuse un outil inconnu', async () => {
    const search = vi.fn()
    const execute = createToolExecutor({ guard: new BudgetGuard(LIMITS), search })
    const result = await execute(call('{"query":"mpp"}', 'rm_rf'))
    expect(result).toMatchObject({ ok: false, code: 'unknown-tool', retryable: false })
    expect(search).not.toHaveBeenCalled()
  })
})

describe('SEARCH_TOOL', () => {
  it('annonce au modèle que l’appel est payant', () => {
    expect(SEARCH_TOOL.description).toMatch(/PAYANT/)
  })

  it('expose un schéma strict', () => {
    expect(SEARCH_TOOL.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    })
  })
})
