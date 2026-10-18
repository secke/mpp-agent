# Docker Compose

`compose.yml` : `server` (provider), `prometheus`, et `agent` (profil `agent`,
à la demande).

```
export MPP_SECRET_KEY=… MPP_RECIPIENT=0x… METRICS_TOKEN=… # ou un .env
docker compose up -d --build
docker compose --profile agent run --rm --use-aliases agent "ta question"
```

## Choix
- **Une image, non-root** (`USER node`), deux étages : l'étage de build porte
  `python3/make/g++` (better-sqlite3 est compilé, aucun binaire précompilé n'a
  été trouvé pour Node 20) ; l'image finale n'a que `node_modules` et le code.
- **Aucun secret dans l'image** : `.dockerignore` exclut `.env*` ; tout est
  injecté à l'exécution. `MPP_SECRET_KEY`, `MPP_RECIPIENT`, `METRICS_TOKEN`
  sont obligatoires (`${VAR:?}`), le démarrage échoue sinon.
- **Prometheus** lit le jeton via un *secret* Compose (`environment: METRICS_TOKEN`
  → `/run/secrets/metrics_token`, `credentials_file`) : le jeton n'est pas écrit
  dans `prometheus.yml`.
- Ports publiés sur `127.0.0.1` uniquement ; ledger et anti-rejeu SQLite sur
  le volume `server-data`.

## Vérifié (testnet, local)
`/healthz` 200 · `/metrics` 401 sans jeton · cible Prometheus `up` et
`mpp_challenges_total` interrogeable · `docker history --no-trunc` : 0 occurrence
de secret · utilisateur du conteneur uid 1000 · aucun `.env` dans l'image.

## Limites
- Le service `agent` complet n'a pas été lancé (clé DeepSeek / wallet financé requis) ;
  le scrape de son `/metrics` a été vérifié avec une sonde utilisant le même serveur de métriques.
- `tsx` (devDependency) exécute le TypeScript à l'exécution : image plus lourde
  qu'un build compilé.
