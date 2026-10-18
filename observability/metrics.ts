/**
 * Prometheus metrics (phase 6).
 *
 * Source : https://github.com/siimon/prom-client (Registry, Counter, Histogram, Gauge).
 * mppx hooks: https://mpp.dev/sdk/typescript/server/Mppx.create § Event handling.
 *
 * ⚠️ Safe labels only: `method`, `intent`, `status`, `code` (normalized MPP
 * code, bounded set). Never a Challenge id, payer, transaction reference or
 * amount: these are unbounded-cardinality identifiers, and they would leak
 * into the export (NOTES §8).
 */
import { Challenge } from 'mppx'
import { Counter, Gauge, Histogram, Registry } from 'prom-client'

import { normalizeErrorCode } from '../ledger/record.ts'

export type Metrics = ReturnType<typeof createMetrics>

export function createMetrics(registry: Registry = new Registry()) {
  const challenges = new Counter({
    name: 'mpp_challenges_total',
    help: '402 Challenges issued.',
    labelNames: ['method', 'intent'],
    registers: [registry],
  })
  const payments = new Counter({
    name: 'mpp_payments_total',
    help: 'Payments processed, by outcome.',
    labelNames: ['method', 'intent', 'status'],
    registers: [registry],
  })
  const failures = new Counter({
    name: 'mpp_payment_failures_total',
    help: 'Failed payments, by normalized MPP code.',
    labelNames: ['code'],
    registers: [registry],
  })
  const settlement = new Histogram({
    name: 'mpp_settlement_duration_seconds',
    help: 'Processing time of requests carrying a Credential (verification + settlement).',
    labelNames: ['status'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  })

  return {
    registry,
    settlement,

    /** Hooks the counters onto a server payment instance. */
    attach(payment: {
      onChallengeCreated: (h: (c: { challenge: Challenge.Challenge }) => void) => unknown
      onPaymentSuccess: (h: (c: { challenge: Challenge.Challenge }) => void) => unknown
      onPaymentFailed: (
        h: (c: { challenge: Challenge.Challenge; error: unknown }) => void,
      ) => unknown
    }): void {
      payment.onChallengeCreated(({ challenge }) =>
        challenges.inc({ method: challenge.method, intent: challenge.intent }),
      )
      payment.onPaymentSuccess(({ challenge }) =>
        payments.inc({ method: challenge.method, intent: challenge.intent, status: 'success' }),
      )
      payment.onPaymentFailed(({ challenge, error }) => {
        payments.inc({ method: challenge.method, intent: challenge.intent, status: 'failed' })
        failures.inc({ code: normalizeErrorCode(error) })
      })
    },

    /**
     * Cumulative agent spend, read on demand from the budget guard.
     * `snapshot()` returns readable decimals ("0.5"); we expose them in
     * pathUSD, without conversion to base units.
     */
    attachAgent(guard: { snapshot(): { committed: string; reserved: string; remaining: string } }): void {
      new Gauge({
        name: 'agent_spent_pathusd',
        help: 'Confirmed agent spend (pathUSD).',
        registers: [registry],
        collect() {
          this.set(Number(guard.snapshot().committed))
        },
      })
      new Gauge({
        name: 'agent_budget_remaining_pathusd',
        help: 'Remaining agent budget (pathUSD).',
        registers: [registry],
        collect() {
          this.set(Number(guard.snapshot().remaining))
        },
      })
    },

    render: () => registry.metrics(),
    contentType: registry.contentType,
  }
}
