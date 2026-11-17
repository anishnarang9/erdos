# Hosted qualification

Worker B owns `engine/` and this report on branch `codex/hosted-qualification`. The source base is `c21ec6e`. The reviewed main is `6ed9d2d`.

## Frozen corpus

The corpus id is `hosted-qualification-2026-11-16`. The canonical digest is `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470`.

The digest is the SHA-256 hex of `JSON.stringify(canonicalCorpus())`. The payload pins prompts, outputs, references, example fixtures, clarification rows, facets, and boundaries.

The previous digest is `ab560ef0ab5fe955823c86c4ea3a0a1c7998cf58d3b60f4564cdf42faeac4cc6`. That pin covered facets, boundaries, and outputs. It came before this public-input correction.

This correction changes public author input. Each of the 20 rubric requests now declares an output name and format. Each of the four signed prompts now states the approved Ed25519 public key. Each signed request also carries two public example fixtures. The canonical payload now pins `exampleFixtures` and `clarifications`. Paid trials remain 0. This correction is the freeze before a live trial.

The hidden digest is `591f9766bbb51388f6f488781826ce1e33da236de5ece8608b2fbc9bf23d2d10`. It covers plans, specs, requirements, reference bytes, and candidate files. That digest matches the corpus at the previous pin. The 40/10/10 split and the ten families stay in place. The predicates stay in place.

The stripped payload hash differs from `ab560ef0ab5fe955823c86c4ea3a0a1c7998cf58d3b60f4564cdf42faeac4cc6`. It also differs from `621ac9137f29ee3969150da63430860af0f9c706d3745aafbb1a374f72953391`. The four signed prompts changed.

## Public fixtures

`seal-1`, `crate-1`, `transfer-1`, and `dual-seal-1` each have `illustrative-pass` and `illustrative-verdict-0`. The pass fixture has engine verdict 1. The second fixture has a valid signature and engine verdict 0. A flipped signature is a rejection. The rejection stays separate from verdict 0.

The fixture bytes are new label, card, slip, manifest, and tag text. They differ from the held-out candidate bytes.

The preview context uses synthetic chain `aa`, escrow `bb`, job `cc`, and provider `dd`. Its rules hash and reference hash are the frozen checker bindings. Engine eval requires those two bindings. The context is a static preview. Prove still requires the real chain context. This worker left the engine unchanged.

`draftInput` copies `exampleFixtures` exactly when a request has them. The body contains the prompt, outputs, references, fixtures, empty clarifications, `expirySeconds` 3600, and `maxBudget` `"10000"`. The body omits plans, specs, candidates, and expected labels. The model input has the public key. It has no signing key.

## Host comparison

`host-run.mjs` uses `UBC26_ENGINE` when that variable names an executable file. Otherwise it uses the repo-relative file `engine/target/debug/engine`. A missing file stops the command. The diagnostic names no personal home path.

The operator set `UBC26_ENGINE` to the existing debug executable. `node engine/evaluation/hosted-qualification/host-run.mjs` exited 0. The report compared 326 cases and recorded 0 failures.

## Trial harness

Real model trials are 0. `node engine/evaluation/hosted-qualification/trials.mjs` exited 0. The JSON reported `paidTrialsRan` false, `freshTrials` 0, `qualificationPassed` false, and reason `missing-deployment`.

The harness reads `UBC26_BENCHMARK_API_KEY_1`, `UBC26_BENCHMARK_API_KEY_2`, and `UBC26_BENCHMARK_API_KEY_3`. One service key supplies no third trial. `loadDeployment` sets `dispatch` false and `live` false. A closed deployment makes no service call.

`POST /v1/tasks` can return 202 when the service accepts the task. The harness then polls `GET /v1/tasks/:id` until `succeeded`, `failed`, or `uncertain`, or until the poll limit. Status 202 shows an enqueue. The client sends one draft POST for each trial. The client sends no repair.

A fresh trial requires a POST, task state `succeeded`, one distinct task id, and distinct provider trace ids. A replay header, a repeated task id, a missing trace, or a later GET is stale. `result.qualification.repairCount` is the repair count. `task.attempt` is the queue attempt count. A missing qualification value stays null.

The tests cover three owners, distinct terminal task ids, distinct trace ids, resume, the ledger lock, the budget cap, exact tick costs, and missing access. A clarification result and an unsupported result with no qualification block stay unfresh. Their reason is `qualification-metadata-missing`.

`cost_in_usd_ticks` is the billed charge. `10000000000` ticks equal 1 USD. The harness stores the raw integer. It reconciles micro-USD only when that integer divides evenly by `10000`. `result.billing.microUsd` is a tariff estimate. A tariff estimate leaves the reservation at the ceiling. Unknown or uneven ticks hold the two-attempt ceiling. Scope `benchmark` is the only scope that can reserve this ledger.

