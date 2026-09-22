# Agent LLM — le modèle décide d'acheter

**Phase 4** · Code : `agent/llm.ts`, `agent/tools.ts`, `agent/loop.ts`, `agent/index.ts`
· Tests : `tests/agent/llm.test.ts`, `tests/agent/tools.test.ts`, `tests/agent/loop.test.ts`

## Ce que ça fait

Un modèle reçoit une question et un outil payant. Il décide seul s'il l'appelle.
Le [budget guard](budget-guard.md) reste l'autorité finale : **le modèle
propose, le guard dispose**.

```bash
npm run dev                                   # le provider
npm run agent -- "Qu'est-ce que le protocole MPP ?"
```

## Le modèle : DeepSeek, pas Anthropic

`CLAUDE.md` prévoyait `@anthropic-ai/sdk`. Faute de crédit Anthropic, on
utilise **DeepSeek**, dont l'API est compatible OpenAI :

> « The DeepSeek API uses an API format compatible with OpenAI/Anthropic. »
> — <https://api-docs.deepseek.com/>

| Paramètre | Valeur |
|---|---|
| `base_url` | `https://api.deepseek.com` |
| Modèles | `deepseek-flash` (V4.1-Flash), `deepseek-v4-pro` |
| SDK | `openai` (npm) |
| Tool calls | format OpenAI standard, vérifié |

Modèles confirmés par `GET https://api.deepseek.com/models`, pas recopiés
d'un billet de blog.

**Le mode « thinking » est désactivé par défaut.** DeepSeek l'active sinon, et
il consomme des tokens de raisonnement sans bénéfice pour une boucle d'outils
aussi cadrée — un premier essai à `max_tokens: 10` a rendu une réponse vide,
tout le budget étant parti en raisonnement. `DEEPSEEK_THINKING=true` le réactive.

## Le modèle ne dépend pas du fournisseur

`agent/llm.ts` définit un port minimal :

```ts
type LlmClient = {
  turn(messages: readonly LlmMessage[], tools: readonly ToolSpec[]): Promise<AssistantTurn>
}
```

Le reste de l'agent ne connaît que ce type. Conséquences : la boucle se teste
avec un modèle scripté en cinq lignes (aucun réseau, aucun crédit consommé en
CI), et changer de fournisseur ne touche pas la logique.

Le transport est lui aussi injectable (`fetch`), ce qui permet de tester la
traduction vers Chat Completions en interceptant la requête.

## Un refus est un résultat, pas une exception

C'est la décision structurante de la phase. Quand le guard refuse, l'exécuteur
ne laisse pas l'exception casser la boucle : il renvoie un `tool_result`
structuré que le modèle peut exploiter.

```json
{ "ok": false, "code": "budget-exhausted",
  "message": "Montant 0.5 au-dessus du budget restant 0.1…",
  "hint": "Le budget ne permet pas cet achat. N'insiste pas : réponds avec ce que tu sais déjà, en signalant la limite.",
  "retryable": false }
```

Le `hint` distingue **« réessaie »** de **« abandonne »**. Un refus non
réessayable coupe l'outil pour le tour suivant — sans ça, le modèle peut
reproposer le même achat jusqu'à épuiser `maxTurns` pour rien.

## Rien de sensible n'atteint le modèle

L'exécuteur ne remonte que les données achetées, le montant dépensé et le
budget restant. Jamais de clé privée, de Credential, de Receipt brut.

Les **messages d'erreur bruts** sont eux aussi retenus : une panne de signature
ou de réseau peut contenir un hash de transaction ou un Credential. Le modèle
reçoit un `search-unavailable` générique. Un test vérifie qu'une erreur
contenant `0xdeadbeef…` ne laisse rien filtrer.

Un test balaie l'intégralité des messages transmis au modèle et y cherche
tout motif `0x` + 64 hex, tout `Authorization`, tout Credential.

## Garde-fous de la boucle

Indépendants du budget, parce qu'un modèle peut boucler sans dépenser :

| Borne | Défaut | Rôle |
|---|---|---|
| `maxTurns` | 6 | aller-retours avec le modèle |
| `maxToolCalls` | 4 | achats tentés au total |
| coupure d'outil | — | après un refus non réessayable |

L'outil s'annonce payant dans sa propre description (`« Cet appel est
PAYANT »`) et le prompt système le répète. C'est de l'information, pas une
protection : la protection, c'est le guard.

## Démonstration réelle

Contre le provider en marche et le vrai modèle DeepSeek.

**Budget 0,10 < prix 0,50** — le guard refuse :

```
outil   : search_marketplace({"query": "protocole MPP"}) → ✗ per-call-cap
arrêt   : completed en 2 tour(s)
dépense : 0 / reste 0.1
```

Le modèle a conclu de lui-même, en signalant explicitement la limite :
« je n'ai pas pu accéder à la place de marché documentaire (refus pour
dépassement du plafond par appel, non réessayable) ». Il a aussi produit une
réponse générale sur le 402 — qui parle de L402 et de Lightning, pas de MPP.
C'est exactement l'intérêt de la recherche payante : le modèle ne connaît pas
ce protocole.

**Budget 2,00 > prix 0,50, wallet vide** — le guard autorise, le paiement
échoue :

```
outil   : search_marketplace({"query": "spec du flux 402 de MPP"}) → ✗ search-unavailable
outil   : search_marketplace({"query": "specification flux 402 MPP"}) → ✗ search-unavailable
arrêt   : completed en 3 tour(s)
dépense : 0 / reste 2
```

Le contraste est net : refus de politique (terminal, le modèle s'arrête tout
de suite) contre panne technique (réessayable, le modèle retente une fois).
Et **`dépense : 0`** dans les deux cas — la réservation a bien été libérée,
ce qui valide le cycle `authorize → release` de la phase 2 en conditions réelles.

Le ledger a enregistré les trois Challenges émis, tous restés `challenged`.

## Compte éphémère

Sans `AGENT_PRIVATE_KEY`, `agent/index.ts` génère un compte jetable et le
signale (`⚠️ éphémère, non financé`). La boucle reste démontrable de bout en
bout ; seul l'aboutissement du paiement demande un wallet financé — c'est
l'objet de la **phase 5**.

`loadAgentConfig`, lui, exige toujours la clé : la tolérance est cantonnée au
script de démonstration.

## Tests

29 tests, aucun appel réseau : traduction vers Chat Completions et lecture des
réponses (10), exécuteur d'outil et étanchéité (9), boucle et ses bornes (10).
