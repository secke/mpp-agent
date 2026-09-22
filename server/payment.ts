/**
 * Instance de paiement MPP du provider.
 *
 * Sources :
 * - `Mppx.create` / `tempo.charge` : https://mpp.dev/sdk/typescript/server/Mppx.create
 *   et node_modules/mppx/dist/server/Mppx.d.ts, dist/tempo/server/Charge.d.ts
 * - Adaptateur Hono : https://mpp.dev/sdk/typescript/middlewares/hono
 *
 * ⚠️ INVARIANT : on passe `testnet: true`, jamais `chainId` seul.
 * Mesuré en phase 0 (docs/NOTES.md §4.1) : `tempo.charge({ chainId: 42431 })`
 * émet un Challenge annonçant chainId 4217 (mainnet) avec une devise testnet —
 * configuration incohérente. Seul `testnet: true` aligne les deux.
 */
import { Challenge, type Store } from 'mppx'
import { Mppx, tempo } from 'mppx/hono'

import { PATH_USD, TESTNET_CHAIN_ID, TOKEN_DECIMALS, type Config } from './config.ts'

export type Payment = ReturnType<typeof createPayment>

export function createPayment(
  config: Config,
  /**
   * Store anti-rejeu. Omis, mppx retombe sur un store **mémoire** : non
   * partagé entre processus et perdu au redémarrage (voir server/stores.ts).
   * `loadConfig` refuse ce défaut sans acquittement explicite.
   */
  store?: Store.AtomicStore | undefined,
) {
  return Mppx.create({
    methods: [
      tempo.charge({
        testnet: true, // ← seul réglage cohérent (NOTES §4.1)
        recipient: config.recipient,
        currency: PATH_USD,
        decimals: TOKEN_DECIMALS,
        ...(store ? { store } : {}),
      }),
    ],
    realm: config.realm,
    secretKey: config.secretKey,
  })
}

export class MainnetGuardError extends Error {
  override name = 'MainnetGuardError'
}

/**
 * Garde-fou n°2, à l'exécution : vérifie qu'un Challenge réellement émis
 * cible bien le testnet. Protège contre une régression du SDK ou une
 * mauvaise option — le coût d'une erreur ici, c'est de l'argent réel.
 */
export function assertTestnetChallenge(challenge: Challenge.Challenge): void {
  const request = challenge.request as {
    currency?: string
    methodDetails?: { chainId?: number }
  }
  const chainId = request.methodDetails?.chainId
  if (chainId !== TESTNET_CHAIN_ID)
    throw new MainnetGuardError(
      `Challenge émis sur chainId=${chainId}, attendu ${TESTNET_CHAIN_ID} (Tempo Moderato). ` +
        `Refus de servir : risque de paiement sur le réseau principal.`,
    )
  if (request.currency?.toLowerCase() !== PATH_USD)
    throw new MainnetGuardError(
      `Challenge émis avec currency=${request.currency}, attendu pathUSD (${PATH_USD}).`,
    )
}

/**
 * Auto-test de démarrage : émet un Challenge pour de faux et le valide.
 * Appelé avant d'ouvrir le port, pour échouer vite plutôt qu'en production.
 */
export async function selfCheck(payment: Payment, config: Config): Promise<void> {
  const challenge = await payment.challenge.tempo.charge({ amount: config.searchPrice })
  assertTestnetChallenge(challenge)
}
