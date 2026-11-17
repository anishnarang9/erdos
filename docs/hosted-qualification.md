# Hosted qualification

Worker B owns `engine/` and this report on branch `codex/hosted-qualification`. The source base is `c21ec6e`. The reviewed main is `6ed9d2d`. Qualification is not complete.

## Frozen corpus

The corpus id is `hosted-qualification-2026-11-16`. The canonical digest is `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470`.

The digest is the SHA-256 hex of `JSON.stringify(canonicalCorpus())`. The payload pins prompts, outputs, references, example fixtures, clarification rows, facets, and boundaries.

The previous digest is `ab560ef0ab5fe955823c86c4ea3a0a1c7998cf58d3b60f4564cdf42faeac4cc6`. That pin covered facets, boundaries, and outputs. It came before the public-input correction.

The public-input correction changed author input before any paid trial. Each of the 20 rubric requests declares an output name and format. Each of the four signed prompts states the approved Ed25519 public key. Each signed request has two public example fixtures. The canonical payload pins `exampleFixtures` and `clarifications`.

The hidden digest is `591f9766bbb51388f6f488781826ce1e33da236de5ece8608b2fbc9bf23d2d10`. It covers plans, specs, requirements, reference bytes, and candidate files. This review leaves those bytes in place. The 40/10/10 split and the ten families stay in place. The predicates stay in place.

This review adds no corpus bytes. The canonical digest stays `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470`.

The stripped payload hash differs from `ab560ef0ab5fe955823c86c4ea3a0a1c7998cf58d3b60f4564cdf42faeac4cc6`. It also differs from `621ac9137f29ee3969150da63430860af0f9c706d3745aafbb1a374f72953391`. The four signed prompts changed in the public-input correction.

## Context lock

The four public preview contexts bind the hidden plan rules hash. Chain bytes are synthetic `aa`. Escrow bytes are synthetic `bb`. Job bytes are synthetic `cc`. Provider bytes are synthetic `dd`. The reference hash is the request reference hash.

The coordinator review file is `/tmp/ubc26-hosted-signed-context-review.json`. The driver is `/tmp/ubc26-hosted-signed-context-review.mjs`. Status is `confirmed-context-lock`. The model was not called. One extra literal true rule fails all four public pass fixtures. The message is `Rules hash differs from the funded context`.

This worker reproduced that result for `seal-1`, `crate-1`, `transfer-1`, and `dual-seal-1`. `engine validate` accepts the extra rule. The returned rules hash differs from the frozen rules hash. `engine eval` of each frozen pass fixture exits 2. `engine eval` of each frozen verdict-0 fixture exits 2. The code is `invalid_deliverable`. The message is `Rules hash differs from the funded context`.

The original plan still has engine verdict 1 on `illustrative-pass`. It has engine verdict 0 on `illustrative-verdict-0`. A rules-hash mismatch stays a failed example.

The guest runtime compares the context rules hash with the plan rules hash. It also compares the reference hash. This worker leaves that binding in place. Eval may use synthetic chain, escrow, job, and provider bytes. Those bytes do not fund a chain job. Prove still requires the real chain context.

## Semantic score and approval

`assessSupportedDraft` checks the returned plan. It builds the grader context from the returned rules hash. It then signs the hidden candidate evidence. The model receives no signing key. On all four signed requests, the engine result matches the independent oracle. `scoreTrial` keeps `semanticAgreement` true. `falseAccepts` is 0. `malformedAccepts` is 0. `validInputFalseRejects` is 0.

`separateDraftScores` copies that semantic Boolean. The two locked fixtures have outcome `rules-hash-differs`. `approvalReady` is false. `passCount` is 0. A caller cannot clear that outcome by flipping `blocksApproval`.

Example outcome `pass` means engine verdict 1. Example outcome `verdict-0` means engine verdict 0. Outcome `reject` blocks approval. One pass with no verdict 0 blocks approval. A false semantic score blocks approval when both example outcomes are present.

`aggregateGates` requires a semantic rate of at least 0.95. It requires zero false accepts and zero malformed accepts. `fundingApproval` in that function stays false. `approvalReady` is an example gate. It does not fund a job. `qualificationPassed` stays false while `live` is false.

## Plan acceptance wording

Package 4 includes tasks with multiple valid solutions. Acceptance is not an expected-answer hash.

The sprint semantic gate counts an engine-valid draft with semantic agreement. The rate is at least 95 percent of supported trials. The repair limit is one.

A later gate blocks funding for a failed draft and for an incomplete draft. `docs/hosted-api-contract.md` keeps compile approval and revision binding mandatory.

The coordinator file `docs/hosted-authoring-examples.md` requires one genuine passing example before approval. It also requires one structurally valid verdict-0 example. An invalid signature, missing evidence, or malformed bundle is a rejection.

