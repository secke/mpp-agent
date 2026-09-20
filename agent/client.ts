/**
 * Client HTTP payeur de l'agent.
 *
 * Deux protections empilées :
 *  1. les garde-fous natifs du SDK (`expectedChainId`, `allowedChainIds`,
 *     `expectedRecipients`) — le client refuse de signer hors de ces bornes ;
 *  2. notre budget guard, qui ajoute la dimension que le SDK ignore :
 *     combien on a déjà dépensé.
 *
 * Sources :
 * - `Mppx.create` client : https://mpp.dev/sdk/typescript/client/Mppx.create
 * - options `expectedChainId` / `allowedChainIds` / `expectedRecipients` :
 *   node_modules/mppx/dist/tempo/client/Charge.d.ts
 */
import { Mppx, tempo } from 'mppx/client'
import type { PrivateKeyAccount } from 'viem'

import { BudgetDenied, type BudgetGuard } from './budget.ts'

/**
 * Fabrique le handler de décision, isolé du SDK pour être testable sans
 * réseau ni wallet : `createCredential` est injecté.
 */
export function createChallengeHandler(guard: BudgetGuard) {
  return async (
    challenge: { id: string; method: string; intent: string; request: unknown },
    helpers: { createCredential: () => Promise<string> },
  ): Promise<string> => {
    guard.authorize(challenge as never) // lève BudgetDenied pour refuser
    try {
      return await helpers.createCredential()
    } catch (error) {
      // La signature ou la diffusion a échoué : on rend l'engagement,
      // sinon le budget se vide sans qu'aucun paiement n'ait eu lieu.
      guard.release(challenge.id)
      throw error
    }
  }
}

export type PayingClientOptions = {
  readonly account: PrivateKeyAccount
  readonly guard: BudgetGuard
  /** Injectable pour les tests : par défaut le `fetch` global (non patché). */
  readonly fetch?: typeof globalThis.fetch | undefined
}

export function createPayingClient({ account, guard, fetch }: PayingClientOptions) {
  const { chainId, recipients } = guard.limits

  const mppx = Mppx.create({
    methods: [
      tempo({
        account,
        // Garde-fous SDK : rejette tout Challenge hors de ces bornes,
        // avant même que notre guard ne soit consulté.
        expectedChainId: chainId,
        allowedChainIds: [chainId],
        ...(recipients ? { expectedRecipients: recipients as readonly `0x${string}`[] } : {}),
      }),
    ],

    // ⚠️ INVARIANT : ne jamais patcher globalThis.fetch.
    // Le défaut est `true` ; il rendrait tout fetch du process payant,
    // y compris ceux qui ne passent pas par le guard (NOTES §5.4).
    polyfill: false,
    ...(fetch ? { fetch } : {}),

    /**
     * Point de décision. **Lever est la seule façon de refuser** : renvoyer
     * `undefined` fait retomber mppx sur `createCredential()` et paie
     * (mppx/dist/client/internal/Fetch.js l.153, mesuré en phase 2).
     */
    onChallenge: createChallengeHandler(guard),
  })

  // Le paiement a abouti : l'engagement devient une dépense.
  mppx.onPaymentResponse(({ challenge }) => {
    guard.settle(challenge.id)
  })

  // Échec côté réseau ou serveur : on libère si on sait de quel Challenge il s'agit.
  // `challenge` est optionnel dans ce payload (Fetch.d.ts) — d'où la garde.
  mppx.onPaymentFailed(({ challenge }) => {
    if (challenge) guard.release(challenge.id)
  })

  return { mppx, guard }
}

/** Vrai si l'erreur est un refus du budget guard (et non une panne). */
export function isBudgetDenied(error: unknown): error is BudgetDenied {
  return error instanceof BudgetDenied
}
