# Projet : Agentic Research Marketplace (MPP)

## Règles absolues
- N'invente JAMAIS une API. Avant tout code utilisant mppx, lis la page
  de doc correspondante (mpp.dev) ou les types du SDK installé
  (`node_modules/mppx/dist/**/*.d.ts`), et cite la source en commentaire.
- Testnet uniquement. Clés privées dans .env (gitignored), jamais en dur.
- Une phase = une branche + tests `vitest` qui passent avant de continuer.
- Si la doc et ce fichier se contredisent, la doc gagne : signale-le.

## Stack
Node.js >= 20 (ESM), TypeScript, Hono (serveur HTTP),
SDK **mppx** officiel (TypeScript), viem (comptes/signature),
SDK `openai` pointé sur **DeepSeek** (API compatible OpenAI, tool use),
SQLite via `better-sqlite3` (ledger métier), vitest, Docker Compose, Prometheus.

> Historique : la phase 0 a d'abord été instruite en Python (`pympp`).
> Le projet est passé à TypeScript ; `mppx` est le SDK officiel **TS**.
> Voir `docs/NOTES.md` §0 pour la table de correspondance de stack.

## Structure
server/   # provider MPP (Hono + mppx/hono)
agent/    # agent LLM payeur, budget guard
ledger/   # journal des transactions (SQLite)
tests/    # e2e testnet + unitaires (vitest)
docs/     # NOTES.md (spec), DECISIONS.md, features/

## Invariants non négociables (voir docs/NOTES.md)
- Testnet : toujours `tempo.charge({ testnet: true })`.
  JAMAIS `chainId` seul — il produit une config incohérente (NOTES §4.1).
- Client agent : toujours `Mppx.create({ polyfill: false })`.
  Le défaut `true` patche `globalThis.fetch` et rend le budget guard
  contournable (NOTES §5.4).
- Le budget guard s'implémente dans le hook `onChallenge` du client.
- Ne jamais logger : MPP_SECRET_KEY, `Authorization: Payment`,
  `Payment-Authorization: Payment`, `Payment-Receipt` (NOTES §8).
- `MPP_SECRET_KEY` >= 32 octets (imposé par le SDK).
- Refuser un paiement côté client = **lever** depuis `onChallenge`.
  Renvoyer `undefined` fait payer (NOTES §5.4).
- Le ledger ne stocke jamais un Credential, un Receipt brut, un secret
  ni un message d'erreur — seulement des références (NOTES §8).
- Un refus du budget guard revient au modèle comme `tool_result` structuré,
  jamais comme une exception : il doit pouvoir en tenir compte.
- Aucune clé privée, aucun Credential, aucun message d'erreur brut
  n'entre dans le contexte du modèle.

## Plan
Phases 0 à 8 : voir `PLAN.md`.
Chaque fonctionnalité livrée est documentée dans `docs/features/`.
