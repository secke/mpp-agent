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

## Phase 3 — Ledger SQLite ✅ **terminée**

**Branche** : `phase-3-ledger`

**Objectif** : journal d'audit des paiements, côté serveur et côté agent.

- [x] `ledger/schema.sql` + `ledger/db.ts` (**`better-sqlite3`**, pas
      `node:sqlite` : indisponible avant Node 22.5 — voir D11)
- [x] `ledger/record.ts` — écriture depuis `onChallengeCreated`,
      `onPaymentSuccess`, `onPaymentFailed`
- [x] Vues `ledger_reconciliation` et `ledger_unsettled`

**Critères de sortie (tests)** — 20 tests
- [x] un cycle 402 → une ligne `challenged`, puis `success` avec référence et payeur
- [x] un échec écrit `failed` avec le code d'erreur MPP normalisé
- [x] **aucun secret journalisé** : lecture binaire du fichier SQLite +
      assertion sur la liste exacte des colonnes
- [x] idempotence : rejouer le même `challenge.id` ne duplique pas de ligne

**Découverte majeure** : l'id de Challenge **n'identifie pas une requête** —
19 collisions sur 50 requêtes rapides. D'où le compteur `occurrences`.
Voir [`DECISIONS.md` D12](docs/DECISIONS.md).

---

## Phase 4 — Agent LLM avec tool use ✅ **terminée**

**Branche** : `phase-4-agent-llm`

**Objectif** : le modèle décide *lui-même* d'acheter une recherche.

- [x] `agent/llm.ts` — port `LlmClient` + client **DeepSeek** (API compatible
      OpenAI ; pas d'`@anthropic-ai/sdk`, voir D14)
- [x] `agent/tools.ts` — outil `search_marketplace` et son exécuteur
- [x] `agent/loop.ts` — boucle tool use, bornée en tours et en achats
- [x] `agent/index.ts` — démonstration (`npm run agent -- "…"`)
- [x] Le budget guard reste l'autorité finale

**Critères de sortie (tests)** — 29 tests
- [x] boucle testée avec un modèle scripté (aucun appel réseau en CI)
- [x] un refus du guard revient comme `tool_result` exploitable, jamais en
      exception ; un refus terminal coupe l'outil pour que le modèle conclue
- [x] aucune clé privée, aucun Credential, aucun message d'erreur brut
      n'atteint le contexte du modèle

**Démontré en vrai** contre le provider et le modèle DeepSeek : budget
insuffisant → refus `per-call-cap`, le modèle conclut en 2 tours en signalant
la limite ; budget suffisant mais wallet vide → `search-unavailable`, le modèle
retente une fois. `dépense : 0` dans les deux cas — la réservation est bien
libérée.

---

## Phase 5 — E2E testnet réel ✅ **terminée**

**Branche** : `phase-5-e2e-testnet`

**Objectif** : un vrai paiement on-chain sur Moderato.

- [x] Comptes `agent` (payeur, financé) et `provider` (destinataire)
- [x] `tests/e2e/payment.e2e.test.ts` : agent → serveur → transfert pathUSD
      réel → `Payment-Receipt`
- [x] Vérification du hash de transaction sur le RPC **et** du delta de solde

**Critères de sortie**
- [x] test `*.e2e.test.ts` exclu de `npm test`, lancé par `npm run test:e2e`,
      auto-ignoré sans `AGENT_PRIVATE_KEY`
- [x] le `reference` du Receipt correspond à une transaction confirmée sur 42431
      (bloc 36470584, `status: 0x1`)
- [x] le solde du destinataire augmente **exactement** du prix (+0,50 pathUSD)
- [x] anti-rejeu prouvé : le Credential capturé et rejoué → **402**

---

## Phase 6 — Observabilité Prometheus ✅ **terminée** (une réserve)

**Branche** : `phase-6-observabilite`

- [x] `/metrics` : challenges émis, paiements réussis/échoués, latence de
      règlement, dépense cumulée de l'agent
- [x] Labels sûrs uniquement (method, intent, status) — jamais d'identifiant
      de paiement ni de montant nominatif

**Critères de sortie** : test qui assert la présence des séries et
**l'absence** de toute valeur sensible dans l'export. ✅ (4 tests)

`/metrics` protégé par jeton bearer (`METRICS_TOKEN`) ; les gauges de
l'agent sont servies par le processus agent (`agent/metrics-server.ts`, branche
`phase-6b-metriques-agent`). ⚠️ Agent éphémère : fenêtre de scrape bornée.

---

## Phase 7 — Docker Compose ✅ **terminée** (une réserve)

**Branche** : `phase-7-docker`

- [x] `Dockerfile` (multi-stage, non-root), `compose.yml` : server + agent +
      Prometheus
- [x] Secrets injectés par l'environnement, jamais dans l'image

**Critères de sortie** : `docker compose up` → `/healthz` et `/metrics`
répondent ; `docker history` ne révèle aucun secret. ✅ (`/metrics` exige
le jeton). ⚠️ Service `agent` non lancé (clés requises).

---

## Phase 8 — Durcissement ✅ **terminée** (une réserve)

**Branche** : `phase-8-durcissement` — *traitée avant les phases 6 et 7,
pour fermer le seul trou de sécurité réel.*

- [x] Liaison du corps sur `POST /v1/analyze` — via `scope` + `BodyDigest`,
      le serveur TS de mppx n'ayant **pas** d'option `body` (voir D20)
- [x] Store anti-rejeu partagé **et durable** : `sqlite` (défaut) ou `redis`,
      le store mémoire refusé sans acquittement explicite (D21)
- [ ] ⚠️ Rotation de `MPP_SECRET_KEY` avec recouvrement — **non implémentée** :
      `Mppx.create` ne prend qu'une seule clé. Procédure coordonnée documentée
      à la place, fenêtre bornée à 5 min (D22)
- [x] `Cache-Control: private` sur les 200 porteuses d'un Receipt
- [x] Revue de sécurité contre `docs/NOTES.md` §8 — 9 exigences sur 10

**Critères de sortie**
- [x] corps modifié après émission du Challenge → `invalid-challenge`
      (contre `verification-failed` avec le corps d'origine : c'est le
      contraste qui prouve la discrimination)
- [x] Credential rejoué → 402, marqueur **persisté sur disque**
- [x] checklist §8 : 9/10, la dixième bloquée par le SDK et documentée

---

## Hors périmètre (pour mémoire)

Disponibles dans `mppx` mais volontairement repoussés : intent `session`
(facturation à l'usage), intent `subscription`, streaming SSE facturé,
compatibilité x402, paiements par carte (Stripe). Voir `docs/NOTES.md` §6.
On les envisagera une fois le flux `charge` couvert de bout en bout.
