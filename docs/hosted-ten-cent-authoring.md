# Ten-cent constraint authoring

**2026-11-18 pilot result:** The isolated ten-case qualification failed. Ten API drafts cost 63,529 micro-USD in total. Only one case reached exact Bot review, which passed, but its queued compile failed in the isolated environment. The rounded shared Bot meter rose by about $0.06 during that review. No case produced an accepted compiled plan. The [failure report](../agents/anish/reports/ten-case-authoring-pilot-2026-11-18.json) is the current evidence. The older text below records the policy and estimates that preceded this run. It does not describe the current execution state. Production authoring remains unqualified, and the personal test account is not the production account boundary.

Status — the user revised the cost target to a 5–10¢ average on 2026-11-17 and requested a bounded pilot proposal. See the [complete authoring pilot](grok-bot/combined-authoring-pilot.md). Paid execution awaits approval. The sections below describe the earlier strict policy and the current production guard.

The user permits at most **$0.10 for a complete authoring run**. This includes its model repair. The compiler then handles deterministic validation and checker generation. The user deferred mass testing and rejected the proposed $20 testing and daily budgets. No generation request has run.

Latest clarification: Grok Bot must validate constraints in the live app workflow. Development-only or decorative Bot use was rejected. The [runtime integration](hosted-grok-bot-authoring.md) uses an authenticated Bot webhook and a restricted MCP callback tool. The complete target includes any direct API draft, Bot validation and correction. The API arithmetic below prices API calls only. It does not price Bot usage. The approved Bot reviews have completed. The three follow-ups cost about $0.23 in total, based on rounded account balances. The complete authoring run must budget for drafting and repair as well as review.

## Intended boundary

Use one owner-bound authoring session for the original request, clarification answers and any repair. Persist its spending state with the durable tasks. A replay selects the original task and charge. A new idempotency key must not reset an existing session's allowance.

Reserve the worst supported charge before each model call. Count earlier charges and outstanding reservations against 100,000 micro-USD. Keep uncertain charges reserved. Stop when the remaining balance cannot cover the next call. Do not retry an unknown charge under a new identity.

Keep the exact reviewed non-reasoning model, one completion, no search and no tools. Limit the full input, including the system prompt, engine schema, capability catalog, response schema, reference content, examples, clarification history and repair payload. Do not count only the buyer's text. Return a bounded clarification or unsupported result when the required output cannot fit. Keep buyer approval explicit.

The compiler and deterministic evaluator need no additional model call. A failed validation cannot silently obtain more paid attempts. A model-generated rule still needs the existing semantic, example and buyer-approval checks.

## Combined budget after Bot review

The follow-ups moved the rounded account meters by about 6¢ to 9¢ per review. That leaves about 1¢ to 4¢ for drafting and repair under the complete-run ceiling. The three-review mean of 7.7¢ already exceeds the 5¢ target before drafting.

At the reviewed upper API rates of $2.50 per million input tokens and $5 per million output tokens, 1,000 output tokens cost 0.5¢. This leaves the following illustrative room for one draft.

| Bot review assumption | API budget | Maximum complete input with 1,000 output tokens |
| --- | ---: | ---: |
| 6¢ | 4¢ | 14,000 tokens |
| 7¢ | 3¢ | 10,000 tokens |
| 8¢ | 2¢ | 6,000 tokens |
| 9¢ | 1¢ | 2,000 tokens |

These examples assume no repair or clarification call. The pilot's rounded meter changes do not guarantee any row's Bot cost. The API tokenizer omits provider-added framing. These figures are therefore useful for narrowing the prompt and schema, while the production admission check still requires enforceable bounds for both calls.

## Current unresolved dependency

The current adapter reserves the model's documented one-million-token context, which cannot fit ten cents. The REST contract exposes no per-request dollar limit or prompt-token ceiling. Its tokenizer accepts text. The billing FAQ says inference adds predefined tokens beyond tokenizer results. Neither raw JSON bytes nor a guessed framing allowance establishes a provider-backed complete-input bound.

The next viable implementation needs a verified way to bound the complete billed input, or a provider-enforced request cost limit. A measured estimate can inform product costs, but cannot silently replace the user's maximum. Preserve the current fail-closed guard until that boundary is reviewed. No $20 campaign or increased ceiling is authorized by this proposal.

Sources checked on 2026-11-17: [REST contract](https://api.x.ai/api-docs/openapi.json), [tokenizer reference](https://docs.x.ai/developers/rest-api-reference/inference/other), [billing FAQ](https://docs.x.ai/developers/faq/billing), [reviewed model and rates](https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning).


## Provider limits checked on 2026-11-17

The reviewed model reserves $2.54096 for one call under the current guard. This uses the documented one million input tokens at $2.50 per million and the configured 8,192 output tokens at $5 per million. Even pricing that reservation at the 20% batch discount gives $2.032768. Batch pricing does not resolve the ten-cent limit. [Pricing](https://docs.x.ai/developers/pricing)

The API key token limit applies per minute. The provider lets in-flight requests finish after they exceed it. The team postpaid limit applies after prepaid credits run out. Neither control establishes a maximum charge for one complete authoring run. [API key limits](https://docs.x.ai/developers/rest-api-reference/management/auth) · [Team billing limits](https://docs.x.ai/developers/rest-api-reference/management/billing)

The cost guard test now checks the user's exact 100,000 micro-USD limit. It requires HTTP 503 and zero provider calls.


The current pricing table lists `grok-build-0.1` with the smallest published context and lowest long-context input rate of the listed text models. Its 256,000-token context at $2 per million still produces a 51.2¢ input reservation under the same full-context method, before output. This screening result does not qualify the model for structured authoring or verify a per-request bound. [Text API pricing](https://docs.x.ai/developers/pricing#text-api)

The Bot documentation describes a webhook body and an account-level monthly cap. The webhook starts an asynchronous run. The cap allows an in-flight run to finish after the account crosses it. The published controls do not supply a per-run token or dollar ceiling. Compact prompts and a single callback can reduce work in a future approved pilot, but Bot-only authoring still needs a verified run limit to satisfy the strict cap. [Bot webhook controls](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks) · [Bot billing FAQ](https://docs.x.ai/grok-bot/faq)
