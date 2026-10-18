# Prometheus observability

`GET /metrics` (token-protected, Prometheus text format) — active when
`createApp` receives a `Metrics` (`observability/metrics.ts`) and a
`METRICS_TOKEN` is configured.

| Series | Type | Labels |
|---|---|---|
| `mpp_challenges_total` | counter | `method`, `intent` |
| `mpp_payments_total` | counter | `method`, `intent`, `status` |
| `mpp_payment_failures_total` | counter | `code` (normalized MPP code) |
| `mpp_settlement_duration_seconds` | histogram | `status` |
| `agent_spent_pathusd`, `agent_budget_remaining_pathusd` | gauge | — |

## Choices
- Fed by the mppx hooks (`onChallengeCreated`, `onPaymentSuccess`,
  `onPaymentFailed`), like the ledger.
- **Safe labels**: never a Challenge id, payer, reference or amount
  (unbounded cardinality + NOTES §8). The test checks the allowlist of label
  names and the absence of the secret, the id, the recipient, the query and the
  amount in the export.
- Latency only times requests carrying `Authorization: Payment` (the header is
  tested, never read).

## Limits
- `/metrics` requires `Authorization: Bearer $METRICS_TOKEN` (≥ 16 chars);
  without `METRICS_TOKEN`, the route does not exist (404, fail-closed). Also
  keep it on an internal network (see [docker.md](docker.md)).
- The agent gauges (`attachAgent`) read the `BudgetGuard` of the agent
  process, which serves its own `/metrics` (`agent/metrics-server.ts`, same
  bearer token). Only active with `AGENT_METRICS_PORT` **and** `METRICS_TOKEN`
  (≥ 16 chars).
- The agent is short-lived: it keeps the export up for `AGENT_METRICS_LINGER`
  seconds (default 30; Compose sets 45) after the run ends. Outside a run, the
  Prometheus target is `down`; the series remain in history. If the scrape
  window is missed, the final value is lost — a Pushgateway would be the
  robust answer, at the cost of one more service.
- Under Compose, run the agent with `--use-aliases`, otherwise `agent:9464`
  does not resolve:
  `docker compose --profile agent run --rm --use-aliases agent "…"`.
