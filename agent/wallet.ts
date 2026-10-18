/**
 * The agent's paying account.
 *
 * The private key comes from the environment, never from code, never from a log.
 * Source: https://mpp.dev/sdk/typescript/middlewares/hono § Choose a signing account
 *   `privateKeyToAccount(process.env.PRIVATE_KEY as \`0x\${string}\`)`
 */
import { privateKeyToAccount } from 'viem/accounts'
import type { PrivateKeyAccount } from 'viem'

import { PATH_USD, TESTNET_CHAIN_ID, TOKEN_DECIMALS } from '../server/config.ts'
import { toBaseUnits } from './amount.ts'
import type { BudgetLimits } from './budget.ts'

export class WalletError extends Error {
  override name = 'WalletError'
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

export type AgentConfig = {
  readonly account: PrivateKeyAccount
  readonly limits: BudgetLimits
  /** Provider base URL, e.g. http://localhost:8787 */
  readonly providerUrl: string
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const network = env['MPP_NETWORK'] ?? 'testnet'
  if (network !== 'testnet')
    throw new WalletError(`MPP_NETWORK="${network}" refused: testnet-only agent.`)

  const key = env['AGENT_PRIVATE_KEY']
  if (!key) throw new WalletError('AGENT_PRIVATE_KEY is required (see .env.example)')
  if (!PRIVATE_KEY_RE.test(key))
    // Message deliberately silent about the value: never leak a key.
    throw new WalletError('AGENT_PRIVATE_KEY malformed (expected 0x + 64 hex characters)')

  const maxPerCall = toBaseUnits(env['AGENT_MAX_PER_CALL'] ?? '1.00', TOKEN_DECIMALS)
  const totalBudget = toBaseUnits(env['AGENT_TOTAL_BUDGET'] ?? '10.00', TOKEN_DECIMALS)
  if (maxPerCall > totalBudget)
    throw new WalletError(
      `AGENT_MAX_PER_CALL exceeds AGENT_TOTAL_BUDGET: per-call cap unreachable.`,
    )

  const recipients = env['AGENT_ALLOWED_RECIPIENTS']
    ?.split(',')
    .map((r) => r.trim())
    .filter(Boolean)

  return {
    account: privateKeyToAccount(key as `0x${string}`),
    limits: {
      maxPerCall,
      totalBudget,
      chainId: TESTNET_CHAIN_ID,
      currency: PATH_USD,
      decimals: TOKEN_DECIMALS,
      ...(recipients?.length ? { recipients } : {}),
    },
    providerUrl: env['AGENT_PROVIDER_URL'] ?? 'http://localhost:8787',
  }
}
