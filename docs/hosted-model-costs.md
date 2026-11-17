# Hosted model spending bounds

Reviewed on 2026-11-16. No paid model call supports this report.

2026-11-17: The user requested roughly $0.10 per user for refinement. See the [current cost design](hosted-vercel-grok-options.md) for conditional two-call profiles and the remaining input/session-budget work. Those examples do not change the reviewed reservation below or authorize dispatch.

The user subsequently approved a **$0.10 maximum for each complete authoring run**, including any repair. The proposed $20 qualification budget and $20 daily cap were rejected. Mass testing remains deferred. A securely stored application key now authenticates for non-inference model listing, and the exact reviewed model is available. No generation call ran. Current full-context preflight cannot fit the approved ceiling. Keep authoring disabled until a reviewed input/session contract can enforce it. Key availability does not authorize the larger reservation or the 180-trial campaign.

Current REST inspection exposes no per-request dollar ceiling or prompt-token limit. The tokenizer endpoint accepts plain text. The provider's billing FAQ states that inference adds predefined tokens beyond tokenizer results. Therefore a tokenized string, raw JSON bytes or a fixed guessed framing allowance cannot establish a strict full-request cap. Continue the bounded-input design without describing a practical estimate as a provider-enforced guarantee. Sources: [REST contract](https://api.x.ai/api-docs/openapi.json), [tokenizer reference](https://docs.x.ai/developers/rest-api-reference/inference/other), [billing FAQ](https://docs.x.ai/developers/faq/billing).

The latest user clarification requires meaningful **Grok Bot** use and asks how to keep refinement around five to ten cents. The [Bot-first proposal](hosted-grok-bot-authoring.md) gives it the constraint-authoring role and avoids duplicate hosted inference. API tariff calculations do not price Bot runs. No larger budget, provider switch or genuine Bot action is authorized by the research.

The Chat Completions visible-output limit does not cap reasoning. The service sends `max_completion_tokens`, disables search and requests one completion. Reasoning models and unknown slugs do not advertise a reliable total output bound. Public authoring rejects those adapters before dispatch. See the [Chat Completions contract](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions.md) and [reasoning documentation](https://docs.x.ai/developers/model-capabilities/text/reasoning.md).

Only exact model `grok-4.20-0309-non-reasoning` currently has a reviewed live-adapter bound. Its documented context maximum is 1,000,000 tokens. Preflight prices that entire maximum, or the larger local estimate. Configured rates must cover its highest tier: $2.50 per million input tokens and $5.00 per million output tokens. An 8,192-token completion therefore needs at least $2.54096 available before dispatch. Repair requires that amount again after the first charge. These conservative reservations do not predict the actual bill. See the [model contract and tier prices](https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning.md).

The serialized-body byte count plus 64 framing tokens remains a local estimate. It is not a verified provider tokenizer bound. The live adapter also uses the documented context maximum. Model aliases and reasoning models require a separate reviewed spending contract before public authoring can use them. The Grok 4.7 CLI development workers are separate from the hosted authoring model.

Actual safe integer provider ticks remain authoritative. One USD contains 10^10 ticks. Reservations round known charges up to micro-USD. A tariff fallback requires known reasoning usage and conservatively adds it to completion usage. This can overestimate formats that already include reasoning in completion usage. Missing reasoning usage without an actual charge keeps the reservation uncertain. An uncertain charge is never zero.

Native host access and non-inference application-key authentication now work. A reviewed ten-cent complete-input/session bound, separately approved aggregate limits and the deferred 180-trial qualification remain pending. These changes do not authorize spending. Recheck the provider contract and prices before enabling a live deployment.

The qualification harness also needs a reviewed worst-case attempt price. `UBC26_ATTEMPT_PRICE_MICRO_USD` is a reservation bound, not an expected average. For the exact model and current limits above, it must cover at least 2,540,960 micro-USD per call. The harness reserves two calls per request and reconciles actual billed ticks afterwards. A controlled test's smaller synthetic price is not a live deployment price. Verify this binding and the approved aggregate benchmark cap before enabling dispatch.

Every authoring request has a nonempty system prompt and schema. A reported zero prompt count cannot support tariff fallback. Without a usable actual bill, the service keeps that reservation uncertain. An explicitly reported safe actual bill of zero remains authoritative. Search is explicitly disabled in each provider payload.


The qualification harness now enforces the reviewed live model and minimum attempt bound before any network request. `UBC26_BENCHMARK_MODEL` selects the reviewed identity. Campaign v2 fixes live mode and model for resume. Returned model identities must agree for every provider attempt. Prompt/catalog identities remain in each trial record. These source guards complement provider-price revalidation and separately approved account budgets. They do not enable live dispatch.

See the [proposed ten-cent authoring policy](hosted-ten-cent-authoring.md) for the complete session boundary and current provider-contract gap.
