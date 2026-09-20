# Agent payeur

**Phase 2** · Code : `agent/client.ts`, `agent/wallet.ts`
· Tests : `tests/agent/client.test.ts`, `tests/agent/wallet.test.ts`

## Ce que ça fait

Un client HTTP qui encaisse un 402, paie tout seul, et retente — **sauf si le
[budget guard](budget-guard.md) s'y oppose**.

```ts
const { mppx } = createPayingClient({ account, guard })
const res = await mppx.fetch('http://localhost:8787/v1/search?q=mpp')
```

## 🚨 Le piège central : refuser, ça se fait en levant

C'est **le** point à ne pas se tromper, et la doc induit en erreur.

La doc décrit `onChallenge` comme « called when a 402 challenge is received
and no event handler supplies a credential » — ce qui laisse croire que
renvoyer `undefined` revient à ne pas payer. **C'est faux.**
`node_modules/mppx/dist/client/internal/Fetch.js`, ligne 153 :

```js
const credential = onChallengeCredential ?? (await createCredential())
```

`undefined` fait retomber le client sur la création de Credential **par
défaut**. Mesuré, avec un `onChallenge` renvoyant `undefined` : le client est
allé jusqu'à la transaction on-chain et n'a échoué que sur
`InsufficientBalance(available: 0, required: 500000)`. **Un wallet financé
aurait payé.**

La seule façon de refuser est de **lever**. L'exception se propage telle
quelle hors de `mppx.fetch`, et aucune signature n'est demandée :

```ts
onChallenge: async (challenge, { createCredential }) => {
  guard.authorize(challenge)        // lève BudgetDenied pour refuser
  return await createCredential()
}
```

Deux tests verrouillent ça : l'un vérifie que `createCredential` n'est
**jamais appelé** sur un refus, l'autre qu'une seule requête HTTP part (pas
de retry payant).

## Défense en profondeur

Deux couches, qui ne couvrent pas la même chose :

| Couche | Ce qu'elle vérifie | Ce qu'elle ignore |
|---|---|---|
| Garde-fous natifs du SDK | chaîne, destinataire | combien on a déjà dépensé |
| Budget guard | tout ça **+** l'historique de dépense | — |

Les garde-fous SDK viennent de `dist/tempo/client/Charge.d.ts` et agissent
avant toute signature :

```ts
tempo({
  account,
  expectedChainId: 42431,      // rejette tout Challenge sur une autre chaîne
  allowedChainIds: [42431],    // ⚠️ omis = TOUTES les chaînes permises
  expectedRecipients: [...],   // s'applique aussi aux splits
})
```

`allowedChainIds` omis autorise **toutes** les chaînes — c'est pour ça qu'on
le passe explicitement, même avec `expectedChainId` déjà défini.

## `polyfill: false`, toujours

`Mppx.create` patche `globalThis.fetch` **par défaut**
(`dist/client/Mppx.d.ts` : « @default true »). Autrement dit, créer le client
rendrait payant *tout* appel `fetch` du process — y compris ceux qui ne
passent pas par le guard. Le guard serait contournable sans même le savoir.

On passe donc `polyfill: false` et on utilise `mppx.fetch` explicitement.
Un test assert que `globalThis.fetch` est inchangé après création.

## Cycle de vie d'un engagement

```
onChallenge          → guard.authorize()   engage le montant
  ↳ createCredential échoue → guard.release()   rend l'engagement
onPaymentResponse    → guard.settle()      l'engagement devient dépense
onPaymentFailed      → guard.release()     rend l'engagement
```

⚠️ `onPaymentFailed` reçoit un `challenge` **optionnel**
(`client/internal/Fetch.d.ts`) — d'où la garde `if (challenge)`. C'est aussi
pourquoi `onChallenge` libère lui-même quand `createCredential` échoue :
on ne peut pas compter sur le hook pour toutes les pannes.

## Le wallet

`agent/wallet.ts` lit `AGENT_PRIVATE_KEY` depuis l'environnement, valide le
format (`0x` + 64 hex), et construit un compte viem.

**La clé n'apparaît jamais dans un message d'erreur** : le refus dit
« AGENT_PRIVATE_KEY malformée (attendu 0x + 64 caractères hex) », sans
reproduire la valeur. Un test le vérifie en cherchant un fragment de la clé
dans le message.

Le wallet de l'agent est **distinct** de `MPP_RECIPIENT` : l'agent paie, le
provider encaisse.

## Tests

14 tests : handler isolé (autorise / refuse sans signature / libère sur
échec), `polyfill: false`, propagation du refus hors de `mppx.fetch`, absence
de retry sur refus, Challenge réellement reçu du provider, et 7 tests de
configuration du wallet.

Le chemin « paiement abouti » n'est pas couvert ici : il exige un wallet
financé et une transaction on-chain. C'est l'objet de la **phase 5**.