That wording supports a semantic draft score and a later approval gate. The public server has no trusted signer. A rules-hash mismatch stays outside the semantic score.

## Buyer example check

This worker proposes the check below for coordinator and API review. Commit `ac51659` adds no server route.

The buyer calls `POST /v1/drafts/:draftId/example-checks` on a stored draft. The caller uses the buyer credential. The path `draftId` equals the body `draftId` and the stored draft. The `If-Match` header and the body `revisionHash` equal the stored revision hash. A mismatch returns 409 `revision_conflict`.

```json
{
  "draftId": "<stored draft id>",
  "revisionHash": "0x<64 hex characters>",
  "examples": [
    {
      "name": "buyer-pass",
      "predictedVerdict": 1,
      "files": [{"name": "label.txt", "content": "<text>", "encoding": "utf8"}],
      "evidence": [{"name": "custody.json", "content": "<envelope>", "encoding": "utf8"}],
      "context": "0x01<336 hex characters>"
    }
  ]
}
```

Each example has `name`, `predictedVerdict` of 0 or 1, `files`, optional `evidence`, and `context`. Each file has `name`, `content`, and optional `encoding` of `utf8` or `base64`. `context` is version-1 funded-context hex.

The handler calls no model. It signs nothing. It reads no hidden plan, candidate, oracle, or signing key. It runs `engine eval` on the stored plan, the stored reference, the buyer files, the buyer evidence, and the buyer context.

The context rules hash must equal the stored revision rules hash. The context reference hash must equal the stored reference hash. This check accepts synthetic chain, escrow, job, and provider bytes. They do not fund a chain job.

```json
{
  "draftId": "<stored draft id>",
  "revisionHash": "0x<64 hex characters>",
  "exampleApprovalReady": false,
  "examples": [
    {
      "name": "buyer-pass",
      "predictedVerdict": 1,
      "outcome": "rules-hash-differs",
      "blocksApproval": true
    }
  ]
}
```

The response repeats `draftId` and `revisionHash`. `exampleApprovalReady` is true only with one verdict 1, one verdict 0, and zero blockers. The handler does not compute `semanticAgreement`. The qualification harness keeps that score on hidden candidates. Funding approval needs both gates, plus the live, cost, quote, and repair gates.

A frozen illustrative context that binds another rules hash fails this check. The buyer supplies new files, evidence, and a context for the stored revision.

## Resource bounds

The visit plan has three nested `all` operations and one record field. That plan has 4 expression nodes. The typecheck cap is 256 nodes. The collection cap is 256 rows. The runtime visit cap is 1000000 nodes.

`engine validate` exits 0 for 99 rows and for 100 rows. Eval of 99 true rows exits 0 with verdict 1. Eval of one false row exits 0 with verdict 0. Eval of 100 true rows exits 2. The code is `invalid_deliverable`. The message is `Invalid rule expression`.

Thirty nested `not` operations around literal true pass `engine validate`. Eval exits 0 with verdict 1. Thirty-two nested `not` operations fail `engine validate` with exit 2. The code is `invalid_plan`. The message is `Rules exceed the depth or node limit`. This worker leaves those caps in place.

## Host comparison

`host-run.mjs` uses `UBC26_ENGINE` when that variable names an executable file. Otherwise it uses `engine/target/debug/engine`. A missing file stops the command. The diagnostic names no personal home path.

This worker set `UBC26_ENGINE` to the existing debug executable. `node engine/evaluation/hosted-qualification/host-run.mjs` exited 0. The report compared 326 cases and recorded 0 failures.

## Trial harness

Real model trials are 0. `node engine/evaluation/hosted-qualification/trials.mjs` exited 0. The JSON reported `paidTrialsRan` false, `freshTrials` 0, `qualificationPassed` false, and reason `missing-deployment`.

The harness reads `UBC26_BENCHMARK_API_KEY_1`, `UBC26_BENCHMARK_API_KEY_2`, and `UBC26_BENCHMARK_API_KEY_3`. `loadDeployment` sets `dispatch` false and `live` false. A closed deployment makes no service call.

A fresh trial requires a POST, task state `succeeded`, one distinct task id, and distinct provider trace ids. `result.qualification.repairCount` is the repair count. `task.attempt` is the queue attempt count.

`cost_in_usd_ticks` is the billed charge. `10000000000` ticks equal 1 USD. A known safe tick total reserves the smallest integer micro-USD that covers the charge. The qualification mean uses the raw tick total. A missing or invalid tick total leaves the reservation at the ceiling.

The coordinator integrated request preflight `2a1248c` as `84f4252`. That commit rejects a model call unless the full provider payload fits. This report does not repeat the earlier prompt-budget finding. This worker did not re-test the API.

The harness retains exact billed ticks for qualification. It rounds a known bill up to covering integer micro-USD for reservations. A tariff estimate or missing/invalid actual bill keeps the full reservation. Scope `benchmark` is the only scope that can reserve this ledger. See [current public model spending bounds](hosted-model-costs.md) for the separate service preflight contract.

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

