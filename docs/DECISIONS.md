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
