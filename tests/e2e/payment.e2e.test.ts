/**
 * Phase 5 — real payment on Tempo Moderato.
 *
 * ⚠️ This test SPENDS testnet funds and calls the public RPC.
 * It is excluded from the default run (`npm test`) and run by `npm run test:e2e`.
 * It skips itself if `AGENT_PRIVATE_KEY` is not configured.
 *
 * Setup:
 *   npx mppx account create --account agent
 *   npx mppx account fund --network testnet --account agent
 *   npx mppx account export --account agent   → AGENT_PRIVATE_KEY in .env
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
import { createReplayStore } from '../../server/bootstrap.ts'
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

/** pathUSD balance (TIP-20 `balanceOf`), in base units. */
async function balanceOf(address: string): Promise<bigint> {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`
  return BigInt((await rpc('eth_call', [{ to: PATH_USD, data }, 'latest'])) || '0x0')
}

describe.skipIf(!configured)('real payment on Moderato', () => {
  let serverConfig: ReturnType<typeof loadConfig>
  let agent: ReturnType<typeof loadAgentConfig>

  beforeAll(() => {
    serverConfig = loadConfig()
    agent = loadAgentConfig()
  })

  it('pays, receives the content, and the transfer is confirmed on-chain', { timeout: 180_000 }, async () => {
      const price = toBaseUnits(serverConfig.searchPrice, 6)
      // Same wiring as in production: the replay store comes from the config.
      const { store, close } = await createReplayStore(serverConfig)
      const payment = createPayment(serverConfig, store)
      const ledger = new Ledger(openLedger(':memory:'))
      attachLedger(payment, ledger)
      const app = createApp(serverConfig, payment)

      const guard = new BudgetGuard(agent.limits)
      // We capture the Credential sent, for the replay-protection proof below.
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

      // --- Budget counted ---
      expect(guard.committed).toBe(price)

      // --- Ledger ---
      const row = ledger.all().find((r) => r.status === 'success')
      expect(row).toBeDefined()
      expect(row!.reference).toBe(receipt.reference)
      expect(row!.payer).toContain(agent.account.address)

      // --- Confirmation on-chain ---
      const txReceipt = await rpc('eth_getTransactionReceipt', [receipt.reference])
      expect(txReceipt, 'transaction not found on the RPC').toBeTruthy()
      expect(txReceipt.status).toBe('0x1')
      expect(String(txReceipt.from).toLowerCase()).toBe(agent.account.address.toLowerCase())
      expect(String(txReceipt.to).toLowerCase()).toBe(PATH_USD)

      // --- The funds really arrived ---
      const after = await balanceOf(serverConfig.recipient)
      expect(after - before).toBe(price)

      // --- Replay protection: the same Credential served again must be refused ---
      expect(credential, 'no Credential captured').toBeTruthy()
      const replay = await app.fetch(
        new Request('http://api.test/v1/search?q=mpp', {
          headers: { Authorization: credential! },
        }),
      )
      expect(replay.status).toBe(402)
      expect(replay.headers.get('WWW-Authenticate')).toMatch(/^Payment /)

      await close()
  })
})

describe.skipIf(configured)('real payment — skipped', () => {
  it('AGENT_PRIVATE_KEY absent: configure a funded wallet', () => {
    expect(configured).toBe(false)
  })
})
