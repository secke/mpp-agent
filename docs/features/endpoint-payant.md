# Endpoint payant et flux 402

**Phase 1** · Code : `server/app.ts`, `server/payment.ts`, `server/search.ts`
· Tests : `tests/server/app.test.ts`

## Ce que ça fait

Expose `GET /v1/search`, gardé par un paiement MPP. Un client sans Credential
reçoit un **402** avec un Challenge ; avec un Credential valide, il reçoit les
résultats et un Receipt.

Routes servies :

| Route | Paiement | Rôle |
|---|---|---|
| `GET /healthz` | non | sonde de vivacité |
| `GET /v1/search?q=…` | **oui** | le service vendu |
| `GET /openapi.json` | non | [découverte](decouverte-openapi.md) |

## Le flux

```
1. Client  → GET /v1/search?q=mpp
2. Serveur → 402 Payment Required
             WWW-Authenticate: Payment id="…", realm="api.test",
                               method="tempo", intent="charge", request="eyJ…"
             Cache-Control: no-store
             Content-Type: application/problem+json
3. Client  → GET /v1/search?q=mpp
             Authorization: Payment eyJjaGFsbGVuZ2Ui…
4. Serveur → 200 OK  +  Payment-Receipt: …
             { "query": "mpp", "payer": "did:pkh:eip155:42431:0x…", "results": [...] }
```

Le `request` décodé du Challenge :

```json
{ "amount": "500000",
  "currency": "0x20c0000000000000000000000000000000000000",
  "recipient": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "methodDetails": { "chainId": 42431 } }
```

`"500000"` = 0,50 pathUSD : `mppx` convertit le montant lisible en unités de
base avec 6 décimales.

## Utilisation

```ts
const payment = createPayment(config)

app.get(
  '/v1/search',
  payment.charge({ amount: config.searchPrice, description: '…' }),
  (c) => c.json({ results: search(c.req.query('q') ?? '') }),
)
```

`payment.charge(...)` renvoie un `MiddlewareHandler` Hono standard : il se
glisse dans la route comme n'importe quel middleware.

## Identifier le payeur

Après vérification, le Credential est toujours sur la requête. Son champ
`source` est un DID :

```ts
const payer = Credential.deserialize(c.req.header('Authorization')!).source
// "did:pkh:eip155:42431:0x…"
```

Le champ est `Authorization` par défaut ; il devient `Payment-Authorization`
si le serveur active `requiresAuth: true` (cohabitation avec une auth
applicative). C'est le Challenge qui l'annonce — ne pas coder le nom en dur,
lire `Challenge.credentialHeader(challenge)`.

## Détails qui comptent

- **Un Credential invalide donne 402, pas 401.** MPP est explicite là-dessus
  (`NOTES.md` §2) : l'échec de vérification renvoie un **Challenge frais**.
  C'est contre-intuitif par rapport aux autres schémas d'auth HTTP ; un test
  le verrouille.
- **Les en-têtes de sécurité sont émis par `mppx` tout seul** :
  `Cache-Control: no-store` et `application/problem+json` sur le 402. Vérifié,
  pas supposé. En revanche `Cache-Control: private` sur les 200 porteuses d'un
  Receipt reste **à notre charge** — prévu en phase 8.
- **Le 402 ne divulgue aucun résultat.** Un test l'assert explicitement :
  payer sert à quelque chose.
- **`mppx` lie la route dans `opaque`.** Vérifié sur le serveur en marche :
  `opaque` décode en `{"_mppx_scope":"GET /v1/search"}`. Un Challenge émis pour
  une route ne peut donc pas être redéposé sur une autre — protection obtenue
  gratuitement, mais à ne pas casser en manipulant `opaque` soi-même.
- **`server/search.ts` est factice et déterministe.** L'objet de la phase est
  le paiement, pas la pertinence. La forme de la réponse, elle, est stable.
  Voir [`DECISIONS.md` D6](../DECISIONS.md).

## Tests

11 tests : 200 sans paiement sur `/healthz` ; 402 sur `/v1/search` ; présence
et forme du `WWW-Authenticate` ; en-têtes de sécurité ; liaison HMAC du
Challenge (valide avec le bon secret, invalide avec un autre) ; montant, devise,
destinataire et chainId annoncés ; champ de Credential ; non-divulgation des
résultats ; 402 sur Credential malformé.
