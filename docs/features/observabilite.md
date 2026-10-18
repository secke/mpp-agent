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
- `/metrics` exige `Authorization: Bearer $METRICS_TOKEN` (≥ 16 car.) ; sans
  `METRICS_TOKEN`, la route n'existe pas (404, fail-closed). Prévoir en plus un
  réseau interne en phase 7.
- Les gauges de l'agent (`attachAgent`) lisent le `BudgetGuard` du processus
  agent, qui sert son propre `/metrics` (`agent/metrics-server.ts`, même jeton
  bearer). Actif seulement avec `AGENT_METRICS_PORT` **et** `METRICS_TOKEN`
  (≥ 16 car.).
- L'agent est éphémère : il maintient l'export `AGENT_METRICS_LINGER` secondes
  (défaut 30) après la fin du run. Hors run, la cible Prometheus est `down` ;
  les séries restent dans l'historique. Si la fenêtre d'un scrape est ratée,
  la valeur finale est perdue — un Pushgateway serait la réponse robuste,
  au prix d'un service de plus.
- Sous Compose, lancer l'agent avec `--use-aliases`, sinon `agent:9464` ne
  résout pas : `docker compose --profile agent run --rm --use-aliases agent "…"`.
