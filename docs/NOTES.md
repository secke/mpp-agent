# NOTES — Phase 0 : spec du flux MPP / HTTP 402 (stack TypeScript)

> Document de référence sourcé. **Aucune API n'est citée ici sans avoir été soit lue dans
> la doc officielle (mpp.dev), soit vérifiée par introspection du SDK réellement installé,
> soit prouvée par un script exécuté.** Chaque section indique sa source.
> Rédigé le 2026-09-20. SDK cible : **`mppx` 0.10.1** (TypeScript).

---

## 0. État de `CLAUDE.md` après le passage à TypeScript

| # | `CLAUDE.md` dit | Réalité (source) | Statut |
|---|---|---|---|
| 1 | « SDK **mppx** officiel » | ✅ **Correct en TypeScript.** `mppx` est bien le SDK officiel TS (dépôt `wevm/mppx`, npm `mppx@0.10.1`). C'est la mention « (Python) » qui était fausse : le SDK Python s'appelle `pympp`. | **Résolu** par le passage à TS. Retirer « (Python) ». |
| 2 | « Python 3.12, FastAPI, httpx, SDK Anthropic (Python), pytest » | Stack abandonnée. | **`CLAUDE.md` à réécrire** — voir tableau §0.1. |
| 3 | « SQLite (ledger) » | `mppx` n'expose **pas** de store SQLite : `Store.memory`, `Store.redis`, `Store.upstash`, `Store.cloudflare` uniquement (`node_modules/mppx/dist/Store.d.ts`). | SQLite reste possible pour **notre** ledger métier (via `node:sqlite`), mais **pas** comme store anti-rejeu `mppx`. Voir §5.5. |
| 4 | « Commence par la phase 0 (voir `PLAN.md`) » | **`PLAN.md` est toujours absent du dépôt.** | **Bloquant pour la phase 1.** |

### 0.1 Correspondance de stack proposée

