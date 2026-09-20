# PLAN — Agentic Research Marketplace (MPP)

Découpage en 9 phases. **Règle** : une phase = une branche
(`phase-N-slug`) + tests `vitest` verts avant de passer à la suivante.
Chaque fonctionnalité livrée est documentée dans `docs/features/<slug>.md`.

Référence technique : `docs/NOTES.md` (spec 402 sourcée, pièges vérifiés).
Décisions d'architecture : `docs/DECISIONS.md`.

---

## Vision

Une place de marché où des **agents LLM** achètent des services de recherche
à l'appel, en stablecoin testnet, sans clé d'API ni inscription — via
HTTP 402 / MPP.

```
  agent/ (payeur)                          server/ (provider)
  ┌──────────────────┐                     ┌──────────────────┐
  │ Claude + tool use│  1. GET /v1/search  │  Hono + mppx     │
  │                  │ ──────────────────► │                  │
  │ budget guard     │  2. 402 + Challenge │  tempo.charge    │
  │ (onChallenge)    │ ◄────────────────── │  testnet:true    │
  │                  │  3. + Credential    │                  │
  │ mppx/client      │ ──────────────────► │  vérif + settle  │
  │ polyfill:false   │  4. 200 + Receipt   │                  │
  └────────┬─────────┘ ◄────────────────── └────────┬─────────┘
           │                                        │
           └──────────────► ledger/ ◄───────────────┘
                     (SQLite, journal d'audit)
```

---

## Phase 0 — Spec et socle documentaire ✅ **terminée**

**Objectif** : comprendre le protocole avant d'écrire une ligne de code.

- [x] Lire la doc MPP (protocole, transports, méthode Tempo, sécurité)
- [x] Installer `mppx` et inspecter les modules réels
- [x] `docs/NOTES.md` : flux 402, headers, config testnet, API réelle, pièges

**Sortie** : `docs/NOTES.md`. Deux pièges majeurs identifiés et mesurés —
`testnet: true` obligatoire (§4.1), `polyfill: false` obligatoire (§5.4).

---

## Phase 1 — Provider MPP : squelette payant

**Branche** : `phase-1-provider`

**Objectif** : un serveur Hono qui répond un vrai 402 conforme, verrouillé
sur le testnet.

- [ ] `server/config.ts` — chargement `.env`, validation stricte, garde-fou
      réseau (refus de démarrer hors testnet)
- [ ] `server/payment.ts` — instance `Mppx.create` + `tempo.charge({ testnet: true })`
- [ ] `server/app.ts` — app Hono, route gratuite `/healthz`, route payante
      `/v1/search`, route de découverte `/.well-known/mpp`
- [ ] `server/index.ts` — point d'entrée `@hono/node-server`

**Critères de sortie (tests)**
- `GET /healthz` → 200 sans paiement
- `GET /v1/search` sans Credential → **402**, `WWW-Authenticate: Payment …`
- en-têtes de sécurité : `Cache-Control: no-store`, `application/problem+json`
- le Challenge décodé porte `methodDetails.chainId === 42431` **et**
  `currency === pathUSD` (garde-fou anti-mainnet)
- le Challenge est lié HMAC : `Challenge.verify(ch, { secretKey })` vrai,
  faux avec un autre secret
- `secretKey` < 32 octets → démarrage refusé

---

## Phase 2 — Agent payeur et budget guard ✅ **terminée**

**Branche** : `phase-2-agent-payeur`

**Objectif** : un client qui paie tout seul, mais jamais au-delà d'un budget.

- [x] `agent/amount.ts` — arithmétique entière (`bigint`), refus d'arrondi
- [x] `agent/wallet.ts` — compte viem depuis `.env`, jamais en dur ni en log
- [x] `agent/budget.ts` — budget guard pur : 7 motifs de refus typés,
      réservation/confirmation/libération
- [x] `agent/client.ts` — `Mppx.create({ polyfill: false, onChallenge })`
      + garde-fous SDK (`expectedChainId`, `allowedChainIds`, `expectedRecipients`)

**Critères de sortie (tests)** — 40 tests
- [x] `polyfill: false` vérifié : `globalThis.fetch` inchangé après création
- [x] au-dessus du plafond par appel → refus, **aucune signature émise**
- [x] budget total épuisé → refus
- [x] dépense cumulée correctement décomptée (y compris engagements concurrents)
- [x] montant mal formé / devise inattendue / chaîne absente → refus (fail-closed)

