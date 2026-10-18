/**
 * MPP provider configuration, with a network guard.
 *
 * Sources:
 * - Network constants: node_modules/mppx/dist/tempo/internal/defaults.js
 *   (chainId.testnet = 42431, tokens.pathUsd, rpcUrl[42431])
 * - `secretKey >= 32 bytes` constraint: node_modules/mppx/dist/server/Mppx.d.ts
 *   ("Must be at least 32 bytes"), verified at runtime in phase 0.
 * - See docs/NOTES.md §4.
 */

/** Tempo Moderato. The SDK default is MAINNET: we never rely on it. */
export const TESTNET_CHAIN_ID = 42431 as const
/** pathUSD, the testnet default currency. 6 decimals (TIP-20). */
export const PATH_USD = '0x20c0000000000000000000000000000000000000' as const
export const TESTNET_RPC_URL = 'https://rpc.moderato.tempo.xyz' as const
export const TOKEN_DECIMALS = 6 as const

/** Minimum HMAC secret length, enforced by mppx. */
const MIN_SECRET_BYTES = 32

export type Config = {
  readonly realm: string
  readonly secretKey: string
  readonly recipient: `0x${string}`
  readonly port: number
  /** Price of a /v1/search call, in human-readable units (e.g. "0.50"). */
  readonly searchPrice: string
  /** Ledger file. `:memory:` for an ephemeral database (tests, demo). */
  readonly ledgerPath: string
  /** Replay store backend. */
  readonly replayStore: ReplayStoreKind
  /** Path of the SQLite replay store file. */
  readonly replayStorePath: string
  /** Redis URL, required when `replayStore === 'redis'`. */
  readonly redisUrl: string | undefined
  /** Price of a /v1/analyze call (POST route, body bound by digest). */
  readonly analyzePrice: string
  /** Bearer token for `/metrics`. Absent: the export is disabled. */
  readonly metricsToken?: string | undefined
}

export const REPLAY_STORES = ['memory', 'sqlite', 'redis'] as const
export type ReplayStoreKind = (typeof REPLAY_STORES)[number]

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new ConfigError(`${key} is required (see .env.example)`)
  return value
}

/** Human-readable amount: digits and a decimal point only. No scientific notation. */
const AMOUNT_RE = /^\d+(\.\d{1,6})?$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Guard #1: explicitly refuse any network other than testnet.
  // The project is testnet-only (CLAUDE.md rule).
  const network = env['MPP_NETWORK'] ?? 'testnet'
  if (network !== 'testnet')
    throw new ConfigError(
      `MPP_NETWORK="${network}" refused: this project is testnet only. ` +
        `Only the value "testnet" is accepted.`,
    )

  const secretKey = required(env, 'MPP_SECRET_KEY')
  if (Buffer.byteLength(secretKey, 'utf8') < MIN_SECRET_BYTES)
    throw new ConfigError(
      `MPP_SECRET_KEY is shorter than ${MIN_SECRET_BYTES} bytes. ` +
        `Generate one with \`openssl rand -base64 32\`.`,
    )

  const recipient = required(env, 'MPP_RECIPIENT')
  if (!ADDRESS_RE.test(recipient))
    throw new ConfigError(`MPP_RECIPIENT is not a valid 0x address: ${recipient}`)

  const searchPrice = env['MPP_SEARCH_PRICE'] ?? '0.50'
  if (!AMOUNT_RE.test(searchPrice))
    throw new ConfigError(
      `MPP_SEARCH_PRICE invalid: "${searchPrice}". ` +
        `Expected: a human-readable amount, max ${TOKEN_DECIMALS} decimals (e.g. "0.50").`,
    )

  const metricsToken = env['METRICS_TOKEN'] || undefined
  if (metricsToken !== undefined && metricsToken.length < 16)
    throw new ConfigError('METRICS_TOKEN must be at least 16 characters long.')

  const analyzePrice = env['MPP_ANALYZE_PRICE'] ?? '1.00'
  if (!AMOUNT_RE.test(analyzePrice))
    throw new ConfigError(`MPP_ANALYZE_PRICE invalid: "${analyzePrice}".`)

  const replayStore = (env['REPLAY_STORE'] ?? 'sqlite') as ReplayStoreKind
  if (!REPLAY_STORES.includes(replayStore))
    throw new ConfigError(
      `REPLAY_STORE="${replayStore}" unknown. Values: ${REPLAY_STORES.join(', ')}.`,
    )
  const redisUrl = env['REDIS_URL']
  if (replayStore === 'redis' && !redisUrl)
    throw new ConfigError('REPLAY_STORE=redis requires REDIS_URL.')

  // The memory store is the mppx default, and it has two blind spots:
  // it is not shared between processes, and it is lost on restart —
  // a Credential then becomes replayable again. We allow it, but never
  // by accident. See docs/features/replay-protection.md.
  if (replayStore === 'memory' && env['REPLAY_STORE_MEMORY_ACK'] !== 'i-know')
    throw new ConfigError(
      'REPLAY_STORE=memory is not shared between processes and does not survive ' +
        'a restart: a Credential becomes replayable again. ' +
        'Use sqlite or redis, or set REPLAY_STORE_MEMORY_ACK=i-know.',
    )

  const portRaw = env['PORT'] ?? '8787'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigError(`PORT invalid: "${portRaw}"`)

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
