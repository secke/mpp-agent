# Budget guard

**Phase 2** · Code : `agent/budget.ts`, `agent/amount.ts`
· Tests : `tests/agent/budget.test.ts`, `tests/agent/amount.test.ts`

## Ce que ça fait

Décide si un Challenge reçu est payable. C'est **l'autorité finale** de
l'agent : le modèle propose, le guard dispose.

Sept motifs de refus, tous typés (`DenyCode`) :

| Code | Déclencheur |
|---|---|
| `unsupported-method` | autre chose que `tempo`/`charge` |
| `unexpected-chain` | `methodDetails.chainId` ≠ 42431, ou absent |
| `unexpected-currency` | devise ≠ pathUSD |
| `unexpected-recipient` | destinataire hors liste blanche (si définie) |
| `malformed-amount` | montant qui n'est pas une chaîne de chiffres |
| `per-call-cap` | au-dessus du plafond par appel |
| `budget-exhausted` | au-dessus de l'enveloppe restante |

## Deux principes de conception

### Module pur

Aucune I/O, aucune dépendance au SDK au-delà du type `Challenge`. La logique
qui protège l'argent doit être couvrable exhaustivement sans réseau ni wallet
— 18 tests en 15 ms.

### Fail-closed

Tout ce qui n'est pas explicitement reconnu est refusé. Champ manquant,
devise inconnue, montant illisible ⇒ refus. Un agent bloqué se débogue ;
un agent qui paie n'importe quoi, non.

Cas concret couvert : un Challenge **sans** `chainId` est refusé, pas traité
comme « probablement le bon réseau ».

## Arithmétique entière uniquement

Les montants MPP circulent en **unités de base** sous forme de chaîne
(`"500000"` = 0,50 pathUSD). `agent/amount.ts` fait toutes les conversions en
`bigint`, jamais en `number` :

```ts
toBaseUnits('0.50', 6)    // 500000n
toBaseUnits('0.1234567', 6)  // ✗ AmountError : 7 décimales pour un jeton à 6
toBaseUnits('1e-3', 6)       // ✗ AmountError : pas un montant décimal simple
```

Un test vérifie que `toBaseUnits('0.1') + toBaseUnits('0.2') === toBaseUnits('0.3')`
— ce qui est faux en flottant. **Plus de décimales que le jeton n'en a
⇒ refus, jamais arrondi.** Un arrondi silencieux sur un montant, c'est une
perte d'argent qui ne laisse pas de trace.

## Réservation, puis confirmation

Le guard ne décompte pas la dépense au moment du paiement, mais en deux temps :

```
authorize(challenge)  →  engage le montant     (reserved += montant)
settle(challengeId)   →  l'engagement devient une dépense  (committed += montant)
release(challengeId)  →  rend l'engagement à l'enveloppe
```

`remaining = totalBudget − committed − reserved`.

**Pourquoi compter les engagements** : sans ça, deux appels concurrents
passent chacun sous le plafond et le franchissent ensemble. Un test le
verrouille (deux réservations de 1,00 sur une enveloppe de 2,50 ⇒ le
troisième appel à 0,60 est refusé, alors qu'aucun n'est encore confirmé).

Si l'issue d'un paiement reste inconnue, l'engagement **reste engagé** :
sur-compter fait s'arrêter l'agent trop tôt, sous-compter le fait dépenser
trop. Seule la première erreur est acceptable.

Réautoriser le même `challenge.id` (retry) ne réengage pas deux fois.

## Utilisation

```ts
const guard = new BudgetGuard({
  maxPerCall: toBaseUnits('1.00', 6),
  totalBudget: toBaseUnits('10.00', 6),
  chainId: 42431,
  currency: PATH_USD,
  decimals: 6,
  recipients: ['0xf39F…'],   // optionnel
})

guard.authorize(challenge)   // lève BudgetDenied pour refuser
guard.snapshot()             // { committed: '0.5', reserved: '0', remaining: '9.5', inFlight: 0 }
```

`snapshot()` ne contient que des montants — rien d'identifiant, rien de
sensible. C'est ce qui ira dans les journaux et les métriques (phase 6).

## Tests

26 tests (18 guard + 8 arithmétique) : autorisation nominale, réservation,
confirmation, libération, retry, plafond par appel (y compris pile au
plafond), épuisement d'enveloppe, concurrence, et les sept motifs de refus.
