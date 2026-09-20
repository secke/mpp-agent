/**
 * Configuration du provider MPP, avec garde-fou réseau.
 *
 * Sources :
 * - Constantes réseau : node_modules/mppx/dist/tempo/internal/defaults.js
 *   (chainId.testnet = 42431, tokens.pathUsd, rpcUrl[42431])
 * - Contrainte secretKey >= 32 octets : node_modules/mppx/dist/server/Mppx.d.ts
 *   (« Must be at least 32 bytes »), vérifiée à l'exécution en phase 0.
 * - Voir docs/NOTES.md §4.
 */

/** Tempo Moderato. Le défaut du SDK est le MAINNET : on ne s'y fie jamais. */
export const TESTNET_CHAIN_ID = 42431 as const
/** pathUSD, devise par défaut du testnet. 6 décimales (TIP-20). */
export const PATH_USD = '0x20c0000000000000000000000000000000000000' as const
export const TESTNET_RPC_URL = 'https://rpc.moderato.tempo.xyz' as const
export const TOKEN_DECIMALS = 6 as const

/** Longueur minimale du secret HMAC, imposée par mppx. */
const MIN_SECRET_BYTES = 32

export type Config = {
  readonly realm: string
  readonly secretKey: string
  readonly recipient: `0x${string}`
  readonly port: number
  /** Prix d'un appel à /v1/search, en unités lisibles (ex. « 0.50 »). */
  readonly searchPrice: string
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new ConfigError(`${key} est requis (voir .env.example)`)
  return value
}

/** Montant lisible : chiffres, point décimal, rien d'autre. Pas de notation scientifique. */
const AMOUNT_RE = /^\d+(\.\d{1,6})?$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Garde-fou n°1 : refus explicite de tout réseau autre que le testnet.
  // Le projet est testnet-only (règle CLAUDE.md).
  const network = env['MPP_NETWORK'] ?? 'testnet'
  if (network !== 'testnet')
    throw new ConfigError(
      `MPP_NETWORK="${network}" refusé : ce projet est testnet uniquement. ` +
        `Seule la valeur "testnet" est acceptée.`,
    )

  const secretKey = required(env, 'MPP_SECRET_KEY')
  if (Buffer.byteLength(secretKey, 'utf8') < MIN_SECRET_BYTES)
    throw new ConfigError(
      `MPP_SECRET_KEY fait moins de ${MIN_SECRET_BYTES} octets. ` +
        `Générez-en un avec \`openssl rand -base64 32\`.`,
    )

  const recipient = required(env, 'MPP_RECIPIENT')
  if (!ADDRESS_RE.test(recipient))
    throw new ConfigError(`MPP_RECIPIENT n'est pas une adresse 0x valide : ${recipient}`)

  const searchPrice = env['MPP_SEARCH_PRICE'] ?? '0.50'
  if (!AMOUNT_RE.test(searchPrice))
    throw new ConfigError(
      `MPP_SEARCH_PRICE invalide : "${searchPrice}". ` +
        `Attendu : un montant lisible, max ${TOKEN_DECIMALS} décimales (ex. "0.50").`,
    )

  const portRaw = env['PORT'] ?? '8787'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError(`PORT invalide : "${portRaw}"`)

  return {
    realm: env['MPP_REALM'] ?? 'localhost',
    secretKey,
    recipient: recipient as `0x${string}`,
    port,
    searchPrice,
  }
}
