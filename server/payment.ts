/**
 * MPP payment instance of the provider.
 *
 * Sources:
 * - `Mppx.create` / `tempo.charge`: https://mpp.dev/sdk/typescript/server/Mppx.create
 *   and node_modules/mppx/dist/server/Mppx.d.ts, dist/tempo/server/Charge.d.ts
 * - Hono adapter: https://mpp.dev/sdk/typescript/middlewares/hono
 *
 * ⚠️ INVARIANT: we pass `testnet: true`, never `chainId` alone.
 * Measured in phase 0 (docs/NOTES.md §4.1): `tempo.charge({ chainId: 42431 })`
 * issues a Challenge advertising chainId 4217 (mainnet) with a testnet
 * currency — an inconsistent configuration. Only `testnet: true` aligns both.
 */
import { Challenge, type Store } from 'mppx'
import { Mppx, tempo } from 'mppx/hono'

import { PATH_USD, TESTNET_CHAIN_ID, TOKEN_DECIMALS, type Config } from './config.ts'

export type Payment = ReturnType<typeof createPayment>

export function createPayment(
  config: Config,
  /**
   * Replay store. If omitted, mppx falls back to an **in-memory** store: not
   * shared between processes and lost on restart (see server/stores.ts).
   * `loadConfig` refuses this default without an explicit acknowledgement.
   */
  store?: Store.AtomicStore | undefined,
) {
  return Mppx.create({
    methods: [
      tempo.charge({
        testnet: true, // ← the only consistent setting (NOTES §4.1)
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
 * Guard #2, at runtime: checks that a Challenge actually issued targets the
 * testnet. Protects against an SDK regression or a wrong option — the cost of
 * a mistake here is real money.
 */
export function assertTestnetChallenge(challenge: Challenge.Challenge): void {
  const request = challenge.request as {
    currency?: string
    methodDetails?: { chainId?: number }
  }
  const chainId = request.methodDetails?.chainId
  if (chainId !== TESTNET_CHAIN_ID)
    throw new MainnetGuardError(
      `Challenge issued on chainId=${chainId}, expected ${TESTNET_CHAIN_ID} (Tempo Moderato). ` +
        `Refusing to serve: risk of a payment on the main network.`,
    )
  if (request.currency?.toLowerCase() !== PATH_USD)
    throw new MainnetGuardError(
      `Challenge issued with currency=${request.currency}, expected pathUSD (${PATH_USD}).`,
    )
}

/**
 * Startup self-test: issues a dummy Challenge and validates it.
 * Called before opening the port, to fail fast rather than in production.
 */
export async function selfCheck(payment: Payment, config: Config): Promise<void> {
  const challenge = await payment.challenge.tempo.charge({ amount: config.searchPrice })
  assertTestnetChallenge(challenge)
}
