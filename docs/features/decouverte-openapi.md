# Découverte OpenAPI

**Phase 1** · Code : `server/app.ts` · Tests : `tests/server/app.test.ts`

## Ce que ça fait

Sert `GET /openapi.json` : un document OpenAPI 3.1 qui annonce **ce que
coûtent les routes payantes, avant qu'un client ne les appelle**.

## Pourquoi

C'est le mécanisme de découverte standard de MPP :

> « You serve a standard OpenAPI 3.1 document at `/openapi.json` with
> `x-payment-info` extensions that advertise one or more payment offers for
> each paid operation. Registries aggregate these documents so agents can find
> paid APIs automatically. »
> — <https://mpp.dev/advanced/discovery>

Pour une place de marché, c'est la porte d'entrée : un agent découvre le
service, lit le prix, décide. Sans ça, il faut se prendre un 402 pour
connaître le tarif.

## Utilisation

```ts
discovery(app, payment, {
  auto: true,
  info: { title: 'Agentic Research Marketplace', version: '0.1.0' },
})
```

`auto: true` détecte les routes payantes déjà déclarées sur l'app — pas de
liste à maintenir en double. Le helper vient de `mppx/hono`.

```bash
curl -s localhost:8787/openapi.json | jq '.paths["/v1/search"].get["x-payment-info"]'
```

## Détails qui comptent

- **Le chemin est `/openapi.json`, pas `/.well-known/…`.** J'allais inventer
  un `/.well-known/mpp` ; la doc impose `/openapi.json`. Vérifié avant d'écrire.
- **L'ordre d'appel importe.** `discovery(app, …)` doit être appelé **après**
  les routes payantes, sinon `auto: true` n'a rien à détecter.
- La route de découverte est **gratuite** : annoncer ses prix ne se facture pas.

## Tests

2 tests : le document est bien de l'OpenAPI 3.1 et contient `/v1/search` ;
l'opération porte un `x-payment-info` mentionnant la méthode `tempo`.