| Rôle | `CLAUDE.md` (Python) | Équivalent TypeScript retenu | Justification |
|---|---|---|---|
| Runtime | Python 3.12 | **Node.js ≥ 20** (ici v20.20.1) | `mppx` est ESM, `type: "module"` |
| Framework serveur | FastAPI | **Hono** | adaptateur natif `mppx/hono` ; alternatives officielles : Express, Elysia, Next.js (<https://mpp.dev/sdk/typescript/middlewares/hono>) |
| Client HTTP | httpx | **`fetch`** enveloppé par `mppx/client` | le SDK est bâti autour de `fetch` |
| SDK MPP | `pympp` | **`mppx`** | § ci-dessus |
| SDK LLM | `anthropic` (Python) | **`@anthropic-ai/sdk`** | agent payeur avec tool use |
| Tests | pytest | **Vitest** (installé : 4.1.11) | idiomatique TS |
| Crypto/compte | eth-account | **`viem`** (installé : 2.56.8) | peer dependency de `mppx` |

> ⚠️ **Hono est un choix par défaut de ma part**, le plus proche de FastAPI (léger, typé,
> middleware par route). Express et Elysia sont aussi supportés nativement. À confirmer.

---

## 1. Ce qu'est MPP

MPP (*Machine Payments Protocol*) est un standard ouvert de paiement machine-à-machine bâti
sur `HTTP 402 Payment Required`, avec un modèle **Challenge → Credential → Receipt**.
Spécification IETF de référence : <https://paymentauth.org>.

Source : <https://mpp.dev/> et <https://mpp.dev/protocol/>.

---

## 2. Le flux 402, étape par étape

Source : <https://mpp.dev/protocol/transports/http> et <https://mpp.dev/protocol/http-402>.

```
1. Client  → Serveur   GET /api/data
2. Serveur → Client    402 Payment Required
                       WWW-Authenticate: Payment id="abc123", realm="...",
                                         method="tempo", intent="charge", request="eyJ..."
3. Client  → Serveur   GET /api/data
                       Authorization: Payment eyJjaGFsbGVuZ2Ui...
4. Serveur → Client    200 OK
                       Payment-Receipt: eyJzdGF0dXMiOiJzdWNjZXNzIi4uLn0
```

### Quand répondre 402 (et pas autre chose)

| Condition | Code |
|---|---|
| La ressource exige un paiement | **402** |
| Client non authentifié | 401 |
| Authentifié mais non autorisé | 403 |
| Ressource inexistante | 404 |

Point important : **MPP renvoie 402 y compris quand un Credential échoue la validation**
(là où les autres schémas d'auth HTTP renverraient 401), avec un **Challenge frais** à chaque
fois. Source : <https://mpp.dev/protocol/http-402> § « Status code comparison ».

Si la ressource exige *aussi* une authentification applicative : vérifier le token d'abord,
renvoyer 401 s'il échoue, et ne renvoyer 402 qu'après succès — pour ne pas divulguer les
conditions tarifaires à des clients non authentifiés. Même source.

### Corps d'erreur

Échec de paiement → 402 + `Content-Type: application/problem+json` + `Cache-Control: no-store`.
Types normalisés (`https://paymentauth.org/problems/<type>`) : `invalid-challenge`,
`malformed-credential`, `method-unsupported` (400), `payment-expired`,
`payment-insufficient`, `payment-required`, `verification-failed`.

✅ **Vérifié** : `mppx` émet bien `Cache-Control: no-store` et
`Content-Type: application/problem+json` tout seul sur le 402 (voir §5.6).

---

## 3. Les headers

Source : <https://mpp.dev/protocol/transports/http> § « Headers ».

| Sens | Header | Rôle |
|---|---|---|
| Serveur → Client | `WWW-Authenticate: Payment ...` | Challenge |
| Client → Serveur | `Authorization: Payment ...` | Credential (cas par défaut) |
| Client → Serveur | `Payment-Authorization: Payment ...` | Credential quand le Challenge porte `header="Payment-Authorization"` |
| Serveur → Client | `Payment-Receipt: ...` | Receipt (**optionnel**, pour l'auditabilité) |

`Payment-Authorization` sert à cohabiter avec une auth applicative qui occupe déjà
`Authorization`. Côté `mppx` : `Mppx.create({ requiresAuth: true })`.

### 3.1 Challenge (`WWW-Authenticate`)

Source : <https://mpp.dev/protocol/challenges>.

Paramètres **obligatoires** : `id`, `realm`, `method`, `intent`, `request`.
**Optionnels** : `description`, `digest`, `expires`, `header`, `opaque`.

`request` et `opaque` sont des chaînes **base64url d'un JSON canonicalisé JCS**
([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)). Le `request` décodé :

```json
{ "amount": "500000", "currency": "0x20c0…", "recipient": "0xf39F…",
  "methodDetails": { "chainId": 42431 } }
```

`amount` est en **unités de base** (pathUSD, 6 décimales → `"500000"` = 0,50 $).

**Liaison (binding) du Challenge — exigence de sécurité.** Le serveur doit lier `id` aux
paramètres attendus, sinon un client peut réutiliser un `id` avec des conditions modifiées.
Entrée canonique HMAC :

```
realm | method | intent | request | expires | digest | opaque
```

…et quand le Challenge annonce `header`, sa valeur s'insère **juste avant** `opaque`.
Les emplacements optionnels absents valent la chaîne vide ; `Authorization` étant le défaut
implicite, il n'est jamais annoncé ni intégré au HMAC.

*Confirmé dans le SDK installé* : `node_modules/mppx/dist/Challenge.d.ts`, JSDoc de
`Challenge.from` — « HMAC-SHA256 over the canonical challenge ID input
(`realm|method|intent|request|expires|digest|opaque`) ».
La même formule figure mot pour mot dans le SDK Python (`pympp`), donc elle est bien
inter-implémentation.

Plusieurs `WWW-Authenticate` peuvent être renvoyés pour offrir plusieurs moyens de paiement ;
le client en choisit un et soumet **un seul** Credential.

### 3.2 Credential (`Authorization` / `Payment-Authorization`)

Source : <https://mpp.dev/protocol/credentials>.

Valeur = `Payment <base64url(JSON)>`, JSON à trois champs :

| Champ | Rôle |
|---|---|
| `challenge` | l'écho **inchangé** du Challenge (`request`/`opaque` restent en base64url) |
| `source` | identité du payeur, ex. `did:pkh:eip155:42431:0x…` |
| `payload` | preuve de paiement spécifique au moyen de paiement |

Payloads Tempo `charge` — les trois sont dans le schéma zod du SDK
(`dist/tempo/Methods.d.ts`, union discriminée sur `type`) :

| `payload.type` | Usage client | Vérification serveur |
|---|---|---|
| `transaction` | charge non nulle, mode *pull* | transaction Tempo signée, avant diffusion |
| `hash` | charge non nulle, mode *push* | reçu on-chain de la transaction soumise |
| `proof` | montant zéro (flux d'identité) | signature sur l'ID du Challenge, aucun transfert |

✅ Contrairement au SDK Python, **`proof` est disponible en TypeScript** (module
`dist/tempo/Proof.js`). Utile pour de l'identification gratuite sans transfert.

**Anti-rejeu** : une preuve doit être acceptée **au plus une fois**. Le binding du Challenge
empêche de modifier les conditions mais **ne détecte pas le rejeu**.
Comportement `mppx` lu dans `dist/tempo/server/Charge.d.ts` (option `store`) :
- charge **non nulle** → store **mémoire par défaut** si `store` omis ;
- auth **`proof` à montant zéro** → **aucune protection** sauf `store` explicite ;
- le store doit être un `Store.AtomicStore`, et **partagé** entre instances en multi-process.

### 3.3 Receipt (`Payment-Receipt`)

Source : <https://mpp.dev/protocol/receipts>. Objet JSON en base64url :

```json
{ "method": "tempo", "reference": "0x789abc…", "status": "success",
  "timestamp": "2025-01-15T12:00:00Z" }
```

Champs : `method`, `reference`, `status`, `timestamp` + optionnels `externalId`,
`subscriptionId`. Header **optionnel** côté protocole, mais c'est notre source d'audit :
`reference` = hash de transaction pour un règlement on-chain → **le `ledger/` le consomme**.

API SDK : `Receipt.from` / `Receipt.serialize` / `Receipt.deserialize` /
`Receipt.fromResponse` (`dist/Receipt.d.ts`).

---

## 4. Configuration testnet

**Réseau visé : Tempo Moderato (testnet).**

Source faisant autorité : `node_modules/mppx/dist/tempo/internal/defaults.js`.

| Clé | Mainnet | **Testnet (Moderato)** |
|---|---|---|
| Chain ID | `4217` | **`42431`** |
| RPC par défaut | `https://rpc.tempo.xyz` | **`https://rpc.moderato.tempo.xyz`** |
| Devise par défaut | USDC `0x20C000000000000000000000b9537d11c60E8b50` | **pathUSD `0x20c0000000000000000000000000000000000000`** |
| Contrat d'escrow | `0x33b901018174DDabE4841042ab76ba85D4e24f25` | `0xe1c4d3dce17bc111181ddf716f75bae49e61a336` |
| Décimales (TIP-20) | 6 | 6 |

Ces constantes sont **identiques** à celles du SDK Python (`pympp`) — recoupement fait lors
du premier passage de la phase 0, donc valeurs fiables.

Vérifié en direct contre le RPC le 2026-09-20 :

```
$ curl -s -X POST https://rpc.moderato.tempo.xyz \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"0xa5bf"}      # 0xa5bf == 42431 ✔
```

### 4.1 ⚠️ La seule façon correcte de basculer en testnet : `testnet: true`

**C'est le piège le plus dangereux du projet.** J'ai testé les quatre manières plausibles de
demander le testnet et comparé le `methodDetails.chainId` + la `currency` réellement émis
dans le Challenge. Résultats **mesurés** sur `mppx@0.10.1` :

| Configuration | `chainId` émis | `currency` émise | Verdict |
|---|---|---|---|
| `tempo.charge({})` | `4217` | USDC (mainnet) | mainnet cohérent — **défaut = argent réel** |
| **`tempo.charge({ testnet: true })`** | **`42431`** | **pathUSD** | ✅ **seul réglage cohérent** |
| `tempo.charge({ chainId: 42431 })` | `4217` ⚠️ | pathUSD | ❌ **incohérent** : chaîne mainnet, devise testnet |
| `mppx.charge({ chainId: 42431 })` (par route) | `42431` | USDC ⚠️ | ❌ **incohérent** dans l'autre sens |
| `tempo.charge({ rpcUrl: '…moderato…' })` | `4217` | USDC | ❌ sans effet sur le Challenge |

Protocole de mesure : un serveur Hono par cas, `app.request()` en mémoire, puis
`Challenge.deserialize(res.headers.get('WWW-Authenticate'))` et lecture de
`challenge.request`. Script : `smoke3.ts` (scratchpad de session).

**Conséquences pour le plan :**
1. **`testnet: true` partout**, jamais `chainId` seul. À vérifier par un test Vitest qui
   assert `methodDetails.chainId === 42431` **et** `currency === pathUSD` sur chaque route.
2. Le comportement de `chainId` seul ressemble à un **bug amont** (`wevm/mppx`) : il influence
   la résolution de devise mais pas le `chainId` du Challenge. À signaler en amont, mais
   **ne pas s'appuyer dessus** dans les deux cas.
3. Prévoir un garde-fou applicatif : refuser de démarrer si `chainId !== 42431`.

### 4.2 Approvisionner le wallet testnet — **résolu**

Le point resté ouvert avec Python est réglé : le paquet `mppx` embarque une CLI
(`bin: mppx`), déjà disponible via `npx mppx`. Sortie réelle de `npx mppx account fund --help` :

```
mppx account fund — Fund account with testnet tokens
Options:
  --account, -a <string>  Account name (env: MPPX_ACCOUNT)
  --network <testnet>     Tempo network
  --rpc-url, -r <string>  RPC endpoint (env: MPPX_RPC_URL)
```

`--network` n'accepte **que** `testnet` — impossible de « financer » du mainnet par erreur.

Séquence de mise en route (doc : <https://mpp.dev/sdk/typescript/cli>, recoupée avec
`npx mppx account --help`) :

```bash
npx mppx account create --account main
npx mppx account default --account main
npx mppx account fund --network testnet
npx mppx account view --account main
npx mppx account export --account main   # pour injecter la clé dans .env
```

### 4.3 Variables d'environnement (`.env`, gitignored)

| Variable | Qui la lit | Source |
|---|---|---|
| `MPP_SECRET_KEY` | `Mppx.create()` si `secretKey` omis | JSDoc `dist/server/Mppx.d.ts` |
| `MPP_REALM` | résolution du `realm` | idem (ordre : valeur explicite > `MPP_REALM`, `FLY_APP_NAME`, `VERCEL_URL`… > hostname de la requête > `"MPP Payment"`) |
| `PRIVATE_KEY` | `privateKeyToAccount(process.env.PRIVATE_KEY)` côté client/payeur | <https://mpp.dev/sdk/typescript/middlewares/hono> |
| `MPPX_ACCOUNT`, `MPPX_RPC_URL` | CLI `mppx` | `npx mppx account fund --help` |

**`secretKey` doit faire au moins 32 octets** — contrainte durcie dans le SDK, vérifiée :

```
Mppx.create({ …, secretKey: 'court' })
→ Error: Secret key must be at least 32 bytes.
  Generate one with `openssl rand -base64 32` and set …
```

On passera `realm` et `secretKey` **explicitement** : l'auto-détection d'environnement n'est
pas déterministe entre machine locale et CI.

---

## 5. API réelle de `mppx` (introspection + exécution)

Installé et vérifié dans ce dépôt :

```
$ npm install mppx viem hono
$ npm install -D typescript tsx vitest @types/node

mppx 0.10.1   (ESM, "type": "module", bin: mppx)
viem 2.56.8 · hono 4.13.8 · vitest 4.1.11 · tsx 4.23.15 · typescript 7.0.2
Node v20.20.1 · npm 10.8.2
```

Peer dependencies déclarées par `mppx` (npm) : `viem >=2.54.0`, `hono >=4.12.25`,
`express >=5`, `elysia >=1`, `next >=16.2.6`, `@modelcontextprotocol/sdk >=1.25.0`,
`@x402/*  >=2.22.0`. Seules celles des adaptateurs qu'on utilise sont requises.

### 5.1 Points d'entrée (`exports` du package)

`.`, `./client`, `./server`, `./server/core`, `./client/node`, `./tempo`, `./evm`,
`./stripe`, `./hono`, `./express`, `./elysia`, `./nextjs`, `./proxy`, `./cli`, `./html`,
`./discovery`, `./validation`, `./attestation`, `./mcp/client`, `./mcp/server`,
`./mcp-sdk/client`, `./mcp-sdk/server`, `./x402` (+ `./x402/hono|next|express|mcp`).

### 5.2 Types cœur — `mppx`

```ts
import { Challenge, Credential, Receipt, Expires, BodyDigest, Store, Errors, Method } from 'mppx'
```

Signatures **relevées dans les `.d.ts` installés** :

```ts
Challenge.from(parameters, options?)   // parameters exige SOIT `id`, SOIT `secretKey` (OneOf)
Challenge.serialize(challenge): string
Challenge.deserialize(value, options?)
Challenge.fromResponse(response) | fromHeaders(headers) | fromResponseList(...)
Challenge.verify(challenge, { secretKey }): boolean
Challenge.credentialHeader(challenge): string
Challenge.meta(challenge): Record<string,string> | undefined

Credential.from(...) | serialize | deserialize | fromRequest
Receipt.from(...)   | serialize | deserialize | fromResponse
Expires.seconds|minutes|hours|days|weeks|months|years(n): string   // ISO-8601
BodyDigest.compute / verify
```

⚠️ **`Challenge.from` lève si on ne fournit ni `id` ni `secretKey`** (`$ZodError` sur le champ
`id`). Le `secretKey` se met **dans `parameters`**, pas dans `options` — `options` ne porte
que `{ methods }`. Erreur commise et corrigée pendant la phase 0.

### 5.3 Serveur — `mppx/server` (et `mppx/hono`)

```ts
import { Mppx, tempo, Store, Expires, Response, Transport } from 'mppx/server'

const payment = Mppx.create({
  methods: [tempo.charge({ testnet: true, recipient, currency, decimals: 6 })],
  realm: 'api.local',
  secretKey: process.env.MPP_SECRET_KEY,
  requiresAuth: false,        // true ⇒ Challenge annonce header="Payment-Authorization"
  selectOffers,               // filtre les offres composées avant émission
  transport,                  // Transport.http() par défaut ; Transport.mcpSdk() pour MCP
})
```

⚠️ **Nommage différent du SDK Python** : côté TS c'est **`tempo.charge()`** (une fonction par
intent), là où `pympp` avait `tempo(intents={"charge": ChargeIntent()})`. Ne pas transposer.

L'instance renvoyée expose : les fonctions d'intent (`charge`, `session`, …), la forme
imbriquée `payment.tempo.charge(...)`, `payment.challenge.tempo.charge(...)`,
`compose`, `validateCredential`, `broadcastCredential`
(`verifyCredential` = alias rétrocompatible de `broadcastCredential`, à éviter), et les hooks.

Hooks serveur (source : <https://mpp.dev/sdk/typescript/server/Mppx.create>) :

```ts
payment.onChallengeCreated(({ challenge, request }) => …)
payment.onPaymentSuccess(({ receipt, request, requestInput }) => …)
payment.onPaymentFailed(({ challenge, error }) => …)
```

`onPaymentSuccess` reçoit `requestInput` : l'entrée serveur résolue **avant** les transforms
du schéma, **y compris les champs volontairement omis du Challenge**. C'est exactement ce
qu'il faut pour le `ledger/`.

Adaptateur Hono (`mppx/hono`) — chaque intent renvoie un `MiddlewareHandler` :

```ts
const app = new Hono()
const mppx = Mppx.create({ methods: [tempo.charge({ testnet: true })] })
app.get('/premium', mppx.charge({ amount: '1' }), (c) => c.json({ data: 'paid content' }))
```

Identification du payeur après paiement : le Credential est toujours sur la requête →
`Credential.deserialize(c.req.header('Authorization')!).source` → DID `did:pkh:eip155:…`.

### 5.4 Client — `mppx/client`

```ts
import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const mppx = Mppx.create({
  methods: [tempo({ account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`) })],
  polyfill: false,          // ⚠️ voir ci-dessous
  maxPaymentRetries: 3,     // défaut
  onChallenge,              // ← point d'accroche du budget guard
  paymentPreferences, orderChallenges, acceptPaymentPolicy, attestation, fetch, transport,
})
const res = await mppx.fetch('https://api.example.com/resource')
```

🚨 **`polyfill` vaut `true` par défaut** (`dist/client/Mppx.d.ts` : « Whether to polyfill
`globalThis.fetch` with the payment-aware wrapper. @default true »). Autrement dit,
`Mppx.create()` rend **tout** `fetch` du process capable de payer, y compris des appels qui
n'ont rien à voir. **Pour un agent avec budget guard c'est inacceptable** → toujours
`polyfill: false` + utiliser `mppx.fetch` explicitement. → À figer par un test.

Le hook **`onChallenge(challenge, { createCredential })`** est appelé à réception d'un 402 :
c'est **là** que le budget guard décide de payer ou non.

🚨 **Correction (phase 2) — renvoyer `undefined` ne refuse PAS le paiement.**
La première rédaction de cette section l'affirmait, par déduction depuis la doc
(« Called when a 402 challenge is received and no event handler supplies a
credential »). Le code dit le contraire —
`node_modules/mppx/dist/client/internal/Fetch.js` l. 153 :

```js
const credential = onChallengeCredential ?? (await createCredential())
```

`undefined` fait donc retomber le client sur la création de Credential **par
défaut**, et il paie. Mesuré : avec un `onChallenge` renvoyant `undefined`, le
client est allé jusqu'à la transaction on-chain — il n'a échoué que sur
`InsufficientBalance(available: 0, required: 500000)`, autrement dit un wallet
financé aurait payé.

**Pour refuser, il faut lever.** Une exception depuis `onChallenge` se propage
telle quelle hors de `mppx.fetch`, et aucune signature n'est demandée. Vérifié
dans les deux sens (`tests/agent/client.test.ts`).

Hooks d'observation : `onChallengeReceived`, `onCredentialCreated`,
`onPaymentFailed`, `onPaymentResponse` — chacun renvoie sa fonction de
désinscription. ⚠️ `onPaymentFailed` reçoit un `challenge` **optionnel**
(`client/internal/Fetch.d.ts`) : ne pas supposer qu'il est toujours là.

⚠️ Côté client, le constructeur est **`tempo({ account })`** (pas `tempo.charge()`).
Asymétrie client/serveur à ne pas confondre.

**Garde-fous natifs du client** (`dist/tempo/client/Charge.d.ts`), à utiliser en
plus du budget guard — ils agissent avant toute signature :

| Option | Effet |
|---|---|
| `expectedChainId` | rejette tout Challenge dont le `methodDetails.chainId` diffère |
| `allowedChainIds` | chaînes permises ; **omis = toutes**, tableau vide = aucune |
| `expectedRecipients` | liste blanche d'adresses ; s'applique aussi aux `splits` |
| `mode` | `'push'` (le client diffuse) / `'pull'` (le serveur diffuse) |

### 5.5 Stores (anti-rejeu) — `mppx` `Store`

`Store.memory()`, `Store.redis(client)`, `Store.upstash(redis)`, `Store.cloudflare(kv)`,
`Store.from(store)`, `Store.tryClaim(store, key, expires)` (`dist/Store.d.ts`).

**Pas de store SQLite fourni.** Deux besoins distincts à ne pas confondre :

| Besoin | Brique |
|---|---|
| Anti-rejeu des Credentials (exigence protocole) | `Store.AtomicStore` passé à `tempo.charge({ store })` — `Store.memory()` en dev, Redis/Upstash si multi-instance |
| Journal métier des transactions (`ledger/`) | **notre** code, SQLite via `node:sqlite` — indépendant de `mppx` |

### 5.6 Preuve de bout en bout (exécutée, sans réseau ni argent)

Serveur Hono monté en mémoire, requête via `app.request()` :

```
1. id explicite?          explicit-cha …
   round-trip id egal     true
   credentialHeader       Authorization
   Expires.minutes(5)     2026-09-20T13:45:28.179Z
