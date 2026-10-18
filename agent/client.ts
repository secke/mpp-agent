/**
 * The agent's paying HTTP client.
 *
 * Two stacked protections:
 *  1. the SDK's native guardrails (`expectedChainId`, `allowedChainIds`,
 *     `expectedRecipients`) — the client refuses to sign outside these bounds;
 *  2. our budget guard, which adds the dimension the SDK ignores:
 *     how much has already been spent.
 *
 * Sources:
 * - Client `Mppx.create`: https://mpp.dev/sdk/typescript/client/Mppx.create
 * - `expectedChainId` / `allowedChainIds` / `expectedRecipients` options:
 *   node_modules/mppx/dist/tempo/client/Charge.d.ts
 */
import { Mppx, tempo } from 'mppx/client'
import type { PrivateKeyAccount } from 'viem'

import { BudgetDenied, type BudgetGuard } from './budget.ts'

/**
 * Builds the decision handler, isolated from the SDK so it is testable
 * without a network or a wallet: `createCredential` is injected.
 */
export function createChallengeHandler(guard: BudgetGuard) {
  return async (
    challenge: { id: string; method: string; intent: string; request: unknown },
    helpers: { createCredential: () => Promise<string> },
  ): Promise<string> => {
    guard.authorize(challenge as never) // throws BudgetDenied to refuse
    try {
      return await helpers.createCredential()
    } catch (error) {
      // Signing or broadcasting failed: give the commitment back,
      // otherwise the budget drains without any payment having happened.
      guard.release(challenge.id)
      throw error
    }
  }
}

export type PayingClientOptions = {
  readonly account: PrivateKeyAccount
  readonly guard: BudgetGuard
  /** Injectable for tests: defaults to the global `fetch` (unpatched). */
  readonly fetch?: typeof globalThis.fetch | undefined
}

export function createPayingClient({ account, guard, fetch }: PayingClientOptions) {
  const { chainId, recipients } = guard.limits

  const mppx = Mppx.create({
    methods: [
      tempo({
        account,
        // SDK guardrails: reject any Challenge outside these bounds,
        // before our guard is even consulted.
        expectedChainId: chainId,
        allowedChainIds: [chainId],
        ...(recipients ? { expectedRecipients: recipients as readonly `0x${string}`[] } : {}),
      }),
    ],

    // ⚠️ INVARIANT: never patch globalThis.fetch.
    // The default is `true`; it would make every fetch in the process paying,
    // including those that do not go through the guard (NOTES §5.4).
    polyfill: false,
    ...(fetch ? { fetch } : {}),

    /**
     * Decision point. **Throwing is the only way to refuse**: returning
     * `undefined` makes mppx fall back to `createCredential()` and pay
     * (mppx/dist/client/internal/Fetch.js l.153, measured in phase 2).
     */
    onChallenge: createChallengeHandler(guard),
  })

  // The payment completed: the commitment becomes spend.
  mppx.onPaymentResponse(({ challenge }) => {
    guard.settle(challenge.id)
  })

  // Network or server-side failure: release if we know which Challenge it is.
  // `challenge` is optional in this payload (Fetch.d.ts) — hence the guard.
  mppx.onPaymentFailed(({ challenge }) => {
    if (challenge) guard.release(challenge.id)
  })

  return { mppx, guard }
}

/** True if the error is a budget guard refusal (not an outage). */
export function isBudgetDenied(error: unknown): error is BudgetDenied {
  return error instanceof BudgetDenied
}