Coordinator checkpoint `84f4252` replaces the text-only estimate with the full serialized provider payload and the supported completion maximum. The repair bound includes its feedback. Independent model/task checks pass 6/6 and focused API checks pass 50/50 with typecheck. Spend halt `09a36d4` passes 29 focused API checks and typecheck. Historical-breach migration, child isolation and the request-wide deadline remain open. `loadDeployment` keeps dispatch false.

The handler adds `result.qualification` only when the response kind and the model result kind are both `draft`. Clarification results and unsupported results omit repair count, usage, and trace ids. The public qualification object omits provider trace ids. The drafts table stores attempt trace ids. The task view returns the handler response.

This worker read `commerce/api/src/authoring.ts` in the hosted-backend worktree on 2026-11-16. The draft key list there is `request`, `outputs`, `references`, `clarifications`, `expirySeconds`, and `maxBudget`. `exampleFixtures` is absent from that list. This worker did not edit that tree.

## Commands

All commands ran from this worktree. Set `UBC26_ENGINE` to the debug executable for the host and engine tests. Node may print a `NO_COLOR` warning when the environment sets `FORCE_COLOR`. The listed exits ignore that warning.

- `UBC26_ENGINE=<debug executable> node --test engine/evaluation/hosted-qualification/*.test.mjs` exited 0. 36 tests passed. 0 failed.
- `UBC26_ENGINE=<debug executable> node engine/evaluation/hosted-qualification/host-run.mjs` exited 0. `compared` is 326. `failures` is 0.
- `node engine/evaluation/hosted-qualification/trials.mjs` exited 0. `paidTrialsRan` is false. `freshTrials` is 0. `qualificationPassed` is false.

The suite at `5cd66a8` had 31 tests. The coordinator integrated that commit as `f25223f` and recorded those 31 tests plus 326 cases with 0 disagreement. Commit `ac51659` adds four tests. Host comparison stays at 326 cases and 0 failures.

## Commits

`ac51659` keeps the semantic score when a preview context locks the rules hash. It adds the visit-cap regression and the rule-depth regression.

`5cd66a8` publishes the rubric outputs, the approved public keys, the illustrative fixtures, and digest `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470`. The coordinator integrated that commit as `f25223f`.

## Runner evidence review

This worker read commit `f314f59` on the hosted-backend branch. The review file is `docs/hosted-runner-evidence-review.md`. This worker did not edit that tree.

The installed check command hides an invalid-signature rejection. Verdict 0 still returns JSON and exit 0. The review gives the stub input and the line numbers.

The coordinator integrated `ac51659` as `9385f2c`. The coordinator reports 35 Node checks passed for that integration. This worker did not rerun that suite.

The coordinator file `agents/anish/reports/hosted-corpus-guests-2026-11-16.json` records status `passed-finite-guest-corpus`. It records 40 compiled plans, 316 cases, and 0 failures. This worker did not run that comparison. Real model calls remain 0.

## Blockers

Three distinct wallet-owned benchmark keys are absent. The user has not authorized a Grok call. Host, account, and benchmark caps remain pending.

The API draft body still rejects `exampleFixtures`. It still rejects a non-UTF-8 reference before the model. Qualification metadata is still limited to draft results. Provider trace ids are still absent from the task result. The old incomplete prompt bound is repaired at `84f4252`. Signed public fixtures still bind the original checker rules hash. A valid semantically equivalent draft cannot reuse those signatures. See the coordinator signed-preview review. An immutable external witness completion step needs review. This harness keeps dispatch false across that gap.

The buyer example route is a proposal. The coordinator API tree has no such route. `qualificationPassed` stays false. `fundingApproval` stays false.

## Remaining gaps

This worker did not run guest execution of this corpus. The coordinator guest report records a finite pass. This worker did not reproduce it. This worker did not run fresh proofs. This worker did not run Solidity receipt checks. This worker did not rerun the 10,000-case seeded suite or cargo. This worker started no guest compile, proof, container, prover, or paid API call. The coordinator owns the compiler allocation.

No server benchmark mode is present. Public semantic deduplication stays in place. Equal draft inputs from one owner remain one task.

## Remaining constraints

- The engine context binding stays unchanged.
- Hidden plans, candidates, oracles, and specs stay out of model input.
- Signing keys stay out of model input. The public server has no trusted signer.
- A failed example stays failed. The positive example and the verdict-0 example both stay required.
- The semantic rate stays at least 0.95. The predicates stay in place.
- Frozen prompts gain no nonce text. Public semantic deduplication stays in place.
- Illustrative fixture contexts stay previews of the hidden plan hash. They do not approve a different plan.
- Real trials stay 0. Public access and model budgets remain pending.
