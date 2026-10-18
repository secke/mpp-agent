# LLM agent — the model decides to buy

**Phase 4** · Code: `agent/llm.ts`, `agent/tools.ts`, `agent/loop.ts`, `agent/index.ts`
· Tests: `tests/agent/llm.test.ts`, `tests/agent/tools.test.ts`, `tests/agent/loop.test.ts`

## What it does

A model receives a question and a paid tool. It decides by itself whether to
call it. The [budget guard](budget-guard.md) remains the final authority:
**the model proposes, the guard disposes**.

```bash
npm run dev                                   # the provider
npm run agent -- "What is the MPP protocol?"
```

## The model: DeepSeek, not Anthropic

`CLAUDE.md` planned `@anthropic-ai/sdk`. For lack of Anthropic credit, we use
**DeepSeek**, whose API is OpenAI-compatible:

> "The DeepSeek API uses an API format compatible with OpenAI/Anthropic."
> — <https://api-docs.deepseek.com/>

| Parameter | Value |
|---|---|
| `base_url` | `https://api.deepseek.com` |
| Models | `deepseek-flash` (V4.1-Flash), `deepseek-v4-pro` |
| SDK | `openai` (npm) |
| Tool calls | standard OpenAI format, verified |

Models confirmed by `GET https://api.deepseek.com/models`, not copied from a
blog post.

**"Thinking" mode is disabled by default.** DeepSeek otherwise enables it, and
it burns reasoning tokens with no benefit for such a tightly framed tool loop
— a first attempt with `max_tokens: 10` returned an empty response, the whole
budget having gone into reasoning. `DEEPSEEK_THINKING=true` re-enables it.

## The model does not depend on the provider

`agent/llm.ts` defines a minimal port:

```ts
type LlmClient = {
  turn(messages: readonly LlmMessage[], tools: readonly ToolSpec[]): Promise<AssistantTurn>
}
```

The rest of the agent only knows this type. Consequences: the loop is tested
with a five-line scripted model (no network, no credit consumed in CI), and
switching provider does not touch the logic.

The transport is also injectable (`fetch`), which makes it possible to test
the translation to Chat Completions by intercepting the request.

## A refusal is a result, not an exception

This is the structuring decision of the phase. When the guard refuses, the
executor does not let the exception break the loop: it returns a structured
`tool_result` the model can work with.

```json
{ "ok": false, "code": "budget-exhausted",
  "message": "Amount 0.5 exceeds the remaining budget 0.1…",
  "hint": "The budget does not allow this purchase. Do not insist: answer with what you already know, and mention the limit.",
  "retryable": false }
```

The `hint` distinguishes **"retry"** from **"give up"**. A non-retryable
refusal disables the tool for the next turn — without this, the model may
re-propose the same purchase until it exhausts `maxTurns` for nothing.

## Nothing sensitive reaches the model

The executor only passes up the purchased data, the amount spent and the
remaining budget. Never a private key, a Credential, a raw Receipt.

**Raw error messages** are also held back: a signing or network failure may
contain a transaction hash or a Credential. The model receives a generic
`search-unavailable`. A test checks that an error containing `0xdeadbeef…`
lets nothing through.

A test sweeps all the messages sent to the model and looks for any `0x` + 64
hex pattern, any `Authorization`, any Credential.

## Loop guardrails

Independent of the budget, because a model can loop without spending:

| Bound | Default | Role |
|---|---|---|
| `maxTurns` | 6 | round-trips with the model |
| `maxToolCalls` | 4 | total purchases attempted |
| tool cut-off | — | after a non-retryable refusal |

The tool announces itself as paid in its own description ("This call is PAID")
and the system prompt repeats it. This is information, not protection: the
protection is the guard.

The system prompt is in English and ends with "Answer in the language of the
question." so the model keeps answering in the user's language.

## Real demonstration

Against the running provider and the real DeepSeek model. (The agent's output
labels are shown as in the current CLI; the model's answers are translated.)

**Budget 0.10 < price 0.50** — the guard refuses:

```
tool    : search_marketplace({"query": "MPP protocol"}) → ✗ per-call-cap
stopped : completed after 2 turn(s)
spent   : 0 / remaining 0.1
```

The model concluded on its own, explicitly flagging the limit: "I could not
access the document marketplace (refused for exceeding the per-call cap, not
retryable)". It also produced a general answer about 402 — which talks about
L402 and Lightning, not MPP. This is exactly the point of paid search: the
model does not know this protocol.

**Budget 2.00 > price 0.50, empty wallet** — the guard authorizes, the payment
fails:

```
tool    : search_marketplace({"query": "MPP 402 flow spec"}) → ✗ search-unavailable
tool    : search_marketplace({"query": "MPP 402 flow specification"}) → ✗ search-unavailable
stopped : completed after 3 turn(s)
spent   : 0 / remaining 2
```

The contrast is sharp: a policy refusal (terminal, the model stops right away)
versus a technical failure (retryable, the model retries once). And **`spent:
0`** in both cases — the reservation was indeed released, which validates the
phase 2 `authorize → release` cycle in real conditions.

The ledger recorded the three Challenges issued, all left `challenged`.

## Ephemeral account

Without `AGENT_PRIVATE_KEY`, `agent/index.ts` generates a throwaway account
and says so (`⚠️ ephemeral, unfunded`). The loop remains demonstrable end to
end; only the success of the payment needs a funded wallet — that is the
subject of **phase 5**.

`loadAgentConfig`, for its part, always requires the key: the tolerance is
confined to the demo script.

## Tests

29 tests, no network call: translation to Chat Completions and reading of
responses (10), tool executor and isolation (9), loop and its bounds (10).
