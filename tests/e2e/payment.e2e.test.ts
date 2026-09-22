/**
 * Phase 5 — paiement réel sur Tempo Moderato.
 *
 * ⚠️ Ce test DÉPENSE des fonds testnet et appelle le RPC public.
 * Il est exclu du run par défaut (`npm test`) et lancé par `npm run test:e2e`.
 * Il s'auto-ignore si `AGENT_PRIVATE_KEY` n'est pas configurée.
 *
 * Préparation :
 *   npx mppx account create --account agent
 *   npx mppx account fund --network testnet --account agent
 *   npx mppx account export --account agent   → AGENT_PRIVATE_KEY dans .env
 */
import { Receipt } from 'mppx'
import { beforeAll, describe, expect, it } from 'vitest'

import { toBaseUnits } from '../../agent/amount.ts'
import { BudgetGuard } from '../../agent/budget.ts'
import { createPayingClient } from '../../agent/client.ts'
import { loadAgentConfig } from '../../agent/wallet.ts'
import { openLedger } from '../../ledger/db.ts'
import { attachLedger, Ledger } from '../../ledger/record.ts'
import { createApp } from '../../server/app.ts'
import { loadConfig, PATH_USD, TESTNET_CHAIN_ID } from '../../server/config.ts'
import { createPayment } from '../../server/payment.ts'
import { loadDotEnv } from './loadEnv.ts'

loadDotEnv()

const RPC = 'https://rpc.moderato.tempo.xyz'
const configured = Boolean(process.env['AGENT_PRIVATE_KEY'])

async function rpc(method: string, params: unknown[]): Promise<any> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`)
  return body.result
}

/** Solde pathUSD (TIP-20 `balanceOf`), en unités de base. */
async function balanceOf(address: string): Promise<bigint> {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`
  return BigInt((await rpc('eth_call', [{ to: PATH_USD, data }, 'latest'])) || '0x0')
}

describe.skipIf(!configured)('paiement réel sur Moderato', () => {
  let serverConfig: ReturnType<typeof loadConfig>
  let agent: ReturnType<typeof loadAgentConfig>

  beforeAll(() => {
    serverConfig = loadConfig()
    agent = loadAgentConfig()
  })

  it('paie, reçoit le contenu, et le transfert est confirmé on-chain', { timeout: 180_000 }, async () => {
      const price = toBaseUnits(serverConfig.searchPrice, 6)
      const payment = createPayment(serverConfig)
      const ledger = new Ledger(openLedger(':memory:'))
      attachLedger(payment, ledger)
      const app = createApp(serverConfig, payment)

      const guard = new BudgetGuard(agent.limits)
      // On capture le Credential envoyé, pour la preuve d'anti-rejeu ci-dessous.
      let credential: string | undefined
      const { mppx } = createPayingClient({
        account: agent.account,
        guard,
        fetch: async (input, init) => {
          const request = new Request(input as string, init)
          const header = request.headers.get('Authorization')
          if (header?.startsWith('Payment ')) credential = header
          return app.fetch(request)
        },
      })

      const before = await balanceOf(serverConfig.recipient)

      const response = await mppx.fetch('http://api.test/v1/search?q=mpp')
      expect(response.status).toBe(200)

      const body = (await response.json()) as { payer?: string; results?: unknown[] }
      expect(body.results?.length).toBeGreaterThan(0)
      expect(body.payer).toBe(`did:pkh:eip155:${TESTNET_CHAIN_ID}:${agent.account.address}`)

      // --- Receipt ---
      const header = response.headers.get('Payment-Receipt')
      expect(header).toBeTruthy()
      const receipt = Receipt.deserialize(header!)
      expect(receipt.status).toBe('success')
      expect(receipt.method).toBe('tempo')
      expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)

      // --- Budget décompté ---
      expect(guard.committed).toBe(price)

      // --- Ledger ---
      const row = ledger.all().find((r) => r.status === 'success')
      expect(row).toBeDefined()
      expect(row!.reference).toBe(receipt.reference)
      expect(row!.payer).toContain(agent.account.address)

      // --- Confirmation on-chain ---
      const txReceipt = await rpc('eth_getTransactionReceipt', [receipt.reference])
      expect(txReceipt, 'transaction introuvable sur le RPC').toBeTruthy()
      expect(txReceipt.status).toBe('0x1')
      expect(String(txReceipt.from).toLowerCase()).toBe(agent.account.address.toLowerCase())
      expect(String(txReceipt.to).toLowerCase()).toBe(PATH_USD)

      // --- Les fonds sont réellement arrivés ---
      const after = await balanceOf(serverConfig.recipient)
      expect(after - before).toBe(price)

      // --- Anti-rejeu : le même Credential resservi doit être refusé ---
      expect(credential, 'aucun Credential capturé').toBeTruthy()
      const replay = await app.fetch(
        new Request('http://api.test/v1/search?q=mpp', {
          headers: { Authorization: credential! },
        }),
      )
      expect(replay.status).toBe(402)
      expect(replay.headers.get('WWW-Authenticate')).toMatch(/^Payment /)
  })
})

describe.skipIf(configured)('paiement réel — ignoré', () => {
  it('AGENT_PRIVATE_KEY absente : configurez un wallet financé', () => {
    expect(configured).toBe(false)
  })
})
