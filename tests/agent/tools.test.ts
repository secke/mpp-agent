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
  it('returns the results and the committed spend', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async (q) => [{ title: `result ${q}` }],
    })

    const result = await execute(call('{"query":"mpp"}'))
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      data: { results: [{ title: 'result mpp' }], spent: '0', budgetRemaining: '2.5' },
    })
  })

  it('reports the actual spend to the model', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async () => {
        // Simulates a payment completed during the call.
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

  it('turns a budget refusal into a tool_result, not an exception', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async () => {
        throw new BudgetDenied('budget-exhausted', 'nothing left')
      },
    })

    const result = await execute(call('{"query":"mpp"}'))
    expect(result).toMatchObject({ ok: false, code: 'budget-exhausted', retryable: false })
    expect((result as { hint: string }).hint).toMatch(/Do not insist/)
  })

  it('tells a terminal refusal from a one-off refusal', async () => {
    const guard = new BudgetGuard(LIMITS)
    const mk = (code: DenyCode) =>
      createToolExecutor({
        guard,
        search: async () => {
          throw new BudgetDenied(code, 'refusal')
        },
      })

    expect(await mk('budget-exhausted')(call('{"query":"a"}'))).toMatchObject({
      hint: expect.stringMatching(/Do not insist/),
    })
    expect(await mk('unexpected-currency')(call('{"query":"a"}'))).toMatchObject({
      hint: expect.stringMatching(/Do not retry it unchanged/),
    })
  })

  it('never discloses the detail of an outage to the model', async () => {
    const guard = new BudgetGuard(LIMITS)
    const execute = createToolExecutor({
      guard,
      search: async () => {
        throw new Error('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef leak')
      },
    })

    const result = await execute(call('{"query":"mpp"}'))
    expect(result).toMatchObject({ ok: false, code: 'search-unavailable', retryable: true })
    expect(JSON.stringify(result)).not.toContain('0xdeadbeef')
    expect(JSON.stringify(result)).not.toContain('leak')
  })

  it('refuses invalid arguments without calling the search', async () => {
    const search = vi.fn()
    const execute = createToolExecutor({ guard: new BudgetGuard(LIMITS), search })

    for (const bad of ['{}', 'not json', '{"query":"   "}', '{"query":42}', 'null']) {
      const result = await execute(call(bad))
      expect(result, bad).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(search).not.toHaveBeenCalled()
  })

  it('refuses an unknown tool', async () => {
    const search = vi.fn()
    const execute = createToolExecutor({ guard: new BudgetGuard(LIMITS), search })
    const result = await execute(call('{"query":"mpp"}', 'rm_rf'))
    expect(result).toMatchObject({ ok: false, code: 'unknown-tool', retryable: false })
    expect(search).not.toHaveBeenCalled()
  })
})

describe('SEARCH_TOOL', () => {
  it('tells the model the call is paid', () => {
    expect(SEARCH_TOOL.description).toMatch(/PAID/)
  })

  it('exposes a strict schema', () => {
    expect(SEARCH_TOOL.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    })
  })
})
