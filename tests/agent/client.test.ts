import { Challenge } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { toBaseUnits } from '../../agent/amount.ts'
import { BudgetDenied, BudgetGuard, type BudgetLimits } from '../../agent/budget.ts'
import { createChallengeHandler, createPayingClient, isBudgetDenied } from '../../agent/client.ts'
import { createApp } from '../../server/app.ts'
import { PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'
import { TEST_CONFIG } from '../helpers.ts'

const LIMITS: BudgetLimits = {
  maxPerCall: toBaseUnits('1.00', 6),
  totalBudget: toBaseUnits('2.50', 6),
  chainId: TESTNET_CHAIN_ID,
  currency: PATH_USD,
  decimals: 6,
}

const challenge = (amount = '500000', id = 'c1') =>
  Challenge.from({
    id,
    realm: 'api.test',
    method: 'tempo',
    intent: 'charge',
    request: {
      amount,
      currency: PATH_USD,
      recipient: TEST_CONFIG.recipient,
      methodDetails: { chainId: TESTNET_CHAIN_ID },
    },
  }) as never

describe('createChallengeHandler', () => {
  it('autorise et renvoie le Credential produit par le SDK', async () => {
    const guard = new BudgetGuard(LIMITS)
    const createCredential = vi.fn(async () => 'Payment eyJ...')
    const handler = createChallengeHandler(guard)

    await expect(handler(challenge(), { createCredential })).resolves.toBe('Payment eyJ...')
    expect(createCredential).toHaveBeenCalledOnce()
    expect(guard.reserved).toBe(500000n)
  })

  it('refuse sans jamais demander de signature', async () => {
    const guard = new BudgetGuard(LIMITS)
    const createCredential = vi.fn(async () => 'Payment eyJ...')
    const handler = createChallengeHandler(guard)

    await expect(handler(challenge('1000001'), { createCredential })).rejects.toBeInstanceOf(
      BudgetDenied,
    )
    // Le point clé : aucune signature n'a été demandée.
    expect(createCredential).not.toHaveBeenCalled()
    expect(guard.reserved).toBe(0n)
  })

  it('rend l’engagement si la création du Credential échoue', async () => {
    const guard = new BudgetGuard(LIMITS)
    const boom = new Error('solde insuffisant')
    const handler = createChallengeHandler(guard)

    await expect(
      handler(challenge(), {
        createCredential: async () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)
    expect(guard.reserved).toBe(0n)
    expect(guard.remaining).toBe(LIMITS.totalBudget)
  })
})

describe('createPayingClient', () => {
  const account = privateKeyToAccount(generatePrivateKey()) // jamais financé

  it('ne patche pas globalThis.fetch (polyfill: false)', () => {
    const before = globalThis.fetch
    createPayingClient({ account, guard: new BudgetGuard(LIMITS) })
    expect(globalThis.fetch).toBe(before)
  })

  it('propage le refus du guard hors de mppx.fetch', async () => {
    const app = createApp(TEST_CONFIG)
    // Enveloppe de 0,10 : le prix du provider (0,50) est hors budget.
    const guard = new BudgetGuard({
      ...LIMITS,
      maxPerCall: toBaseUnits('0.10', 6),
      totalBudget: toBaseUnits('0.10', 6),
    })
    const { mppx } = createPayingClient({
      account,
      guard,
      fetch: async (input, init) => app.fetch(new Request(input as string, init)),
    })

    const error = await mppx.fetch('http://api.test/v1/search?q=mpp').catch((e: unknown) => e)
    expect(isBudgetDenied(error)).toBe(true)
    expect((error as BudgetDenied).code).toBe('per-call-cap')
    expect(guard.reserved).toBe(0n)
    expect(guard.committed).toBe(0n)
  })

  it('ne rejoue pas la requête quand le guard refuse', async () => {
    const app = createApp(TEST_CONFIG)
    const guard = new BudgetGuard({
      ...LIMITS,
      maxPerCall: toBaseUnits('0.10', 6),
      totalBudget: toBaseUnits('0.10', 6),
    })
    let calls = 0
    const { mppx } = createPayingClient({
      account,
      guard,
      fetch: async (input, init) => {
        calls += 1
        return app.fetch(new Request(input as string, init))
      },
    })

    await mppx.fetch('http://api.test/v1/search?q=mpp').catch(() => undefined)
    // Une seule requête : celle qui a reçu le 402. Aucune tentative payante.
    expect(calls).toBe(1)
  })

  it('voit le Challenge réellement émis par le provider', async () => {
    const app = createApp(TEST_CONFIG)
    const guard = new BudgetGuard(LIMITS)
    const seen: unknown[] = []
    const spy = vi.spyOn(guard, 'authorize').mockImplementation((c) => {
      seen.push(c)
      throw new BudgetDenied('per-call-cap', 'refus de test')
    })
    const { mppx } = createPayingClient({
      account,
      guard,
      fetch: async (input, init) => app.fetch(new Request(input as string, init)),
    })

    await mppx.fetch('http://api.test/v1/search?q=mpp').catch(() => undefined)

    expect(spy).toHaveBeenCalledOnce()
    const received = seen[0] as { method: string; intent: string; request: Record<string, unknown> }
    expect(received.method).toBe('tempo')
    expect(received.intent).toBe('charge')
    expect(received.request['amount']).toBe('500000')
    expect((received.request['methodDetails'] as { chainId: number }).chainId).toBe(
      TESTNET_CHAIN_ID,
    )
  })
})
