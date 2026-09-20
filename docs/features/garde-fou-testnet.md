# Garde-fou testnet

**Phase 1** · Code : `server/config.ts`, `server/payment.ts`
· Tests : `tests/server/payment.test.ts`

## Le problème

`mppx` cible le **réseau principal par défaut**. Pire, l'option qui semble la
plus naturelle pour en changer ne fait pas ce qu'on croit. Mesure de la
phase 0 (`NOTES.md` §4.1), sur `mppx@0.10.1` :

| Configuration | `chainId` émis | devise émise | Verdict |
|---|---|---|---|
| `tempo.charge({})` | 4217 | USDC | mainnet cohérent — **argent réel** |
| **`tempo.charge({ testnet: true })`** | **42431** | **pathUSD** | ✅ correct |
| `tempo.charge({ chainId: 42431 })` | **4217** ⚠️ | pathUSD | ❌ incohérent |
| `mppx.charge({ chainId: 42431 })` | 42431 | **USDC** ⚠️ | ❌ incohérent |
| `tempo.charge({ rpcUrl: …moderato })` | 4217 | USDC | ❌ sans effet |

Autrement dit : **demander le testnet par `chainId` donne un Challenge qui
annonce le réseau principal**. Un client qui l'honore paie en vrai.

## La parade : trois couches

### 1. Au chargement de la configuration

`MPP_NETWORK` doit valoir `testnet`, sinon `loadConfig` lève. Il n'existe
aucun chemin de code menant au mainnet.

### 2. À la construction de l'instance de paiement

`server/payment.ts` passe `testnet: true` en dur, avec le commentaire qui
explique pourquoi et renvoie à la mesure. Jamais `chainId`.

```ts
tempo.charge({
  testnet: true,          // ← seul réglage cohérent (NOTES §4.1)
  recipient: config.recipient,
  currency: PATH_USD,
  decimals: TOKEN_DECIMALS,
})
```

### 3. Sur le Challenge réellement émis

Les deux premières couches sont déclaratives : elles ne protègent pas d'une
régression du SDK ni d'un changement de défaut en amont. On valide donc le
Challenge **produit** :

```ts
assertTestnetChallenge(challenge)   // chainId === 42431 ET currency === pathUSD
```

Et on l'exécute **au démarrage**, avant d'ouvrir le port :

```ts
await selfCheck(payment, config)    // émet un Challenge pour de faux, le valide
serve({ fetch: app.fetch, port })   // n'est atteint que si le self-check passe
```

Échouer au boot plutôt qu'à la première requête payante.

## Pourquoi trois couches et pas une

Le coût d'un faux négatif n'est pas une erreur 500 : c'est un virement en
stablecoin réel, irréversible. Les couches 1 et 2 attrapent les erreurs de
configuration ; la couche 3 attrape les changements de comportement du SDK.
Voir [`DECISIONS.md` D3 et D4](../DECISIONS.md).

## À signaler en amont

Le comportement de `chainId` (influence la devise mais pas le `chainId` du
Challenge) ressemble à un bug de `wevm/mppx`. À remonter — mais **sans s'y
fier** dans un sens ou dans l'autre entre-temps.

## Tests

6 tests : Challenge ancré sur 42431 + pathUSD ; conversion `0.50` → `500000` ;
`selfCheck` passant ; rejet d'un Challenge mainnet ; rejet d'une devise
inattendue sur le bon réseau ; rejet d'un secret de moins de 32 octets.
