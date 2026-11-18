# Authoring final review

This review reads commits `048c0f2`, `3a97c24`, `b0acab9`, `4f3ae05`, and `94218d2` on branch `codex/hosted-backend`. HEAD during this review is `94218d2`. One uncommitted shutdown test expects a model abort during drain. The coordinator already owns that shutdown gap. This review did not edit that tree.

## Defect

A missing actual charge settles at zero micro-USD.

`commerce/api/src/grok.ts` line 510 assigns `reasoningTokens` 0 when model `grok-4.20-0309-non-reasoning` omits reasoning tokens. `commerce/api/src/authoring.ts` lines 508-523 then settle a tariff for that usage. Zero token counts and no `cost_in_usd_ticks` produce a settled bill of 0. `commerce/api/src/tasks.ts` lines 465-472 accept micro-USD 0 and `settleKnown` at lines 272-274 stores `settled_micro_usd` 0.

`docs/hosted-model-costs.md` says a charge without ticks stays on the tariff only with reported reasoning usage. The same paragraph says an uncertain charge is never zero.

## Reproduction

`POST /v1/drafts` used the buyer token, a fresh idempotency key, and the standard draft body. The budget rates were `2500000` and `5000000` micro-USD per million. The adapter was `grok-4.20-0309-non-reasoning` with an injected fetch and no network call.

The provider body had id `trace-unknown`, model `grok-4.20-0309-non-reasoning`, and usage `prompt_tokens` 0 plus `completion_tokens` 0. It had no `cost_in_usd_ticks` field and no reasoning field. `finish_reason` was `stop`. The content was a clarification with one question.

The route returned 200. `billing` was `{"state":"settled","microUsd":0,"source":"tariff"}`. `qualification.usage[0].reasoningTokens` was 0. `costInUsdTicks` was null.

The same call with `prompt_tokens` 32 and `completion_tokens` 9, still without ticks, settled a tariff of 125 micro-USD. The adapter drops non-integer `cost_in_usd_ticks` `1.5` and settles that same tariff.

## Other items

No other concrete issue.

`cliEngine.eval` reads `evidence`, `context`, and `signal`. The child argv gains `--evidence` and `--job` when those values are present. Buyer `POST /v1/drafts/:draftId/example-checks` evaluates the stored plan and stored references. A foreign wallet receives 404. A different revision receives 409. An added plan field receives 400. Failed signatures stay at `checkerVerdict` null. `usableExamples` counts verdict 0 only when `agrees` is true. Approval stores the exact check id and coverage digest. SQL triggers abort update and delete of `example_checks`. One draft controller lasts 120000 ms through repair. Public mode rejects an adapter without `outputTokenBound`. The exact non-reasoning adapter prices `1000000` prompt tokens at the higher of the local estimate and that context cap. It also requires the documented highest tier rates.


## Coordinator resolution — 2026-11-17

The zero-prompt reproduction identifies a real tariff inconsistency. Every request contains a nonempty prompt and schema. Commit `49d56e9` therefore rejects zero prompt usage for tariff fallback and keeps the bill uncertain. Its regression failed before the fix. An explicit usable actual bill of zero remains authoritative.

The missing reasoning field alone is not the defect for this exact reviewed non-reasoning model. Its documented model contract establishes zero reasoning. Complete positive prompt/output counts can still support a conservative tariff without actual billed ticks. Invalid or absent ticks are not converted to an actual zero charge. Raw billed ticks remain required by real qualification's cost evidence. Other reviewed ownership, witness and deadline checks remain as reported above.
