# DECISIONS — journal des décisions d'architecture

Format : une décision = contexte, choix, conséquence. Les décisions issues de
la phase 0 sont sourcées dans `docs/NOTES.md`.

---

## D1 — SDK `mppx` (TypeScript) plutôt que `pympp` (Python)
**Phase 0 · révisée après changement de stack**

`CLAUDE.md` annonçait « SDK mppx officiel (Python) ». C'était contradictoire :
`mppx` est le SDK **TypeScript**, le SDK Python s'appelle `pympp`. Le projet a
basculé en TypeScript, ce qui rend `mppx` correct.

**Conséquence** : stack Node ≥ 20 / ESM. Toutes les limites de `pympp`
(pas de `session`, pas de `subscription`, pas de `proof`, pas de proxy)
disparaissent — voir NOTES §6.

---

## D2 — Hono comme framework serveur
**Phase 1**

`mppx` fournit des adaptateurs natifs pour Elysia, Express, Hono et Next.js.
Hono est le plus proche de FastAPI (léger, typé, middleware par route) et son
`app.request()` permet de tester l'application en mémoire, sans ouvrir de port.

**Conséquence** : les tests de la phase 1 exercent le vrai pipeline HTTP sans
réseau. `@hono/node-server` n'est utilisé qu'au point d'entrée.

---

## D3 — `testnet: true`, jamais `chainId` seul
**Phase 0 · mesurée**

Mesure de phase 0 (NOTES §4.1) : `tempo.charge({ chainId: 42431 })` émet un
Challenge annonçant `chainId: 4217` (**mainnet**) avec une devise testnet.
`mppx.charge({ chainId })` au niveau route produit l'incohérence inverse.
Seul `testnet: true` aligne chaîne et devise.

**Conséquence** : `testnet: true` est le seul réglage autorisé, doublé de deux
garde-fous (`MPP_NETWORK` au chargement, `assertTestnetChallenge` à l'exécution)
et d'un auto-test au démarrage. Le coût d'une erreur ici, c'est de l'argent réel.

---

## D4 — Deux garde-fous plutôt qu'un
**Phase 1**

Un seul contrôle (la config) ne protège pas d'une régression du SDK ou d'un
changement de défaut en amont. On valide donc aussi le Challenge **réellement
émis**, à chaud, au démarrage.

**Conséquence** : `selfCheck()` bloque l'ouverture du port si le Challenge
n'est pas ancré sur 42431 + pathUSD.

---

## D5 — SQLite réservé au ledger métier
**Phase 0**

`mppx` n'expose pas de store SQLite (`Store.memory`, `redis`, `upstash`,
`cloudflare` uniquement). Deux besoins distincts :

| Besoin | Brique |
|---|---|
| Anti-rejeu des Credentials (protocole) | `Store.AtomicStore` passé à `tempo.charge({ store })` |
| Journal d'audit métier | notre code, `node:sqlite` |

**Conséquence** : ne pas confondre les deux en phase 3.

---

## D6 — Service de recherche factice en phase 1
**Phase 1**

L'objet de la phase 1 est le flux de paiement. Un moteur réel introduirait des
dépendances et de la latence sans rien prouver sur le 402.

**Conséquence** : `server/search.ts` est déterministe et sans I/O. La **forme**
de la réponse est stable ; l'implémentation sera remplacée plus tard.

---

## D7 — Refuser un paiement se fait en levant, pas en renvoyant `undefined`
**Phase 2 · mesurée · corrige une erreur de la phase 0**

`NOTES.md` §5.4 affirmait d'abord que renvoyer `undefined` depuis `onChallenge`
revenait à ne pas payer — déduction depuis la formulation de la doc. Le code dit
le contraire (`client/internal/Fetch.js` l.153) :
`const credential = onChallengeCredential ?? (await createCredential())`.

