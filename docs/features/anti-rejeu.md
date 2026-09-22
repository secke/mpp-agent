# Anti-rejeu — stores partagés et durables

**Phase 8** · Code : `server/stores.ts`, `server/redis-client.ts`, `server/bootstrap.ts`
· Tests : `tests/server/stores.test.ts`

## Le problème

`tempo.charge` retombe sur un store **mémoire** quand on ne lui en passe pas :

> « Non-zero charge flows default to an in-memory store if omitted. »
> — `node_modules/mppx/dist/tempo/server/Charge.d.ts`

Ce défaut a deux angles morts :

| Angle mort | Conséquence |
|---|---|
| **Multi-processus** | deux instances ne partagent pas leur mémoire : le même Credential passe une fois par instance |
| **Redémarrage** | les marqueurs sont perdus : un Credential redevient rejouable tant que son Challenge n'a pas expiré |

Le second est le plus insidieux — il touche **même un déploiement
mono-instance**, et un simple `systemctl restart` suffit à rouvrir la fenêtre.

## La parade

Deux implémentations du contrat `Store.AtomicStore`, choisies par `REPLAY_STORE` :

| Support | Partagé | Durable | Pour |
|---|---|---|---|
| `memory` (défaut mppx) | ✗ | ✗ | jamais en production |
| **`sqlite`** (notre défaut) | entre processus d'une machine | ✓ | mono-hôte |
| `redis` | entre machines | ✓ | multi-hôte |

**Le store mémoire ne peut plus être choisi par accident** : `loadConfig`
refuse de démarrer sans `REPLAY_STORE_MEMORY_ACK=i-know`.

## Ce qui porte la garantie

`tryClaim(key, expires)` — « vrai si cet appel a posé la clé, faux si elle
existait déjà et n'a pas expiré ». Tout repose sur son atomicité.

- **SQLite** : `insert or ignore` — une seule instruction SQL, donc aucune
  fenêtre TOCTOU entre le test d'existence et l'écriture.
- **Redis** : `SET key value NX PX ttl` — atomique côté serveur.

`update` (lecture-modification-écriture) est atomique en SQLite via une
transaction. ⚠️ Côté Redis il est **émulé** par get puis set, donc non
atomique entre instances — c'est documenté dans le code. Pour l'anti-rejeu
seul `tryClaim` compte, et lui l'est ; c'est pourquoi il est fourni
explicitement plutôt que laissé au repli de mppx.

## Le client Redis

~100 lignes de RESP sur TCP (`server/redis-client.ts`), **sans dépendance**.
Quatre commandes suffisent : `GET`, `SET`, `DEL`, `SET … NX PX`. Les commandes
sont sérialisées — une réponse à la fois, dans l'ordre.

Ça évite d'embarquer un client complet pour quatre verbes, et ça allégera
l'image Docker en phase 7.

## Tests

Un **contrat commun** exécuté contre les trois supports : ce qui rend les
implémentations réellement interchangeables plutôt que « probablement
équivalentes ». Le contrat couvre get/put/delete, les trois branches d'`update`,
et surtout :

- `tryClaim` réussit **une fois et une seule** ;
- 20 `tryClaim` concurrents sur la même clé → **un seul gagnant** ;
- la clé redevient revendicable une fois le marqueur expiré ;
- les clés sont isolées.

Le Redis est un **vrai serveur** (conteneur Docker), pas un faux.

Trois tests ciblent explicitement les angles morts du store mémoire :
persistance après « redémarrage » (fermeture puis réouverture du fichier),
partage entre deux connexions, et — par contraste — la démonstration que deux
stores mémoire **ne partagent rien**.

## Vérifié en conditions réelles

Le test e2e de la phase 5 utilise désormais `createReplayStore(config)`, le
**même câblage qu'en production** — un test qui monterait un store différent
ne prouverait rien sur ce qui tourne. Après un paiement réel :

```
1 marqueur(s) enregistré(s)
  mppx:charge:0xc1d44afc1fa6ece0a013076e5046a748e09d1596edade5 | expire 2026-09-22T22:39:46Z
```

Le marqueur est **sur le disque**, donc il survit au redémarrage.

## Deux pièges rencontrés

- **`tryClaim` peut être synchrone.** Son type est `MaybePromise<boolean>` et
  le store mémoire de mppx répond sans promesse. Le contrat normalise avec
  `Promise.resolve` au lieu de supposer.
- **Tester l'expiration avec un `expires` déjà passé ne prouve rien** :
  chaque support le clampe à sa façon (SQLite purge, Redis force un TTL
  minimal d'1 ms). Le contrat pose un TTL court mais réel, puis attend.
