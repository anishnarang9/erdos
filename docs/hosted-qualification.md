# Hosted qualification

Worker B owns `engine/` and this report on branch `codex/hosted-qualification`. The source base is `c21ec6e`. The reviewed main is `6ed9d2d`.

## Frozen corpus

The corpus id is `hosted-qualification-2026-11-16`. The canonical digest is `ab560ef0ab5fe955823c86c4ea3a0a1c7998cf58d3b60f4564cdf42faeac4cc6`.

The digest is the SHA-256 hex of `JSON.stringify(canonicalCorpus())`. The canonical payload now includes `facets`, `boundary`, and declared `outputs`.

The previous digest `621ac9137f29ee3969150da63430860af0f9c706d3745aafbb1a374f72953391` omitted those fields. A change of the first ambiguous `facets` to `['altered rubric']` and the first unsupported `boundary` to `altered boundary` left that digest unchanged. The same payload with `facets`, `boundary`, and `outputs` removed still hashes to the previous digest. The pin keeps prompts, reference bytes, plans, and constraints.

The corpus contains 40 supported requests, 10 ambiguous requests, and 10 unsupported requests. The supported requests cover 10 families.

## Host comparison

`host-run.mjs` uses `UBC26_ENGINE` when that variable names an executable file. Otherwise it uses the repo-relative file `engine/target/debug/engine`. A missing file stops the command. The diagnostic names no personal home path.

`--help`, an unknown challenge id, and an ambiguous-only selection exit 2. Those reports omit `compared`.

The operator set `UBC26_ENGINE` to the existing debug executable. `node engine/evaluation/hosted-qualification/host-run.mjs` exited 0. The report compared 326 cases and recorded 0 failures. Those cases are the supported candidates and the 10 unsupported capability comparisons.

## Trial harness

Real model trials are 0. `node engine/evaluation/hosted-qualification/trials.mjs` exited 0. The JSON reported `paidTrialsRan` false, `freshTrials` 0, `qualificationPassed` false, and reason `missing-deployment`.

The harness reads `UBC26_BENCHMARK_API_KEY_1`, `UBC26_BENCHMARK_API_KEY_2`, and `UBC26_BENCHMARK_API_KEY_3`. One service key does not supply three trials. `loadDeployment` sets `dispatch` false and `live` false. A closed deployment does not call the service.

`POST /v1/tasks` can return 202 when the service accepts the task. The harness then polls `GET /v1/tasks/:id` until `succeeded`, `failed`, or `uncertain`, or until the poll limit. Status 202 does not prove a paid model call. The client sends one draft POST for each trial. The client does not send a repair.

A fresh trial requires a POST, task state `succeeded`, a distinct task id, and distinct provider trace ids. A replay header, a repeated task id, a missing trace, or a later GET is not fresh. `result.qualification.repairCount` is the repair count. `task.attempt` is the queue attempt count. A missing qualification value stays null.

The current draft handler attaches qualification metadata only when the model result kind is `draft`. Clarification results and unsupported results omit that block. The task view does not include provider trace ids. The harness records `qualification-metadata-missing` or `provider-trace-missing`. It does not create those values.

`cost_in_usd_ticks` is the billed charge. `10000000000` ticks equal 1 USD. The harness stores the raw integer. It reconciles micro-USD only when that integer divides evenly by `10000`. `result.billing.microUsd` is a tariff estimate. A tariff estimate does not close the reservation. Unknown or uneven ticks hold the two-attempt ceiling. Scope `benchmark` is the only scope that can reserve this ledger.

The harness checks a returned supported plan with the engine. It scores the hidden candidates with the independent oracle. The draft body contains the prompt, declared outputs, references, empty clarifications, `expirySeconds` 3600, and `maxBudget` `"10000"`. The body omits plans, specs, candidates, and expected labels. The harness does not add nonce text to a frozen prompt.

The aggregate stays closed without fresh live trials. A pass requires zero false accepts and zero malformed accepts. At least 95 percent of supported trials need semantic agreement after at most one repair. Quotes must be verbatim. Ambiguous drafts must not invent policy. Unsupported drafts must not become weaker payable jobs. Mean actual cost must be below `100000` micro-USD. `fundingApproval` stays false. `qualificationPassed` stays false while `live` is false.

The ledger reserves two attempt prices before the POST. The write is atomic and mode `0600`. A lock covers reservation and the create POST. A second process with the same ledger key performs a GET. Unknown billing remains at the ceiling. The benchmark cap is separate from public service scope.

## Commands

All commands ran from this worktree. Set `UBC26_ENGINE` to the debug executable for the host and engine tests. Node may print a `NO_COLOR` warning when the environment sets `FORCE_COLOR`. The listed exits ignore that warning.

- The facet and boundary mutation test exited 1 before the digest pin.
- `node --test --test-name-pattern 'frozen corpus|rubric facet' engine/evaluation/hosted-qualification/suite.test.mjs` exited 0. 2 tests passed.
- `UBC26_ENGINE=<debug executable> node --test engine/evaluation/hosted-qualification/*.test.mjs` exited 0. 24 tests passed.
- `UBC26_ENGINE=<debug executable> node engine/evaluation/hosted-qualification/host-run.mjs` exited 0. `compared` is 326. `failures` is 0.
- `node engine/evaluation/hosted-qualification/trials.mjs` exited 0. `paidTrialsRan` is false. `freshTrials` is 0. `qualificationPassed` is false.

## Commits

`f273ffe` pins the rubric fields and replaces the digest. `4ea2841` requires an explicit engine and rejects an empty host selection. `1e0409d` requires three owners and fresh terminal trials.

The coordinator integrated corpus checkpoint `a71f980` as `72899aa`. That integration predates the digest pin and the trial harness.

## Blockers

Three distinct wallet-owned benchmark keys are absent. The user has not authorized a Grok call. Host and account budgets are not available in this session.

The API task view still needs qualification and cost metadata for clarification and unsupported results. It still needs provider trace ids. `quoteAuthoringCost` ignores `cost_in_usd_ticks`. This harness does not dispatch around that gap.

## Remaining gaps

The visit-bound case is not run. Guest execution of this corpus is not run. Fresh proofs are not run. Solidity receipt checks are not run. This worker did not rerun the 10,000-case seeded suite or cargo.

No server benchmark mode is present in the API. The harness does not add one. Public semantic deduplication stays in place. Equal draft inputs from one owner remain one task.
