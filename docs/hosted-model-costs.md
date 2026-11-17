# Hosted model spending bounds

Reviewed on 2026-11-16. No paid model call supports this report.

The Chat Completions visible-output limit does not cap reasoning. The service sends `max_completion_tokens`, disables search and requests one completion. Reasoning models and unknown slugs do not advertise a reliable total output bound. Public authoring rejects those adapters before dispatch. See the [Chat Completions contract](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions.md) and [reasoning documentation](https://docs.x.ai/developers/model-capabilities/text/reasoning.md).

Only exact model `grok-4.20-0309-non-reasoning` currently has a reviewed live-adapter bound. Its documented context maximum is 1,000,000 tokens. Preflight prices that entire maximum, or the larger local estimate. Configured rates must cover its highest tier: $2.50 per million input tokens and $5.00 per million output tokens. An 8,192-token completion therefore needs at least $2.54096 available before dispatch. Repair requires that amount again after the first charge. These conservative reservations do not predict the actual bill. See the [model contract and tier prices](https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning.md).

The serialized-body byte count plus 64 framing tokens remains a local estimate. It is not a verified provider tokenizer bound. The live adapter also uses the documented context maximum. Model aliases and reasoning models require a separate reviewed spending contract before public authoring can use them. The Grok 4.7 CLI development workers are separate from the hosted authoring model.

Actual safe integer provider ticks remain authoritative. One USD contains 10^10 ticks. Reservations round known charges up to micro-USD. A tariff fallback requires known reasoning usage and conservatively adds it to completion usage. This can overestimate formats that already include reasoning in completion usage. Missing reasoning usage without an actual charge keeps the reservation uncertain. An uncertain charge is never zero.

Public host access, secure model credentials, approved request/daily/benchmark budgets and 180 fresh qualification trials remain pending. These changes do not authorize spending. Recheck the provider contract and prices before enabling a live deployment.

The qualification harness also needs a reviewed worst-case attempt price. `UBC26_ATTEMPT_PRICE_MICRO_USD` is a reservation bound, not an expected average. For the exact model and current limits above, it must cover at least 2,540,960 micro-USD per call. The harness reserves two calls per request and reconciles actual billed ticks afterwards. A controlled test's smaller synthetic price is not a live deployment price. Verify this binding and the approved aggregate benchmark cap before enabling dispatch.

Every authoring request has a nonempty system prompt and schema. A reported zero prompt count cannot support tariff fallback. Without a usable actual bill, the service keeps that reservation uncertain. An explicitly reported safe actual bill of zero remains authoritative. Search is explicitly disabled in each provider payload.


The qualification harness now enforces the reviewed live model and minimum attempt bound before any network request. `UBC26_BENCHMARK_MODEL` selects the reviewed identity. Campaign v2 fixes live mode and model for resume. Returned model identities must agree for every provider attempt. Prompt/catalog identities remain in each trial record. These source guards complement provider-price revalidation and separately approved account budgets. They do not enable live dispatch.