Mesuré : avec `onChallenge` renvoyant `undefined`, le client va jusqu'à la
transaction on-chain et n'échoue que sur solde nul. Un wallet financé aurait payé.

**Conséquence** : `BudgetDenied` est une exception, jamais une valeur de retour.
Deux tests verrouillent l'invariant (aucun appel à `createCredential` sur refus,
aucune requête rejouée). `NOTES.md` a été corrigé.

---

## D8 — Budget guard pur, séparé du client
**Phase 2**

La logique qui autorise une dépense ne dépend ni du réseau, ni du SDK, ni d'un
wallet. `agent/budget.ts` n'importe que le type `Challenge`.

**Conséquence** : 26 tests exhaustifs en 15 ms, dont les cas tordus (montant
absent, chaîne absente, concurrence). Le handler `onChallenge` est extrait en
`createChallengeHandler(guard)` pour être testable avec un `createCredential`
injecté — c'est ce qui permet de couvrir le chemin « autorisé » sans payer.

---

## D9 — Réserver à l'autorisation, confirmer au paiement
**Phase 2**

Décompter la dépense seulement à la confirmation laisse passer deux appels
concurrents qui franchissent ensemble le plafond. On engage donc le montant dès
l'autorisation ; `remaining = total − committed − reserved`.

**Conséquence** : en cas d'issue inconnue, l'engagement reste engagé.
Sur-compter arrête l'agent trop tôt ; sous-compter le fait trop dépenser.
Seule la première erreur est tolérable.

---

## D10 — Montants en `bigint`, jamais en `number`
**Phase 2**

Les montants MPP sont des unités de base en chaîne de caractères. Toute
conversion passe par `agent/amount.ts` en arithmétique entière. Plus de
décimales que le jeton n'en a ⇒ **refus**, jamais arrondi.

**Conséquence** : un arrondi silencieux sur un montant est une perte d'argent
sans trace. Le refus est bruyant, donc réparable.

---

## D11 — `better-sqlite3` plutôt que `node:sqlite`
**Phase 3 · corrige `CLAUDE.md`**

`CLAUDE.md` annonçait « SQLite via `node:sqlite` ». Ce module built-in n'existe
qu'à partir de **Node 22.5** ; le projet cible Node ≥ 20 et la machine tourne en
20.20.1 — `require('node:sqlite')` renvoie `ERR_UNKNOWN_BUILTIN_MODULE`.

**Conséquence** : `better-sqlite3` (binaire précompilé, API synchrone). Sa
synchronicité est un avantage ici : les handlers serveur mppx s'exécutent en
ligne sur le chemin de la requête payante, donc pas de file d'attente à gérer.
`CLAUDE.md` est corrigé.

---

## D12 — L'id de Challenge n'identifie pas une requête : compteur `occurrences`
**Phase 3 · mesurée**

L'id de Challenge est un HMAC de ses paramètres, donc une fonction pure. Entre
deux requêtes identiques, seul `expires` varie — à la milliseconde. Mesuré :
**19 collisions sur 50 requêtes rapides** sur le provider de la phase 1.

Un journal indexé sur `challenge_id` fusionne donc des requêtes distinctes.
C'est ce qui a rendu un test flaky avant d'être compris.

**Conséquence** : `challenge_id` reste la clé primaire (dédupliquer est correct
au niveau protocole), mais une colonne `occurrences` compte les émissions, et la
réconciliation multiplie par elle. Deux écritures distinctes en découlent :
`recordChallenge` (compte) pour `onChallengeCreated`, `ensureChallenge` (ne
compte pas) pour les chemins success/failed — sinon l'insertion défensive de ces
derniers gonfle le compteur.

À retenir pour la phase 6 : une requête à Credential invalide émet **deux**
Challenges (le soumis + le retry). `occurrences` compte des émissions, pas des
requêtes HTTP.

---

## D13 — Le ledger stocke des références, jamais des preuves
**Phase 3**