2. verify bon secret      true
   verify mauvais secret  false
3. status                 402
   WWW-Authenticate       Payment id="B0rN7J1_1zPcao3u0mCNu86MdXjSDi9Uq6DjaJTf484",
                          realm="api.local", method="tempo", intent="charge", …
   Cache-Control          no-store
   Content-Type           application/problem+json
   request decode         {"amount":"500000","currency":"0x20c00000…0000",
                           "methodDetails":{"chainId":42431},
                           "recipient":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}
   HMAC verifie par nous  true
```

Ce qui est prouvé : sérialisation/désérialisation du Challenge, liaison HMAC (et son rejet
sur mauvais secret), émission d'un vrai 402 par le middleware Hono, en-têtes de sécurité
automatiques, conversion `'0.50'` → `'500000'` (6 décimales), et ancrage testnet
`chainId: 42431` + pathUSD. Script : `smoke.ts` (scratchpad de session) — **à convertir en
test Vitest dès la phase 1**.

---

## 6. Capacités du SDK TypeScript

Source : <https://mpp.dev/sdk/features>, recoupé avec l'arborescence installée.
**Le passage à TS lève toutes les limites qui bloquaient la version Python.**

| Fonctionnalité | Python (`pympp`) | **TypeScript (`mppx`)** |
|---|---|---|
| Intent `charge` | ✓ | ✓ |
| Intent `session` (pay-as-you-go) | ✗ | **✓** `dist/tempo/session/`, `mppx.session()` |
| Intent `subscription` | ✗ | **✓** `dist/tempo/server/Subscription.js` |
| Payload `proof` (montant zéro) | ✗ | **✓** `dist/tempo/Proof.js` |
| Streaming SSE facturé / WebSocket | ✗ | **✓** `session/server/Sse.js`, `Ws.js` |
| Proxy d'API existante | ✗ | **✓** `mppx/proxy` |
| Compatibilité x402 | — | **✓** `mppx/x402` (+ hono/next/express/mcp) |
| Transport MCP | ✓ | ✓ `mppx/mcp-sdk/server` |
| Paiements par carte (Stripe) | ✓ | ✓ `mppx/stripe` |
| Split payments, fee payer, memo d'attribution | partiel | ✓ |
| Rendu HTML de page de paiement | ✗ | **✓** `tempo.charge({ html: true })` |

**Conséquence pour le plan** : la marketplace n'est plus contrainte au modèle
« un paiement = une requête ». Sessions (facturation à l'usage) et abonnements sont
disponibles — ce qui ouvre des phases qui étaient hors de portée en Python.
Je recommande quand même de **commencer par `charge`** et de n'ajouter `session` qu'une fois
le flux nominal couvert par des tests.

---

## 7. Écarts doc ↔ SDK installé

Bien moins nombreux qu'en Python (où la doc documentait un décorateur `@requires_payment`
inexistant et un constructeur `Credential` faux). Sur `mppx@0.10.1` :

1. ✅ Doc et SDK concordent sur `Mppx.create`, `tempo.charge`, les hooks, l'adaptateur Hono
   et la CLI — vérifié par exécution.
2. ⚠️ `verifyCredential` : la doc le dit « deprecated alias » de `broadcastCredential` ;
   le `.d.ts` est plus tiède (« retained as a backwards-compatible alias »), sans balise
   `@deprecated`. Dans les deux cas, utiliser `validateCredential` (non mutant) /
   `broadcastCredential` (mutant) — pas `verifyCredential`.
3. ⚠️ `tempo.charge({ chainId })` ne se propage pas au Challenge (§4.1) — comportement non
   documenté, mesuré. À traiter comme un bug amont.

---

## 8. Sécurité — à appliquer dès la phase 1

Source : <https://mpp.dev/advanced/security>.

- `MPP_SECRET_KEY` = **matériel racine de confiance**. Qui l'obtient peut forger des
  Challenges qui paraissent émis par notre `realm`. Jamais en dur, jamais dans git, jamais
  dans une image, une clé **par environnement**. ≥ 32 octets (imposé par le SDK) :
  `openssl rand -base64 32`.
- **Ne jamais logger** : `MPP_SECRET_KEY`, `Authorization: Payment`,
  `Payment-Authorization: Payment`, `Payment-Receipt`. Ni en logs, ni en traces, ni en
  messages d'erreur. Journaliser à la place : request id, challenge id, status, method.
  **Impact direct : le `ledger/` stocke des références, pas des Credentials.**
- `Cache-Control: no-store` sur les 402 (✅ `mppx` le fait seul, §5.6) ;
  `Cache-Control: private` sur les 200 porteuses d'un `Payment-Receipt` (**à notre charge**).
- **Lier le corps de requête** : `digest` obligatoire pour `POST`/`PUT`/`PATCH`, sinon le
  client peut changer le corps après avoir reçu le Challenge → `BodyDigest.compute/verify`.
- `description` est du texte d'affichage : **jamais** une entrée d'autorisation.
- Rotation de `MPP_SECRET_KEY` avec recouvrement (émettre avec la nouvelle, vérifier
  l'ancienne pendant une fenêtre ≥ TTL des Challenges).
- Spécifique agent : `polyfill: false` (§5.4), sinon le budget guard est contournable par
  n'importe quel `fetch` du process.

---

## 9. Décisions retenues

| # | Décision | Motif |
|---|---|---|
| D1 | SDK = **`mppx`** (TypeScript), Node ≥ 20, ESM | choix utilisateur ; `mppx` est l'officiel TS (§0) |
| D2 | Serveur = **Hono** via `mppx/hono` | adaptateur natif, le plus proche de FastAPI — **à confirmer** (§0.1) |
| D3 | Testnet = **`tempo.charge({ testnet: true })`**, jamais `chainId` seul | seul réglage cohérent, mesuré (§4.1) |
| D4 | Garde-fou : test qui assert `chainId === 42431` **et** `currency === pathUSD` | le défaut du SDK est le mainnet (§4.1) |
| D5 | Client agent : **`polyfill: false`** + `mppx.fetch` explicite | sinon le budget guard est contournable (§5.4) |
| D6 | Budget guard implémenté dans le hook **`onChallenge`** | seul point où l'on peut refuser de payer avant signature (§5.4) |
| D7 | Anti-rejeu = `Store.memory()` en dev, Redis si multi-instance ; **SQLite réservé au `ledger/` métier** | `mppx` n'a pas de store SQLite (§5.5) |
| D8 | `ledger/` alimenté par `onPaymentSuccess` (champ `requestInput`) + `Payment-Receipt` | découplage du chemin métier (§5.3) |
| D9 | `realm` et `secretKey` passés **explicitement** | auto-détection non déterministe local/CI (§4.3) |
| D10 | Commencer par l'intent **`charge`** ; `session` plus tard | réduire la surface avant d'avoir des tests verts (§6) |

## 10. Points ouverts avant la phase 1

1. **`PLAN.md` est absent** — les phases 1→8 ne sont définies nulle part. *Bloquant.*
2. **`CLAUDE.md` à réécrire** : stack Python → TypeScript (§0.1), et « SQLite (ledger) »
   à préciser (ledger métier, pas store `mppx`).
3. **Confirmer Hono** plutôt qu'Express / Elysia / Next.js.
4. **Le dépôt n'est pas un dépôt git** — or la règle projet est « une phase = une branche ».
   `git init` + `.gitignore` (`.env`, `node_modules/`, `.venv/`) à faire avant la phase 1.
5. **Reliquat Python à supprimer** : `.venv/` (≈ environnement `pympp` de la première passe).
6. Signaler en amont (`wevm/mppx`) le comportement de `chainId` décrit en §4.1.

---

## Annexe — sources consultées

**Doc** (récupérée en Markdown brut via `curl https://mpp.dev/<path>` ; ⚠️ les URL dont le
dernier segment contient un point — `Mppx.create` — renvoient du HTML : passer par
`llms-full.txt`) :

