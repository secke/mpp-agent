/**
 * Métriques Prometheus (phase 6).
 *
 * Source : https://github.com/siimon/prom-client (Registry, Counter, Histogram, Gauge).
 * Hooks mppx : https://mpp.dev/sdk/typescript/server/Mppx.create § Event handling.
 *
 * ⚠️ Labels sûrs uniquement : `method`, `intent`, `status`, `code` (code MPP
 * normalisé, ensemble borné). Jamais d'id de Challenge, de payeur, de
 * référence de transaction ni de montant : ce sont des identifiants à
 * cardinalité non bornée, et ils fuiraient dans l'export (NOTES §8).
 */
import { Challenge } from 'mppx'
import { Counter, Gauge, Histogram, Registry } from 'prom-client'

import { normalizeErrorCode } from '../ledger/record.ts'

export type Metrics = ReturnType<typeof createMetrics>

export function createMetrics(registry: Registry = new Registry()) {
  const challenges = new Counter({
    name: 'mpp_challenges_total',
    help: 'Challenges 402 émis.',
    labelNames: ['method', 'intent'],
    registers: [registry],
  })
  const payments = new Counter({
    name: 'mpp_payments_total',
    help: 'Paiements traités, par issue.',
    labelNames: ['method', 'intent', 'status'],
    registers: [registry],
  })
  const failures = new Counter({
    name: 'mpp_payment_failures_total',
    help: 'Paiements échoués, par code MPP normalisé.',
    labelNames: ['code'],
    registers: [registry],
  })
  const settlement = new Histogram({
    name: 'mpp_settlement_duration_seconds',
    help: 'Durée de traitement des requêtes portant un Credential (vérification + règlement).',
    labelNames: ['status'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  })

  return {
    registry,
    settlement,

    /** Branche les compteurs sur les hooks d'une instance de paiement serveur. */
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
     * Dépense cumulée de l'agent, lue à la demande depuis le budget guard.
     * `snapshot()` rend des décimales lisibles (« 0.5 ») ; on les expose en
     * pathUSD, sans conversion en unités de base.
     */
    attachAgent(guard: { snapshot(): { committed: string; reserved: string; remaining: string } }): void {
      new Gauge({
        name: 'agent_spent_pathusd',
        help: "Dépense confirmée de l'agent (pathUSD).",
        registers: [registry],
        collect() {
          this.set(Number(guard.snapshot().committed))
        },
      })
      new Gauge({
        name: 'agent_budget_remaining_pathusd',
        help: "Budget restant de l'agent (pathUSD).",
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
