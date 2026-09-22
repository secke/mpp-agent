# E2E testnet — le paiement réel

**Phase 5** · Code : `tests/e2e/payment.e2e.test.ts`, `tests/e2e/loadEnv.ts`

## Ce que ça prouve

Un paiement complet, de bout en bout, avec de vrais jetons sur **Tempo
Moderato** — la seule chose que les phases 1 à 4 ne pouvaient pas démontrer.

```bash
npm run test:e2e
```

Le test est **exclu du run par défaut** (`npm test`) et s'auto-ignore si
`AGENT_PRIVATE_KEY` n'est pas configurée : la CI ne doit ni dépenser des fonds
ni échouer faute de wallet.

## La chaîne vérifiée

| Étape | Assertion |
|---|---|
| Réponse | `200`, contenu non vide |
| Payeur | `payer === did:pkh:eip155:42431:<adresse de l'agent>` |
| Receipt | `Payment-Receipt` présent, `status: success`, `reference` = hash 0x+64 |
| Budget | `guard.committed` égale exactement le prix |
| Ledger | ligne `success`, `reference` identique à celle du Receipt |
| On-chain | `eth_getTransactionReceipt` → `status: 0x1`, `from` = agent, `to` = pathUSD |
| Fonds | le solde pathUSD du destinataire a augmenté **exactement** du prix |
| Anti-rejeu | le même Credential resservi → **402** |

Le contrôle des fonds est le plus important : il ne se contente pas de croire
le Receipt, il relit le solde on-chain avant et après et vérifie le delta.

## Mesure réelle

```
outil   : search_marketplace({"query": "protocole MPP définition"}) → ✓ payé
arrêt   : completed en 2 tour(s)      dépense : 0.5 / reste 9.5
```

Ledger :

```
status    amount    reference                                  payer
success   500000    0x554b601913629aa7fef5c78afb48f8a2972e…    did:pkh:eip155:42431:0x6F57…5338
```

Transaction confirmée :

```
status      : 0x1 (succès)          bloc : 36470584
from        : 0x6f57…5338 (agent)   to   : 0x20c0…0000 (pathUSD)
gas utilisé : 46695
transfert   : 0.500000 pathUSD  →  0xc249…7d29 (provider)
```

Soldes : le provider gagne **+0,500000**, l'agent perd **0,500900** — le prix
plus 0,0009 pathUSD de frais. Sur Tempo, le gas se paie **dans le jeton**, pas
en monnaie native : c'est pourquoi l'agent n'a besoin que de pathUSD.

## L'anti-rejeu

C'est la propriété de sécurité qui distingue un vrai paiement d'une démo. Le
test capture le Credential réellement envoyé (en interceptant l'en-tête
`Authorization` dans le `fetch` injecté), puis le rejoue tel quel sur la même
route. Le serveur répond **402** avec un Challenge frais.

Protection assurée par le `store` de `tempo.charge` : par défaut un store
mémoire pour les charges non nulles
(`node_modules/mppx/dist/tempo/server/Charge.d.ts`). ⚠️ **En multi-instance,
ce défaut ne suffit pas** — il faut un `Store.AtomicStore` partagé (Redis).
C'est au programme de la phase 8.

## Préparation d'un wallet

```bash
npx mppx account create --account agent
npx mppx account fund --network testnet --account agent
npx mppx account export --account agent     # → AGENT_PRIVATE_KEY dans .env

npx mppx account create --account provider  # → MPP_RECIPIENT
openssl rand -base64 32                     # → MPP_SECRET_KEY
```

Payeur et destinataire sont **deux comptes distincts** : sans ça, le contrôle
de delta de solde ne prouverait rien.

## Détails qui comptent

- **`loadDotEnv` est cantonné aux tests e2e.** Vitest n'applique pas le
  `--env-file` de Node. Les tests unitaires, eux, ne dépendent d'aucun secret
  ni d'aucun fichier local — et ne doivent pas commencer à le faire.
- **Un seul paiement par exécution.** Chaque passage dépense réellement ;
  le test reste minimal à dessein.
- **Aucun port ouvert** : l'app est montée en mémoire via `app.fetch`, seul le
  RPC Tempo est appelé pour de vrai.

## Tests

1 test e2e, 8 familles d'assertions. Exécuté deux fois d'affilée (deux
paiements réels distincts), vert les deux fois.