- <https://mpp.dev/protocol/http-402>, `/protocol/challenges`, `/protocol/credentials`,
  `/protocol/receipts`, `/protocol/transports/http`
- <https://mpp.dev/payment-methods/tempo/charge>
- <https://mpp.dev/advanced/security>
- <https://mpp.dev/sdk/typescript/>, `/sdk/typescript/middlewares/hono`, `/sdk/typescript/cli`
- <https://mpp.dev/sdk/features>
- <https://mpp.dev/quickstart/server>, <https://mpp.dev/quickstart/agent>
- <https://mpp.dev/llms-full.txt> (32 721 lignes — **la source la plus complète**, contient
  les sections `Mppx.create` serveur (l. 23884) et client (l. 19005), `Method.tempo.charge`
  (l. 21639), `Response.requirePayment` (l. 24886))
- Spécification IETF : <https://paymentauth.org>
- MCP de doc officiel : `search_docs` sur `https://mpp.dev/api/mcp`

**Code lu** (`node_modules/mppx/dist/`) :

- `tempo/internal/defaults.{d.ts,js}` — **constantes réseau (source de vérité testnet)**
- `tempo/server/Charge.d.ts` — options de `tempo.charge()` (`testnet`, `store`, `relay`,
  `feePayerPolicy`, `sponsorBudget`, `waitForConfirmation`, `validateSender`…)
- `tempo/Methods.d.ts` — schéma zod du `request` et union des payloads de Credential
- `tempo/server/index.d.ts`, `tempo/index.d.ts` — inventaire des intents disponibles
- `server/Mppx.d.ts` — `create.Config`, contrainte 32 octets sur `secretKey`, ordre de
  résolution du `realm`
- `client/Mppx.d.ts` — `create.Config`, **`polyfill` @default true**, `onChallenge`
- `Challenge.d.ts`, `Credential.d.ts`, `Receipt.d.ts`, `Expires.d.ts`, `Store.d.ts`
- `package.json` (exports, bin, peerDependencies)
- CLI : `npx mppx account --help`, `npx mppx account fund --help`
- Dépôt amont : <https://github.com/wevm/mppx>

**Scripts exécutés** (scratchpad de session, à porter en tests Vitest) :
`smoke.ts` (aller-retour Challenge + HMAC + 402 Hono réel),
`smoke2.ts` / `smoke3.ts` (matrice testnet du §4.1, garde-fou `secretKey`).