The harness checks a returned supported plan with the engine. It scores the hidden candidates with the independent oracle. The harness adds no nonce text to a frozen prompt.

The aggregate stays closed without fresh live trials. A pass requires zero false accepts and zero malformed accepts. At least 95 percent of supported trials need semantic agreement after at most one repair. Quotes must be verbatim. Ambiguous drafts must invent no policy. Unsupported drafts must stay off the payable path. Mean actual cost must be below `100000` micro-USD. `fundingApproval` stays false. `qualificationPassed` stays false while `live` is false.

The ledger reserves two attempt prices before the POST. The write is atomic and mode `0600`. A lock covers reservation and the create POST. A second process with the same ledger key performs a GET. The benchmark cap is separate from public service scope.

## Current handler probe

This worker posted the 60 `draftInput` bodies to the local handler from `createApp`. The draft model was a controlled stub. The probe reported `paidTrialsRan` false and `realModelCalls` 0. `controlledModelCalls` was 55. Five envelopes failed before the model.

`seal-1`, `crate-1`, `transfer-1`, and `dual-seal-1` failed at `/exampleFixtures` with message `unknown field`. `firmware-opaque-1` failed at `/references/0` with message `file is not UTF-8 text`. The opaque reference stays in the corpus as raw bytes. The harness still sends those fixtures and that reference.

This probe is a current-handler measurement. It is not the post-integration envelope check. It is not a semantic score. The adapter for fixtures, evidence, preview context, and non-UTF-8 references is absent from the coordinator API source. This worker left `commerce/api` unchanged.

## API billing and metadata

This worker read the coordinator source on 2026-11-16.

`authoringCharge` uses `costInUsdTicks` when that value is a safe nonnegative integer. The conversion raises a partial micro-USD to the next micro-USD. `quoteAuthoringCost` ignores ticks. It remains the tariff fallback. Settlement can record source `actual`, `tariff`, or `mixed`.

The first prompt bound uses the request text length divided by 4. That estimate omits the catalog, the references, the outputs, and the fixtures. The repair bound uses the first reply prompt-token count and the maximum completion cap. It omits the added repair prompt. `loadDeployment` keeps dispatch false.

The handler adds `result.qualification` only when the response kind and the model result kind are both `draft`. Clarification results and unsupported results omit repair count, usage, and trace ids. The public qualification object omits provider trace ids. The drafts table stores attempt trace ids. The task view returns the handler response.

## Commands

All commands ran from this worktree. Set `UBC26_ENGINE` to the debug executable for the host and engine tests. Node may print a `NO_COLOR` warning when the environment sets `FORCE_COLOR`. The listed exits ignore that warning.

- The rubric output test and the missing-key test exited 1 before the correction.
- `UBC26_ENGINE=<debug executable> node --test engine/evaluation/hosted-qualification/*.test.mjs` exited 0. 31 tests passed.
- `UBC26_ENGINE=<debug executable> node engine/evaluation/hosted-qualification/host-run.mjs` exited 0. `compared` is 326. `failures` is 0.
- `node engine/evaluation/hosted-qualification/trials.mjs` exited 0. `paidTrialsRan` is false. `freshTrials` is 0. `qualificationPassed` is false.
- The local handler probe exited 0. `paidTrialsRan` is false. `realModelCalls` is 0. `controlledModelCalls` is 55. `rejectedBeforeModel` is 5.

## Commits

`5cd66a8` publishes the rubric outputs, the approved public keys, the illustrative fixtures, and digest `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470`.

`f273ffe` pinned the earlier rubric fields. The coordinator integrated that commit as `3f217b2`. `4ea2841` requires an explicit engine. `1e0409d` requires three owners and fresh terminal trials. `4ab83c7` recorded the previous digest.

## Blockers

Three distinct wallet-owned benchmark keys are absent. The user has not authorized a Grok call. Host, account, and benchmark caps remain pending.

The API draft body still rejects `exampleFixtures`. It still rejects a non-UTF-8 reference before the model. Qualification metadata is still limited to draft results. Provider trace ids are still absent from the task result. The first and repair prompt bounds still omit part of the prompt. This harness keeps dispatch false across that gap.

## Remaining gaps

The visit-bound case is not run. Guest execution of this corpus is not run. Fresh proofs are not run. Solidity receipt checks are not run. This worker did not rerun the 10,000-case seeded suite or cargo.

No server benchmark mode is present in the API. The harness adds none. Public semantic deduplication stays in place. Equal draft inputs from one owner remain one task.
