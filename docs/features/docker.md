# Docker Compose

`compose.yml`: `server` (provider), `prometheus`, and `agent` (profile
`agent`, on demand).

```
export MPP_SECRET_KEY=… MPP_RECIPIENT=0x… METRICS_TOKEN=… # or a .env
docker compose up -d --build
docker compose --profile agent run --rm --use-aliases agent "your question"
```

## Choices
- **One image, non-root** (`USER node`), two stages: the build stage carries
  `python3/make/g++` (better-sqlite3 is compiled, no prebuilt binary was found
  for Node 20); the final image only has `node_modules` and the code.
- **No secret in the image**: `.dockerignore` excludes `.env*`; everything is
  injected at runtime. `MPP_SECRET_KEY`, `MPP_RECIPIENT`, `METRICS_TOKEN` are
  mandatory (`${VAR:?}`), startup fails otherwise.
- **Prometheus** reads the token through a Compose *secret*
  (`environment: METRICS_TOKEN` → `/run/secrets/metrics_token`,
  `credentials_file`): the token is not written in `prometheus.yml`.
- Ports published on `127.0.0.1` only; ledger and SQLite replay store on the
  `server-data` volume.
- The agent service uses `entrypoint` (not `command`), so the question passed to
  `docker compose run` is appended as an argument.

## Verified (testnet, local)
`/healthz` 200 · `/metrics` 401 without a token · Prometheus target `up` and
`mpp_challenges_total` queryable · `docker history --no-trunc`: 0 occurrences of
a secret · container user uid 1000 · no `.env` in the image.

The full `agent` service was also run end to end under Compose: one real
0.50 pathUSD payment, a `success` row in the server ledger with a transaction
reference, and `agent_spent_pathusd = 0.5` scraped by Prometheus.

## Limits
- `tsx` (a devDependency) runs the TypeScript at runtime: a heavier image than
  a compiled build.
- The agent target is only `up` while a run (plus its linger window) is in
  progress — see [observability.md](observability.md).
