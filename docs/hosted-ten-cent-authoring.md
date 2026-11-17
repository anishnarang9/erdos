# Ten-cent constraint authoring

Status: proposed cost policy. Paid authoring remains disabled.

The user permits at most **$0.10 for a complete authoring run**. This includes its model repair. The compiler then handles deterministic validation and checker generation. The user deferred mass testing and rejected the proposed $20 testing and daily budgets. No generation request has run.

Latest clarification: Grok Bot must validate constraints in the live app workflow. Development-only or decorative Bot use was rejected. The [runtime integration](hosted-grok-bot-authoring.md) uses an authenticated Bot webhook and a restricted MCP callback tool. The complete target includes any direct API draft, Bot validation and correction. The API arithmetic below prices API calls only. It does not price Bot usage. The approved Bot reviews have completed. The three follow-ups cost about $0.23 in total, based on rounded account balances. The complete authoring run must budget for drafting and repair as well as review.

## Intended boundary

Use one owner-bound authoring session for the original request, clarification answers and any repair. Persist its spending state with the durable tasks. A replay selects the original task and charge. A new idempotency key must not reset an existing session's allowance.

Reserve the worst supported charge before each model call. Count earlier charges and outstanding reservations against 100,000 micro-USD. Keep uncertain charges reserved. Stop when the remaining balance cannot cover the next call. Do not retry an unknown charge under a new identity.

Keep the exact reviewed non-reasoning model, one completion, no search and no tools. Limit the full input, including the system prompt, engine schema, capability catalog, response schema, reference content, examples, clarification history and repair payload. Do not count only the buyer's text. Return a bounded clarification or unsupported result when the required output cannot fit. Keep buyer approval explicit.

The compiler and deterministic evaluator need no additional model call. A failed validation cannot silently obtain more paid attempts. A model-generated rule still needs the existing semantic, example and buyer-approval checks.

## Conditional two-call profile

At the reviewed highest rates of $2.50 per million input tokens and $5 per million output tokens, one call with **12,000 complete input tokens and 4,000 output tokens** costs at most $0.05. Two such calls fit $0.10. This is tariff arithmetic, not a verified input bound or an enabled configuration. Each repair must fit the same complete-input limit. Clarification calls consume the same session balance.

## Current unresolved dependency

The current adapter reserves the model's documented one-million-token context, which cannot fit ten cents. The REST contract exposes no per-request dollar limit or prompt-token ceiling. Its tokenizer accepts text. The billing FAQ says inference adds predefined tokens beyond tokenizer results. Neither raw JSON bytes nor a guessed framing allowance establishes a provider-backed complete-input bound.

The next viable implementation needs a verified way to bound the complete billed input, or a provider-enforced request cost limit. A measured estimate can inform product costs, but cannot silently replace the user's maximum. Preserve the current fail-closed guard until that boundary is reviewed. No $20 campaign or increased ceiling is authorized by this proposal.

Sources checked on 2026-11-17: [REST contract](https://api.x.ai/api-docs/openapi.json), [tokenizer reference](https://docs.x.ai/developers/rest-api-reference/inference/other), [billing FAQ](https://docs.x.ai/developers/faq/billing), [reviewed model and rates](https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning).


## Provider limits checked on 2026-11-17

The reviewed model reserves $2.54096 for one call under the current guard. This uses the documented one million input tokens at $2.50 per million and the configured 8,192 output tokens at $5 per million. Even pricing that reservation at the 20% batch discount gives $2.032768. Batch pricing does not resolve the ten-cent limit. [Pricing](https://docs.x.ai/developers/pricing)

The API key token limit applies per minute. The provider lets in-flight requests finish after they exceed it. The team postpaid limit applies after prepaid credits run out. Neither control establishes a maximum charge for one complete authoring run. [API key limits](https://docs.x.ai/developers/rest-api-reference/management/auth) · [Team billing limits](https://docs.x.ai/developers/rest-api-reference/management/billing)

The cost guard test now checks the user's exact 100,000 micro-USD limit. It requires HTTP 503 and zero provider calls.
