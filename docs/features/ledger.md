# Ledger — journal d'audit des paiements

**Phase 3** · Code : `ledger/schema.sql`, `ledger/db.ts`, `ledger/record.ts`
· Tests : `tests/ledger/record.test.ts`, `tests/ledger/integration.test.ts`

## Ce que ça fait

Une ligne SQLite par Challenge, mise à jour au fil de son destin :

```
onChallengeCreated  →  status = 'challenged'
onPaymentSuccess    →  status = 'success'  + reference (hash de tx) + payer (DID)
onPaymentFailed     →  status = 'failed'   + error_code MPP normalisé
```

Branché hors du chemin métier :

```ts
const ledger = new Ledger(openLedger('data/ledger.sqlite'))
attachLedger(payment, ledger)
```

## Ce qui n'y entre jamais

C'est la contrainte structurante. `docs/NOTES.md` §8 interdit de journaliser
`MPP_SECRET_KEY`, les en-têtes `Authorization: Payment` /
`Payment-Authorization: Payment`, et `Payment-Receipt`. On y ajoute les
**messages d'erreur** : `PaymentError` porte un champ `details` qui peut
contenir un Credential ou un hash de transaction.

Le schéma rend la fuite structurellement impossible : il n'existe aucune
colonne où loger un Credential, un Receipt brut ou du texte libre. On stocke
des **références** : id de Challenge, hash de transaction, DID du payeur, code
d'erreur normalisé.

Deux tests verrouillent ça :
- un test lit le **fichier SQLite en binaire** et vérifie l'absence du secret,
  du Credential envoyé, de `Payment-Receipt`, de `Authorization` et de tout
  motif ressemblant à une clé privée (`0x` + 64 hex) ;
- un test assert la **liste exacte des colonnes**, pour qu'aucune colonne
  sensible ne puisse être ajoutée sans casser le test.

Le premier comporte une garde anti-test-vide : il vérifie d'abord que la base
contient bien des écritures, sinon les assertions négatives passeraient pour
rien.

## 🔍 L'id de Challenge n'identifie pas une requête

Découverte de cette phase, et elle change la conception.

L'id est un HMAC de `realm | method | intent | request | expires | digest |
opaque`. C'est une **fonction pure** : deux Challenges aux termes identiques
donnent le même id. Or le seul terme qui varie entre deux requêtes identiques
est `expires`, à la milliseconde. Mesuré sur le provider :

```
50 requêtes rapides → 31 ids distincts (19 collisions)
```

Un journal indexé sur `challenge_id` **fusionne donc des requêtes distinctes**
et sous-estime le trafic. C'est exactement ce qui a rendu un test flaky avant
d'être compris.

**La réponse** : garder `challenge_id` en clé primaire — c'est l'identité
protocolaire, et dédupliquer est correct — mais ajouter un compteur
`occurrences`. La réconciliation multiplie par lui :

```sql
sum(cast(amount as integer) * occurrences) as total_base_units
```

Deux opérations d'écriture distinctes en découlent :

| Méthode | Appelée par | Effet sur `occurrences` |
|---|---|---|
| `recordChallenge` | `onChallengeCreated` | **incrémente** |
| `ensureChallenge` | `onPaymentSuccess`, `onPaymentFailed` | aucun |

Sans cette séparation, l'insertion défensive des chemins résolus gonflait le
compteur. C'est le second bug qu'a révélé le test.

⚠️ À retenir pour la phase 6 : **une requête portant un Credential invalide
émet deux Challenges** (celui soumis, puis le retry frais exigé par la spec).
`occurrences` compte des émissions de Challenge, pas des requêtes HTTP.

## Vues de réconciliation

```sql
select * from ledger_reconciliation;
-- status | entries | occurrences | total_base_units | first_at | last_at

select * from ledger_unsettled;
-- Challenges émis jamais résolus : le cas normal (un client peut ne pas payer),
-- mais un volume anormal signale un prix mal calibré ou un client cassé.
```

## Détails qui comptent

- **Les montants sont stockés en TEXTE.** Ce sont des unités de base, donc
  potentiellement des grands entiers ; le `REAL` de SQLite perdrait de la
  précision. Le `cast(... as integer)` n'intervient que dans les vues
  d'agrégation, où pathUSD tient largement dans un int64.
- **Un paiement abouti ne régresse jamais.** Les `update` portent une garde
  `where status != 'success'`, donc un `onPaymentFailed` tardif ne peut pas
  effacer un encaissement.
- **Les écritures sont synchrones.** Les handlers serveur s'exécutent en ligne
  sur le chemin de la requête payante ; `better-sqlite3` étant synchrone par
  conception, on évite d'introduire une file d'attente. Les requêtes sont
  préparées une seule fois, à la construction.
- **Les routes gratuites ne journalisent rien** — vérifié par test sur
  `/healthz` et `/openapi.json`.

## `better-sqlite3`, pas `node:sqlite`

`CLAUDE.md` annonçait `node:sqlite`. Ce module n'existe qu'à partir de
**Node 22.5** ; le projet cible Node ≥ 20 et la machine tourne en 20.20.1
(`require('node:sqlite')` → `ERR_UNKNOWN_BUILTIN_MODULE`). On utilise
`better-sqlite3`, qui s'installe avec un binaire précompilé.
`CLAUDE.md` est corrigé. Voir [`DECISIONS.md` D11](../DECISIONS.md).

## Tests

20 tests : écriture et transitions d'état, idempotence, compteur
d'occurrences, non-régression d'un succès, codes d'erreur normalisés,
réconciliation, Challenges sans suite, intégration avec le vrai provider
(route capturée depuis `opaque`, routes gratuites ignorées), et les deux
tests anti-fuite.

Suite exécutée 8 fois d'affilée après correction pour écarter la flakiness.
