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
  /** Fichier du ledger. `:memory:` pour une base éphémère (tests, démo). */
  readonly ledgerPath: string
  /** Support du store anti-rejeu. */
  readonly replayStore: ReplayStoreKind
  /** Fichier du store anti-rejeu SQLite. */
  readonly replayStorePath: string
  /** URL Redis, requise quand `replayStore === 'redis'`. */
  readonly redisUrl: string | undefined
  /** Prix d'un appel à /v1/analyze (route POST, corps lié par digest). */
  readonly analyzePrice: string
  /** Jeton bearer de `/metrics`. Absent : l'export est désactivé. */
  readonly metricsToken?: string | undefined
}

export const REPLAY_STORES = ['memory', 'sqlite', 'redis'] as const
export type ReplayStoreKind = (typeof REPLAY_STORES)[number]

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

  const metricsToken = env['METRICS_TOKEN'] || undefined
  if (metricsToken !== undefined && metricsToken.length < 16)
    throw new ConfigError('METRICS_TOKEN doit faire au moins 16 caractères.')

  const analyzePrice = env['MPP_ANALYZE_PRICE'] ?? '1.00'
  if (!AMOUNT_RE.test(analyzePrice))
    throw new ConfigError(`MPP_ANALYZE_PRICE invalide : "${analyzePrice}".`)

  const replayStore = (env['REPLAY_STORE'] ?? 'sqlite') as ReplayStoreKind
  if (!REPLAY_STORES.includes(replayStore))
    throw new ConfigError(
      `REPLAY_STORE="${replayStore}" inconnu. Valeurs : ${REPLAY_STORES.join(', ')}.`,
    )
  const redisUrl = env['REDIS_URL']
  if (replayStore === 'redis' && !redisUrl)
    throw new ConfigError('REPLAY_STORE=redis exige REDIS_URL.')

  // Le store mémoire est le défaut de mppx, et il a deux angles morts :
  // il n'est pas partagé entre processus, et il est perdu au redémarrage —
  // un Credential redevient alors rejouable. On l'autorise, mais jamais
  // par accident. Voir docs/features/anti-rejeu.md.
  if (replayStore === 'memory' && env['REPLAY_STORE_MEMORY_ACK'] !== 'i-know')
    throw new ConfigError(
      'REPLAY_STORE=memory n’est pas partagé entre processus et ne survit pas ' +
        'à un redémarrage : un Credential y redevient rejouable. ' +
        'Utilisez sqlite ou redis, ou posez REPLAY_STORE_MEMORY_ACK=i-know.',
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
    ledgerPath: env['LEDGER_PATH'] ?? 'data/ledger.sqlite',
    replayStore,
    replayStorePath: env['REPLAY_STORE_PATH'] ?? 'data/replay.sqlite',
    redisUrl,
    analyzePrice,
    metricsToken,
  }
}
