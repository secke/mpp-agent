# Durcissement — liaison du corps, cache, revue de sécurité

**Phase 8** · Code : `server/app.ts`, `server/analyze.ts`
· Tests : `tests/server/hardening.test.ts`

Voir aussi [anti-rejeu](anti-rejeu.md), le gros morceau de cette phase.

## Liaison du corps de requête

### L'exigence

> « Include a `digest` parameter for `POST`, `PUT`, and `PATCH` requests so
> clients cannot change the request body after receiving a Challenge. »
> — <https://mpp.dev/advanced/security>

Sans ça : un client demande un Challenge pour un petit corps, paie, puis
redépose le Credential avec un corps beaucoup plus coûteux à traiter.

### Le trou dans le SDK

**Le serveur TypeScript de `mppx` n'expose pas d'option `body` ni `digest`**
sur le middleware — contrairement au SDK Python, qui a `mpp.charge(body=…)`
et `@pay(body=…)`. `MethodFn.Options` (`dist/server/Mppx.d.ts`) ne propose
que `description`, `expires`, `meta` et `scope`.

### La parade : passer par `scope`

`scope` est fusionné dans `meta`, sérialisé dans `opaque`, et `opaque` fait
partie de l'entrée HMAC du Challenge. On y met donc le digest du corps :

```ts
app.post('/v1/analyze', async (c, next) => {
  const raw = await c.req.raw.clone().text()   // clone : on ne consomme pas
  return payment.charge({
    amount: config.analyzePrice,
    scope: `POST /v1/analyze#${BodyDigest.compute(raw)}`,
  })(c, next)
})
```

Le middleware est construit **par requête** — `scope` est une option statique,
et le digest ne l'est pas.

Vérifié : l'`opaque` du Challenge décode en

```json
{"_mppx_scope":"POST /v1/analyze#sha-256=AUNX9X17itJ5cnD9i4zG4d6z98zj4H/DyBtI5GzJKkc="}
```

### La preuve

Le serveur recalcule le scope à partir de la requête **entrante**. Corps
modifié ⇒ scope différent ⇒ identifiant de Challenge différent ⇒ le Credential
ne vérifie plus. Le test exploite le contraste des codes d'erreur :

| Requête | Statut | Type de problème |
|---|---|---|
| Credential + **corps substitué** | 402 | `invalid-challenge` |
| Credential + **corps d'origine** | 402 | `verification-failed` |

Dans le second cas, la liaison passe et l'échec porte sur la preuve de
paiement — c'est ce contraste qui prouve que la liaison discrimine bien le
corps, et non qu'elle rejette tout.

Ce test ne coûte **aucun paiement** : le rejet survient avant la vérification
on-chain. Le payload `proof` est utilisé parce qu'il se vérifie hors-chaîne —
un payload `hash` déclencherait un appel RPC.

## `Cache-Control: private`

> « Send `Cache-Control: private` on successful responses that include
> `Payment-Receipt`. » — même source

`mppx` pose `no-store` sur les 402 tout seul, mais **rien** sur les 200. Un
middleware global s'en charge :

```ts
app.use('*', async (c, next) => {
  await next()
  if (c.res.status === 200 && c.res.headers.has('Payment-Receipt'))
    c.res.headers.set('Cache-Control', 'private')
})
```

Trois tests : `private` posé sur un 200 avec Receipt, rien sur les réponses
gratuites, `no-store` préservé sur les 402.

## ⚠️ Rotation de `MPP_SECRET_KEY` — non implémentée

**C'est la seule case de la phase 8 restée ouverte, et c'est délibéré.**

La spec recommande une rotation avec recouvrement : émettre avec la nouvelle
clé, continuer à vérifier avec l'ancienne le temps que les Challenges en vol
expirent. Or `Mppx.create` prend **un seul** `secretKey?: string`
(`dist/server/Mppx.d.ts`) — aucune notion de clé précédente.

Deux contournements possibles, tous deux écartés :

1. **Deux instances `Mppx` en cascade** (nouvelle clé, puis ancienne en repli).
   Faisable, mais impossible à valider sans multiplier les paiements réels —
   et livrer de la machinerie de sécurité non testée serait pire que rien.
2. **Un `scope` porteur d'un identifiant de clé.** Ne résout rien : c'est la
   vérification HMAC elle-même qui échoue, pas la corrélation.

**Procédure retenue en attendant** — déploiement coordonné :

1. cesser d'émettre de nouveaux Challenges (drain du trafic payant) ;
2. attendre l'expiration des Challenges en vol — **5 minutes** par défaut
   (`expires` de mppx), donc une fenêtre bornée et connue ;
3. permuter `MPP_SECRET_KEY`, redémarrer.

Le coût réel est une courte fenêtre où les clients reçoivent un 402 avec un
Challenge frais — dégradation, pas panne : un client conforme repaie.

À rouvrir si `mppx` accepte un jour une liste de clés.

## Revue de sécurité — `docs/NOTES.md` §8

| Exigence | État | Où |
|---|---|---|
| `MPP_SECRET_KEY` ≥ 32 octets, jamais en dur ni commité | ✅ | `config.ts`, `.gitignore`, test |
| Ne jamais logger secret / Credential / Receipt | ✅ | ledger structurellement incapable de les stocker, test binaire |
| `Cache-Control: no-store` sur les 402 | ✅ | émis par mppx, test |
| `Cache-Control: private` sur les 200 avec Receipt | ✅ | middleware global, test |
| `digest` liant le corps sur POST/PUT/PATCH | ✅ | via `scope`, test |
| `description` jamais utilisée comme entrée d'autorisation | ✅ | revue : seul le budget guard décide, sur amount/currency/chain/recipient |
| Anti-rejeu partagé et durable | ✅ | [anti-rejeu](anti-rejeu.md) |
| Rotation de clé avec recouvrement | ⚠️ | non supportée par le SDK — procédure coordonnée ci-dessus |
| `polyfill: false` côté client | ✅ | `agent/client.ts`, test |
| Rien de sensible dans le contexte du modèle | ✅ | `agent/tools.ts`, test |

Neuf exigences sur dix sont tenues et testées. La dixième est bloquée par le
SDK, documentée, et assortie d'une procédure de contournement bornée.

## Tests

13 tests : liaison du corps (5), `Cache-Control` (3), garde-fous de
configuration du store (5). Plus les 30 tests du contrat de store.