**Découverte majeure** : renvoyer `undefined` depuis `onChallenge` **ne refuse
pas** le paiement — il faut lever. Corrige une erreur de `NOTES.md` §5.4.
Voir [`DECISIONS.md` D7](docs/DECISIONS.md).

---

## Phase 3 — Ledger SQLite

**Branche** : `phase-3-ledger`

**Objectif** : journal d'audit des paiements, côté serveur et côté agent.

- [ ] `ledger/schema.sql` + `ledger/db.ts` (`node:sqlite`)
- [ ] `ledger/record.ts` — écriture depuis `onChallengeCreated`,
      `onPaymentSuccess`, `onPaymentFailed`
- [ ] Vue de réconciliation : challenge émis ↔ receipt encaissé

**Critères de sortie (tests)**
- un cycle 402 → paiement écrit exactement une ligne, statut `success`
- un échec écrit une ligne `failed` avec le type d'erreur MPP
- **aucun secret journalisé** : test qui grep la base pour
  `Authorization`, `Payment-Receipt`, la clé privée, `MPP_SECRET_KEY`
- idempotence : rejouer le même `challenge.id` ne duplique pas de ligne

---

## Phase 4 — Agent LLM avec tool use

**Branche** : `phase-4-agent-llm`

**Objectif** : Claude décide *lui-même* d'acheter une recherche.

- [ ] `agent/tools.ts` — outil `search_marketplace` exposé au modèle
- [ ] `agent/loop.ts` — boucle tool use (`@anthropic-ai/sdk`)
- [ ] Le budget guard reste l'autorité finale : le modèle propose, le guard dispose

**Critères de sortie (tests)**
- boucle testée avec un client Anthropic mocké (pas d'appel réseau en CI)
- un refus du guard est renvoyé au modèle comme `tool_result` d'erreur
      exploitable, pas comme une exception
- aucune clé privée n'atteint jamais le contexte du modèle

---

## Phase 5 — E2E testnet réel

**Branche** : `phase-5-e2e-testnet`

**Objectif** : un vrai paiement on-chain sur Moderato.

- [ ] Compte financé via `npx mppx account fund --network testnet`
- [ ] Test e2e : agent → serveur → transfert pathUSD réel → `Payment-Receipt`
- [ ] Vérification du hash de transaction sur le RPC

**Critères de sortie**
- test marqué `e2e`, **exclu du run par défaut** (nécessite un wallet financé)
- le `reference` du Receipt correspond à une transaction confirmée sur 42431
- anti-rejeu prouvé : rejouer le même Credential → 402

---

## Phase 6 — Observabilité Prometheus

**Branche** : `phase-6-observabilite`

- [ ] `/metrics` : challenges émis, paiements réussis/échoués, latence de
      règlement, dépense cumulée de l'agent
- [ ] Labels sûrs uniquement (method, intent, status) — jamais d'identifiant
      de paiement ni de montant nominatif

**Critères de sortie** : test qui assert la présence des séries et
**l'absence** de toute valeur sensible dans l'export.

---

## Phase 7 — Docker Compose

**Branche** : `phase-7-docker`

- [ ] `Dockerfile` (multi-stage, non-root), `compose.yml` : server + agent +
      Prometheus
- [ ] Secrets injectés par l'environnement, jamais dans l'image

**Critères de sortie** : `docker compose up` → `/healthz` et `/metrics`
répondent ; `docker history` ne révèle aucun secret.

---

## Phase 8 — Durcissement

**Branche** : `phase-8-durcissement`

- [ ] `digest` sur les routes `POST`/`PUT`/`PATCH` (liaison du corps)
- [ ] Store anti-rejeu partagé (Redis) au lieu de la mémoire
- [ ] Rotation de `MPP_SECRET_KEY` avec fenêtre de recouvrement
- [ ] `Cache-Control: private` sur les 200 porteuses d'un Receipt
- [ ] Revue de sécurité finale contre `docs/NOTES.md` §8

**Critères de sortie** : corps modifié après émission du Challenge → rejet ;
Credential rejoué → rejet ; checklist §8 intégralement cochée.

---

## Hors périmètre (pour mémoire)

Disponibles dans `mppx` mais volontairement repoussés : intent `session`
(facturation à l'usage), intent `subscription`, streaming SSE facturé,
compatibilité x402, paiements par carte (Stripe). Voir `docs/NOTES.md` §6.
On les envisagera une fois le flux `charge` couvert de bout en bout.