Le schéma n'offre aucune colonne où loger un Credential, un Receipt brut ou du
texte libre — messages d'erreur compris, car `PaymentError.details` peut
contenir un Credential ou un hash. On stocke l'id de Challenge, le hash de
transaction, le DID du payeur et le code d'erreur normalisé.

**Conséquence** : la fuite est structurellement impossible, pas seulement
évitée par discipline. Deux tests le verrouillent, dont un qui lit le fichier
SQLite en binaire.

---

## D14 — DeepSeek au lieu d'Anthropic
**Phase 4 · corrige `CLAUDE.md`**

Pas de crédit Anthropic disponible. DeepSeek expose une API **compatible
OpenAI** (`base_url = https://api.deepseek.com`, SDK `openai`), avec tool
calling au format standard — vérifié par appel réel avant d'écrire la moindre
ligne, ainsi que la liste des modèles (`deepseek-flash`, `deepseek-v4-pro`) via
`GET /models`.

**Conséquence** : `CLAUDE.md` corrigé. Le mode « thinking » de DeepSeek est
désactivé par défaut : il consomme des tokens de raisonnement sans bénéfice
pour une boucle d'outils cadrée.

---

## D15 — L'agent parle à un port, pas à un SDK
**Phase 4**

`agent/llm.ts` définit `LlmClient { turn(messages, tools) }`. Le reste de
l'agent ne connaît que ce type ; le SDK OpenAI ne vit que dans
`createLlm`.

**Conséquence** : la boucle se teste avec un modèle scripté, sans réseau ni
crédit consommé en CI (29 tests). Changer de fournisseur ne touche pas la
logique. Le transport `fetch` est lui aussi injectable, ce qui permet de tester
la traduction vers Chat Completions.

---

## D16 — Un refus du guard est un `tool_result`, pas une exception
**Phase 4**

Si le refus remontait en exception, la boucle casserait et le modèle n'aurait
aucun moyen d'en tenir compte. L'exécuteur renvoie donc `{ ok: false, code,
message, hint, retryable }`, et un refus non réessayable coupe l'outil pour le
tour suivant.

**Conséquence, observée en vrai** : sur budget insuffisant, le modèle conclut
en deux tours en signalant explicitement la limite ; sur panne technique
(`retryable: true`), il retente une fois puis conclut. Le `hint` porte
l'instruction, pas seulement le diagnostic.

---

## D17 — Le contexte du modèle est une frontière de sécurité
**Phase 4**

Ne remontent au modèle que les données achetées, le montant dépensé et le
budget restant. Les **messages d'erreur bruts** sont retenus au même titre que
les Credentials : une panne de signature peut contenir un hash de transaction
ou un Credential. Le modèle reçoit un `search-unavailable` générique.

**Conséquence** : un test balaie tous les messages transmis et y cherche tout
motif `0x` + 64 hex, tout `Authorization`, tout Credential.

---

## D18 — L'e2e vérifie les fonds, pas seulement le Receipt
**Phase 5**

Un Receipt est déclaratif : le serveur affirme que le paiement a eu lieu. Le
test relit donc le solde pathUSD du destinataire **avant et après**, et exige
un delta exactement égal au prix — puis confirme la transaction par
`eth_getTransactionReceipt`.

**Conséquence** : payeur et destinataire sont deux comptes distincts
(`agent` et `provider`), sinon le delta ne prouverait rien.

---

## D19 — Les tests qui dépensent sont isolés et auto-ignorés
**Phase 5**

`*.e2e.test.ts` est exclu de `npm test` et lancé par `npm run test:e2e`. En
l'absence de `AGENT_PRIVATE_KEY`, le test s'ignore au lieu d'échouer.

**Conséquence** : la CI ne dépense rien et ne casse pas faute de wallet.
`loadDotEnv` reste cantonné aux tests e2e : les tests unitaires ne dépendent
d'aucun secret ni d'aucun fichier local, et ne doivent pas commencer à le faire.
