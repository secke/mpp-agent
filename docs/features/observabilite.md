# Observabilité Prometheus

`GET /metrics` (gratuit, format texte Prometheus) — actif quand `createApp`
reçoit un `Metrics` (`observability/metrics.ts`).

| Série | Type | Labels |
|---|---|---|
| `mpp_challenges_total` | counter | `method`, `intent` |
| `mpp_payments_total` | counter | `method`, `intent`, `status` |
| `mpp_payment_failures_total` | counter | `code` (code MPP normalisé) |
| `mpp_settlement_duration_seconds` | histogram | `status` |
| `agent_spent_pathusd`, `agent_budget_remaining_pathusd` | gauge | — |

## Choix
- Alimentation par les hooks mppx (`onChallengeCreated`, `onPaymentSuccess`,
  `onPaymentFailed`), comme le ledger.
- **Labels sûrs** : jamais d'id de Challenge, de payeur, de référence ni de
  montant (cardinalité non bornée + NOTES §8). Le test vérifie la liste blanche
  des noms de labels et l'absence du secret, de l'id, du destinataire, de la
  requête et du montant dans l'export.
- La latence ne chronomètre que les requêtes portant `Authorization: Payment`
  (l'en-tête est testé, jamais lu).

## Limites
- `/metrics` est public, comme `/healthz` : à restreindre au réseau interne
  (phase 7, Compose).
- Les gauges de l'agent (`attachAgent`) lisent le `BudgetGuard` du **même
  processus**. L'agent tourne dans un processus distinct du serveur : son
  exposition HTTP propre reste à câbler en phase 7.
