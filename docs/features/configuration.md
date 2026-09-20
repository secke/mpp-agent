# Configuration et garde-fou réseau

**Phase 1** · Code : `server/config.ts` · Tests : `tests/server/config.test.ts`

## Ce que ça fait

Charge la configuration depuis l'environnement, la valide strictement, et
**refuse de démarrer** si quoi que ce soit cloche. Aucune valeur par défaut
silencieuse sur ce qui touche à l'argent.

## Pourquoi

Le défaut du SDK `mppx` est le **réseau principal** (voir
[`NOTES.md` §4.1](../NOTES.md)). Une variable oubliée ne doit pas se traduire
par un paiement réel. La règle du projet est « testnet uniquement » : on la
rend mécanique plutôt que déclarative.

## Variables

| Variable | Requis | Défaut | Validation |
|---|---|---|---|
| `MPP_SECRET_KEY` | ✅ | — | ≥ 32 octets (imposé par `mppx`) |
| `MPP_RECIPIENT` | ✅ | — | adresse `0x` de 40 hex |
| `MPP_REALM` | — | `localhost` | — |
| `MPP_SEARCH_PRICE` | — | `0.50` | montant lisible, ≤ 6 décimales |
| `PORT` | — | `8787` | entier 1–65535 |
| `MPP_NETWORK` | — | `testnet` | **doit valoir `testnet`** |

Modèle : [`.env.example`](../../.env.example). `.env` est gitignored.

## Utilisation

```bash
cp .env.example .env
openssl rand -base64 32                      # -> MPP_SECRET_KEY
npx mppx account create --account main
npx mppx account fund --network testnet
npx mppx account view --account main         # -> MPP_RECIPIENT
npm run dev
```

`npm run dev` passe par `node --env-file=.env` : natif depuis Node 20.6,
donc pas de dépendance `dotenv`.

## Détails qui comptent

- **`MPP_NETWORK` est un cran d'arrêt.** Toute valeur autre que `testnet` fait
  échouer `loadConfig`, avec un message explicite. Il n'existe pas de chemin
  de code qui passe en mainnet.
- **Le prix est validé par expression régulière** `^\d+(\.\d{1,6})?$` :
  la notation scientifique (`1e-3`) et les montants à plus de 6 décimales sont
  rejetés, parce que `mppx` convertit en unités de base avec 6 décimales et
  qu'un arrondi silencieux sur un montant, c'est une perte d'argent.
- **La longueur du secret est vérifiée par nous *et* par `mppx`.** On double le
  contrôle pour produire une erreur en français, à la lecture de la config,
  plutôt qu'au premier Challenge.

## Tests

6 tests : configuration valide, refus de `mainnet`, refus d'un secret court,
refus d'une adresse malformée, refus d'un prix malformé ou trop précis,
refus d'une variable obligatoire absente.
