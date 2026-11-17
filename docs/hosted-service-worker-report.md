# Hosted service worker report

Worker A. Branch `codex/hosted-service`. This file is the contract correction record. The coordinator owns `docs/hosted-api-contract.md`.

## Contract corrections

Challenge message is six lines. The SDK already validates this shape. Do not change it.

```
UBC26-HOSTED-AUTH-v1
service: <origin>
wallet: <lowercase address>
action: issue-api-key
nonce: <base64url 32 bytes>
expires: <ISO-8601 timestamp>
```

`POST /v1/auth/keys` returns 200. The raw key is returned once. A second use of the challenge returns 401. Revoking another wallet's key returns 404. Dates in challenge, key and task views are ISO strings.

Selected-provider `fundingTerms` includes `buyer` when the caller is a wallet API key. The value is the checksum of that wallet. Legacy local sessions omit `buyer`. Their key list stays the same. `POST /v1/jobs/:id/funding-receipt` rejects a wallet caller when the confirmed job `client` is not that wallet. The code is `terms_mismatch` and the field is `client`. Legacy local callers do not use this check. Open-claim terms stay on their five-step path. Circle replay behavior is unchanged.

`POST /v1/tasks` requires a wallet API key. The shared local bearer returns 401. The task row stores the wallet. It does not store the raw key. A legacy caller cannot create a task.

The route returns 202 and the task view. The same owner, operation, and canonical input match an existing `queued`, `running`, `succeeded`, or `uncertain` task. That match also returns 202 and the existing view. It does not start the handler again. A `failed` task does not match. A new idempotency key may retry it. Two wallets do not share one task. Idempotency replay stays separate from this match. Replay still returns the stored 202.

`GET /v1/tasks/:id` returns 404 when the task is missing or belongs to another wallet. Unknown body fields return 400 `validation_failed`. A compile for another wallet's job returns 404 before the rate limit. The stored compile hash is lowercase.

Task dates are ISO strings. `attempt` starts at 0. It increases by 1 when the runner starts the handler. The view field `error` is `{code, message, details?}`. It is not wrapped again. A non-API exception becomes `{code:"internal", message:"Internal server error"}`. The view omits private paths and raw model text.

On restart, a running draft becomes `uncertain`. The runner does not start it again. A running compile returns to `queued`. The runner may start that compile again. At most one compile and two drafts run at one time. Each run calls the existing draft or compile handler for that owner and revision.

Authoring budget is not in the coordinator contract. It is a service charge. It is not an escrow bounty. When budget config is set, a draft reserves `requestCeilingMicroUsd` in the same transaction as the task insert. The reserve happens before the handler runs. Public mode rejects a draft when that config is absent. The code is `model_unavailable` and the message is `Authoring price is not configured`. No task row is inserted. The model is not called. When the UTC-day sum plus the new ceiling exceeds `dailyCeilingMicroUsd`, the route returns 429 `rate_limited` with message `Authoring budget is exhausted`. That insert rolls back. The day sum includes `reserved`, `settled`, and `uncertain` rows. A settled row counts `settled_micro_usd` when that value is present. Otherwise the row counts its ceiling. A `released` row is excluded. Compile tasks do not reserve this budget.

Migration `013_dispatch.sql` adds nullable `dispatched_at` and `usage_json` on `spend_reservations`. It does not delete historical rows. The runner writes `dispatched_at` before the model call when a task id and a budget are both set. A second repair call does not replace the first timestamp.

These codes release a reservation only when `dispatched_at` is null: `validation_failed`, `model_unavailable`, `not_found`, `unauthorized`, `forbidden`, `payload_too_large`, `approval_required`, `wrong_state`, `revision_conflict`. After dispatch, the same codes keep the ceiling in state `uncertain`. `model_failed` and other failures also keep the ceiling. Missing or inconsistent usage keeps the ceiling. The cost is not recorded as zero in that case.

When every returned attempt has complete usage, the service settles one charge per attempt. A safe nonnegative `cost_in_usd_ticks` value is the actual billed amount. xAI defines 10^10 ticks per USD. One micro-USD is `ceil(ticks / 10000)`. That value is not a tariff rate. When ticks are absent or not a safe nonnegative integer, the service uses the token tariff and keeps the token counts. The tariff uses input, output, and optional cached prices. A missing cached price uses the input price. The earlier claim that reasoning tokens are not added again on top of completion tokens is superseded. Exact `cost_in_usd_ticks` stay authoritative. A tariff fallback must add reasoning usage and visible completion usage. Unknown reasoning with no bill stays `uncertain`. The coordinator will change only `usageComplete` and `quoteAuthoringCost`. This service does not edit those functions. The settled amount may exceed the ceiling. The row then stores `breach` 1 and the actual amount. The ceiling column does not change. An unknown bill stays `uncertain` with `settled_micro_usd` null. It is not stored as zero.

A budget number that is not a positive safe integer throws at `createApp` before the database opens when that object is passed in. Prices are operator configuration. `d0bd57b` reads the authoring ceiling variables in `server.ts`. An invalid set exits before `createApp` in local mode and in public mode. `server.ts` reads `OPERATOR_TOKEN` when it is set. The process does not log that token. These commits do not permit a live spend.

UTF-8 reference files are sent in full up to the existing 32 KiB cap. A non-UTF-8 file returns `validation_failed` before dispatch. The service does not substitute a summary for the file. The earlier claim that `max_tokens` is the completion maximum is superseded. `max_completion_tokens` and deprecated `max_tokens` bound visible output only. They do not bound reasoning. Grok 4.7, Grok 4.6, and Grok 4.5 cannot disable reasoning. Only the exact model `grok-4.20-0309-non-reasoning` advertises a total output bound. It also advertises `providerCostBound` with `maxPromptTokens` 1000000, `inputMicroUsdPerMillion` 2500000, and `outputMicroUsdPerMillion` 5000000. The coordinator will reconcile `grok.ts` and the authoring sections. This service does not edit those files. The current adapter still does not send penalties, `stop`, tools, or `reasoning_effort`. Finish reason `length` or `content_filter` fails the call and keeps usage when the provider sent it. A missing finish reason remains valid. An oversized provider stream is cancelled before the rest of the body is parsed. The prompt says the model has no wallet, cannot spend, cannot run a shell, and cannot change a contract.

Before `dispatched_at` is written, a budgeted call prices the serialized provider body. The body includes system text, the plan schema, the capability catalog, the request, outputs, clarifications, reference text, and the response schema. A repair call also includes its feedback object. The visible byte length plus 64 framing tokens is not a verified tokenizer bound. That estimate is superseded as a budget proof. Budgeted preflight must price the full 1000000 token context at the highest input tariff and 8192 output tokens at the output tariff. At the reviewed rates one call costs 2540960 micro-USD, which is $2.54096. A higher operator tariff raises that floor. The coordinator owns the authoring preflight change. The current authoring code still uses the byte estimate until that change lands. The service does not lower 8192 to make a call fit.

`d0bd57b` adds unauthenticated `GET /readyz`. A ready process returns 200. Any failed check returns 503 and the check list. `GET /healthz` stays liveness and still returns `{ok: true}`. The body does not include filesystem paths, API keys, operator tokens, or origin passwords. It does not print the configured digest. Public mode runs the same checks before listen. A failing pin, origin, chain, model, budget, rate limit, or package directory exits before `openDb`. A memory database is opened, reported `not_durable`, closed, and the process exits before listen. Local mode still listens. Its `/readyz` body stays not ready when the same checks fail. `blocksListen` is false in local mode.

Public mode requires `ENGINE_SHA256` to match the on-disk bytes of the absolute `ENGINE_PATH`. That digest is the compiler build identity. Readiness does not spawn the compiler and does not read a compile `manifest.json`. WSL also requires `ENGINE_WRAPPER_SHA256` to match the host `ENGINE_WSL_BIN` bytes. An absolute path without a matching digest is `unpinned` or `digest_mismatch`. `d0bd57b` named that host binary `compiler_wrapper`. `a7b2e5e` renames it to `wsl_wrapper`. Disk quotas are not judged here.

Public mode rejects a simulated engine, a replay model, and a recording model. `XAI_MODEL` is not accepted as a review record. The live model object must advertise id `grok-4.20-0309-non-reasoning` and the exact `providerCostBound` above. `a7b2e5e` accepts `outputTokenBound.parameter` `max_completion_tokens` with `maxTokens` 8192. It accepts `max_tokens` at that cap only after the id is already the reviewed model. Any other parameter is `output_bound_unreliable`. A missing id is `unreviewed_model` and is not treated as success. Coordinator `4135ab4` sets `id` to the configured model slug. The exact slug `grok-4.20-0309-non-reasoning` also advertises `max_completion_tokens` and the reviewed `providerCostBound`. Any other slug still fails `unreviewed_model`. This branch does not edit `grok.ts` and does not copy `XAI_MODEL` into that id. A configured live key still fails `unreviewed_model` and public mode does not listen.

`AUTHORING_REQUIRED=0` is the only explicit authoring opt-out. The report then says `authoring` is `disabled`. `a7b2e5e` adds check `authoring_release` with reason `disabled`. That check is not ok. It does not block listen. It is not full release acceptance. Public mode can still listen when no other check blocks. `/readyz` stays 503. When authoring stays required, a missing model is `model` reason `missing` and public mode does not listen. Replay and recording still fail when authoring is disabled.

Public budget variables are `AUTHORING_REQUEST_CEILING_MICRO_USD`, `AUTHORING_DAILY_CEILING_MICRO_USD`, `AUTHORING_INPUT_MICRO_USD_PER_MILLION`, and `AUTHORING_OUTPUT_MICRO_USD_PER_MILLION`. `AUTHORING_CACHED_INPUT_MICRO_USD_PER_MILLION` is optional and must not exceed the input rate. The input rate must be at least 2500000 and the output rate at least 5000000. The request ceiling must cover one call at those operator rates for 1000000 input tokens and 8192 output tokens. At the reviewed rates that floor is 2540960 micro-USD. The daily ceiling must be at least the request ceiling. Public mode requires `SERVICE_ORIGIN` to be HTTPS with a host and no userinfo. The chain must be `arc`. `RATE_LIMIT_PRINCIPAL` and `RATE_LIMIT_IP` must both be positive safe integers. `PACKAGES_DIR` must be an absolute writable directory. The probe writes one temporary file and deletes it. The database path must not be `:memory:`. A relative database path can still be durable. `d0bd57b` probed with `BEGIN IMMEDIATE` and `ROLLBACK` only. That pair succeeds on a real read-only file, so the probe reported writable. `query_only` was already rejected and is not this defect. `a7b2e5e` runs `CREATE TABLE main.ready_write_probe` inside that transaction and then `ROLLBACK`. A `DatabaseSync` opened with `readOnly: true` reports `database_write` `not_writable`. A normal file stays writable and the probe table is not left behind. The probe does not update historical rows. Applied migration names must include every file from `migrationVersions()`. A missing name is reported as `missing:` plus the file names. Migration 017 is not on this branch, so it is not required yet. The halt backfill test no longer asserts that 017 is absent. The coordinator owns that migration. A draining worker or `EXPENSIVE_OPS_DISABLED=1` makes `/readyz` not ready and does not block listen. This is not a hosted release. No model call and no compiler invocation is made just to answer readiness. The older route check that rejects a model without `outputTokenBound` parameter `max_tokens` remains in the task gate. It is not this readiness proof.

`a7b2e5e` caches one readiness evaluation for 5000 ms. Concurrent `GET /readyz` calls share that evaluation. They do not start an unlimited number of binary hash streams or package-probe writes. A draining worker overrides a cached success immediately and does not wait for an in-flight hash. `GET /healthz` stays `{ok: true}` and does not enter the cache.

Public mode with a real engine also requires `COMPILER_WRAPPER_PATH` and `COMPILER_WRAPPER_SHA256`. The reviewed path is `/opt/ubc26/docker-bin/docker`. The check hashes that file and rejects a symlink. The engine child PATH is the fixed `COMPILER_PATH` value `/opt/ubc26/docker-bin:/usr/local/bin:/usr/bin:/bin`. The first directory must be the wrapper directory and the file name must be `docker`. An unrelated file is `not_selected` even when its digest matches. A digest mismatch does not echo the path or the expected hex. Root supplies the pin. This service does not edit `deploy/`.

Public mode also requires `SOURCE_SHA`, `DOCKERFILE_FRONTEND`, and `GUEST_BUILDER_IMAGE`. The source must be 40 hex characters. The frontend must be `docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e`. The builder must be `risczero/risc0-guest-builder:r0.1.97.0@sha256:6f6c300e4af57ea3efe62b7f04a17629efe0f0caa6ad3699d6766bf19e0e62fb`. A missing or different identity blocks listen. `COMPILER_READY_PATH` must be absolute. An unset path is `unconfigured` and blocks listen. The file must be a regular file of 2 to 65536 bytes. A symlink or a larger file is `corrupt` and does not block listen. A missing file is `not_warmed` and does not block listen. Status `warming` does not block listen. A completed record has version 1, status `compiler-warmed`, passing verdict 1, failing verdict 0, `proofGenerated` false, and `chainTransactionSent` false. Its source, engine digest, frontend, and builder must match the configured identities. A wrong source is `identity_mismatch` and does not block listen. Those states keep `ready` false, so `/readyz` returns 503. They are not config errors. A warm record is not proof of a cold cache and it is not a disk quota. Readiness does not spawn the warm script.

`cd558ea` does not copy `process.env` into an engine child. The child environment is a new object. `PATH` defaults to `/opt/ubc26/docker-bin:/usr/local/bin:/usr/bin:/bin`. `TMPDIR` uses `processEnv.tmpDir`, then the engine work directory, then the process temp directory. `UBC26_ENGINE_CACHE` is set only from `ENGINE_CACHE`. `RISC0_SERVER_PATH` is set only from `ENGINE_R0VM`. The child receives `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, and `NODE_EXTRA_CA_CERTS` only when those variables are set. It does not receive `XAI_API_KEY`, `DOCKER_AUTH_CONFIG`, `DOCKER_CONFIG`, or `HOME`. A deadline sends `SIGTERM` to the POSIX process group. `SIGKILL` follows after 200 ms. The group is killed again when the direct child exits. Output above 16 MiB is killed. Spawn uses `shell: false`. The WSL guest command is `/usr/bin/env -i` with those assignments. `env -u` is not used. Windows cannot signal a process group. The direct child is signalled there. `1121a7f` keeps a UTF-8 scalar that is split across two child output chunks. The decoder flushes on close before the output is parsed.

`ENGINE_TMPDIR` is an optional compiler temp directory. `ENGINE_WSL_BIN` is an optional `wsl.exe` path. `0d4a5e1` checks the pin when `DEPLOYMENT_MODE=public`. A native `ENGINE_PATH` must be absolute. WSL also requires an absolute `ENGINE_WSL_BIN`. The only accepted wrapper is `wsl.exe -d <distro> -e /usr/bin/env -i` with the explicit assignments and an absolute engine path. A relative path, a command name, and extra child variables are refused. A public process with a simulated engine exits before listen. `d0bd57b` also requires the SHA-256 digest of the engine file, and of the WSL wrapper when that wrapper is used, before listen. Replay, a simulated chain, and a non-HTTPS origin fail that same gate. Fake-engine names `FAKE_ENGINE_LOG`, `FAKE_REFERENCE_HASH`, `FAKE_RULES_HASH`, and `FAKE_IMAGE_ID` are explicit `cliEngine` options. The server does not copy them from its environment.

`1b76ab9` stops new task claims on SIGTERM and SIGINT. It signals each owned compiler process group before it closes SQLite. The drain bound is 2000 ms. That bound is the code constant `TASK_DRAIN_MS`. It is not an environment variable. A compile that is still running returns to `queued`. A dispatched draft becomes `uncertain`. Its reservation stays `uncertain` and `settled_micro_usd` stays null. It is not stored as zero. A draft that has not been dispatched returns to `queued`. A later pump does not start while that drain flag is set. A descendant that leaves the process group is outside this kill. This is not cgroup isolation.

`validate`, `eval`, and `compile` accept an optional `AbortSignal`. An aborted signal does not spawn. A signal that aborts during the call terminates that process group. `eval` accepts optional `evidence` and `context`. Evidence is at most 16 files and 32 KiB each. The service writes those files and passes `--evidence`. Context must be `0x01` plus 336 hex characters. The service writes that value as `{"context": context}` and passes `--job`. The guest still checks the real rules and reference bindings. These commits do not change the guest, the compiler, or the verifier. Authoring routes do not pass the signal yet. That wiring belongs to the coordinator.

Migration `014_spend_breach.sql` adds nullable `breach` on `spend_reservations`. Migration `015_spend_halt.sql` adds `spend_halts`. Migration `016_spend_halt_backfill.sql` inserts one unresolved halt for each existing reservation with `breach` 1, a non-null settled amount, and no halt row. The halt id is `halt-` plus the reservation id. None of these migrations delete historical rows or change the settled amount or `usage_json`. A null settled amount is an unknown bill and does not gain a halt. Opening the database again does not insert a duplicate halt. This service uses migration 016. The coordinator should start example check records at migration 017. A settled amount above the ceiling inserts one halt row in the same transaction. The halt stores the actual micro-USD and the ceiling. While any halt has `resolved_at` null, a new draft task returns 503 `service_disabled`. The message is `Authoring is halted after a spend breach`. The details field `haltId` is the halt id. The daily ceiling check still runs first. An exhausted day still returns 429 `rate_limited`. The runner does not claim queued draft tasks. Those tasks stay `queued` across restart. A local synchronous draft returns the same 503 before the model call. Compile tasks are not stopped by the halt.

`POST /v1/operator/spend-halts/:id/resolve` takes `{note}`. The note must be 1 to 500 characters after trim. Unknown fields return 400 `validation_failed`. The bearer must equal `OPERATOR_TOKEN`. When that variable is unset, the route returns 404 with message `Not found`. A wrong bearer returns 401 `Unauthorized`. A missing halt returns 404 `Spend halt not found`. A second resolve returns 409 `wrong_state` with message `The spend halt is already resolved`. A successful resolve sets `resolved_at`, `resolved_by` to `operator`, and `resolution_note`. It does not delete the row. It does not change the billed amount or the ticks. Queued draft tasks can run after every open halt is resolved.

One repair is allowed when usage is complete and the elapsed time from the handler start is below 120 seconds. The repair call does not get a separate remaining deadline. That request deadline remains open. Repair reasons are `plan_invalid`, `file_errors`, and `examples`. A capability refusal is not repaired. The repair runs only when the serialized repair body plus 8192 completion tokens fits the remaining ceiling. A one-token repair is not sufficient. A draft that already has both predicted example labels stays at one model call when no other repair applies. Missing predicted labels can repair once in local mode. The response stays `kind: "draft"` when the plan is otherwise valid. Unmatched quotes appear in `quoteVerification` and `coverage`. They do not change `kind` and they do not block approval. A budgeted response also includes `billing` and `qualification` on a draft result. Checker-backed example acceptance is not in these commits.

`POST /v1/tasks` commits the task, any draft reservation, and the idempotency response in one transaction. The same wallet, key, and a different body returns 422 `idempotency_key_reused`. That request does not keep a task or a reservation. The same key and the same input return one task. A second key for the same owner and input still returns that task. A different wallet does not share it. A quota rejection stores 429 and does not insert a second reservation. After restart, the stored 202 replays the same task. A different body still returns 422. The queued task runs once.

`EXPENSIVE_OPS_DISABLED=1` sets `expensiveDisabled`. A new expensive accept returns 503 `service_disabled`. The runner also does not dispatch a task that is already `queued`. That task stays `queued`. The model is not called. Reconcile still marks a running draft `uncertain`. Reconcile still returns a running compile to `queued`. That compile stays queued while dispatch is paused.

In public mode, `POST /v1/drafts` and `POST /v1/jobs/:id/compile` return 403 `forbidden`. The message is `Public authoring uses POST /v1/tasks`. The details field `use` is `POST /v1/tasks`. Those routes do not call the model or the compiler. Local mode keeps the synchronous routes. Public clients send draft and compile work to `POST /v1/tasks`.

`POST /v1/jobs/:id/paid-compile` stays synchronous. It uses the same single compiler as a queued compile task. One compile runs at a time. A completed Circle payment replays the stored response. The replay does not compile again and does not settle again. The x402 amount is a service charge. It is not the job bounty.

## Hosted attempt publication

This section is the service contract for solver progress. Root owns the SDK and the CLI. The runner file `commerce/worker/src/open-claim/attempt-status.ts` is the local reference and stays read-only. The API does not import the worker package. Migration `018_solver_attempts.sql` is reserved for this publication. Migration 019 stays free for Worker B. Worker B owns open-claim discovery. This service does not edit `open-claim.ts`. `a3ce2b5` implements this contract.

`POST /v1/jobs/:id/attempts` requires a live wallet API key and `Idempotency-Key`. The shared local buyer token is rejected in local mode and in public mode. The key does not need to own the job and does not need the buyer scope. The authenticated wallet is the solver. The body cannot choose a different wallet. Another wallet that posts the same attempt receives 403 `forbidden`. The same attempt id on a different API job receives 409 `wrong_state`.

The path id is the API job ULID. An unknown job returns 404. The body is version 1 and rejects unknown fields. It has no free-form error, detail, path, key, password, or plaintext field. Required fields are `version`, `attemptId`, and `events`. Optional fields are `chain`, `reportedClaimTx`, `reportedReleaseTx`, and `reportedWinner`. `attemptId` is a UUID version 4. The stored id is lowercase. `events` holds 1 to 20 objects on create. Each event is `{cursor, reportedAt, phase}` and rejects unknown fields. A later post may send an empty `events` array only to repeat or fill the optional fields.

`cursor` starts at 1. Each new cursor is exactly one greater than the stored high water. A gap is 409 `wrong_state`. A repeated cursor with the same phase and the same `reportedAt` is an exact replay and writes nothing new. A repeated cursor that differs is 409 `wrong_state`. The same `Idempotency-Key` and the same body replay the stored response. The same key and a different body return 422 `idempotency_key_reused`. A new key that resends a matching prefix and a contiguous suffix appends only the suffix.

`reportedAt` matches `YYYY-MM-DDTHH:mm:ss.sssZ`. It must fall from `2024-01-01T00:00:00.000Z` through five minutes after the server clock. The server stores `receivedAt` from its own clock. `reportedAt` is the solver clock. `receivedAt` is the service clock. `phase` is one of `preparing`, `proving`, `proved`, `rejected`, `claim_broadcasting`, `claim_sent`, `claimed`, `lost`, `release_broadcasting`, `release_sent`, `released`, and `abandoned`. The attempt phase is the phase of the highest stored cursor. That phase is solver-reported progress. It is not a confirmed chain state.

`chain`, when present, is `{chainId, core, adapter, jobId}`. Its `jobId` is the decimal chain job id, not the API ULID. It must match the open-claim link for this API job. A mismatch, or a chain object when no link exists, returns 409 `terms_mismatch`. When the link exists and `chain` is omitted, the server stores that link. A later post may fill a missing binding once. It cannot replace a stored binding. Publication does not create a link. It does not change job state, funding, claim acceptance, or payment rows. `GET /v1/open-jobs` remains the confirmed snapshot.

`reportedClaimTx` and `reportedReleaseTx` are 32-byte hex. Once stored, a different hash is 409 `wrong_state`. `reportedWinner` is an address. The response keeps `confirmedWinner` null, `confirmedPayment` false, and `confirmedRefund` false. The body fields `paymentConfirmed`, `winner`, `solver`, `confirmed`, and `released` are rejected. The phases `claimed` and `released` do not mutate the bounty and do not assert payment. An attempt holds at most 200 events. One more returns 413 `payload_too_large`. The first create returns 201. A later append or exact content replay returns 200. The post response includes the summary, `accepted` as the count of new events, and the events from that request. It does not dump the whole history.

`GET /v1/jobs/:id/attempts` is public. `limit` is an integer from 1 to 50 and defaults to 20. A bad limit or a malformed cursor returns 400. Order is the first receive time, then the attempt id. The cursor is opaque and advances through that order. The response is `{attempts, nextCursor}`. `nextCursor` is a string or null. Each item has `attemptId`, `jobId`, `solver`, `phase`, `progress` of `solver-reported`, `highWaterCursor`, `eventCount`, `confirmedPayment`, `confirmedWinner`, `confirmedRefund`, `receivedAt`, and `chain` or null. It includes the reported transaction and winner fields when present. It does not include events.

`GET /v1/jobs/:id/attempts/:attemptId` is public. `afterCursor` is an integer of at least 0 and defaults to 0. A value above the high-water cursor returns 400. A malformed attempt id, an unknown attempt, or an attempt for another API job returns 404. The response includes the summary and at most 50 events. Each event has `attemptId`, `cursor`, `reportedAt`, `receivedAt`, and `phase`. `nextCursor` is the integer high-water cursor, which is the local runner meaning. `resumeCursor` is the last returned event cursor when more events remain. It is null when this page reaches the high-water cursor. Root will add SDK and CLI publication as an explicit manual action. This service does not send attempts by itself.

## Checkpoints

- `094a210` Add wallet API keys and job ownership.
- `9237298` Bind selected funding to the authenticated wallet.
- `7c6b3c9` Queue durable draft and compile tasks.
- `5cf64a4` Pause queued work when expensive operations are disabled.
- `5e6b5d8` Route public authoring through the durable task gate.
- `95c3b29` Settle authoring cost only after a known dispatch.
- `68b87fc` Commit task acceptance with its idempotency response.
- `a609c4c` Cancel an oversized model response before it is parsed.
- `5807491` Bound paid authoring before the next model call.
- `2a1248c` Reject a model call unless the full provider payload fits.
- `432422c` Stop authoring after an over-ceiling bill until an operator resolves it.
- `cd558ea` Keep engine children on an explicit environment and a process group.
- `0d4a5e1` Refuse a public engine that is simulated or unpinned.
- `1b76ab9` Drain owned compiler children before the API exits.
- `c943cfb` Backfill unresolved halts for historical spend breaches.
- `1121a7f` Preserve split UTF-8 compiler output.
- `d0bd57b` Refuse public listen until pinned bytes and prices match.
- `a7b2e5e` Require a real database write and the reviewed compiler pin.
- `a13106d` Record the hosted solver attempt publication contract.
- `a3ce2b5` Publish sanitized solver attempts without confirming payment.

## Commands

From `commerce/api` after `094a210`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 788 tests passed.

From `commerce/api` after `9237298`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 789 tests passed.

From `commerce/api` after `7c6b3c9`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 796 tests passed.

From `commerce/api` after `5cf64a4`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 797 tests passed.

From `commerce/api` after `5e6b5d8`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 799 tests passed.

From `commerce/api` after `95c3b29`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 807 tests passed.

From `commerce/api` after `68b87fc`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 812 tests passed.

From `commerce/api` after `432422c`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 824 tests passed. The default run excludes `test/integration`. This is not engine, Cargo, Foundry, or funded-proof evidence.

From `commerce/api` after `cd558ea`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 828 tests passed. The default run excludes `test/integration`. This is not engine, Cargo, Foundry, or funded-proof evidence.

From `commerce/api` after `0d4a5e1`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 832 tests passed. The default run excludes `test/integration`. This is not engine, Cargo, Foundry, or funded-proof evidence.

From `commerce/api` on the tree committed as `1b76ab9` and `c943cfb`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 838 tests passed. The default run excludes `test/integration`. This is not engine, Cargo, Foundry, or funded-proof evidence.

From `commerce/api` on the tree committed as `1121a7f` and `d0bd57b`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 863 tests passed. The default run excludes `test/integration`. This is not engine, Cargo, Foundry, or funded-proof evidence.

From `commerce/api` on the tree committed as `a7b2e5e`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 867 tests passed. The default run excludes `test/integration`. This is not engine, Cargo, Foundry, or funded-proof evidence.

From `commerce/api` on the tree committed as `a3ce2b5`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 872 tests passed. The default run excludes `test/integration`. This is not engine, Cargo, Foundry, or funded-proof evidence.

## Gaps

These commits do not close the full authoring gate. The two earlier model-safety checks and the full-payload check are separate. A request-wide deadline through validation and repair is not in these commits. Checker verdicts do not yet decide payable examples. Requirement coverage is not in these commits. Qualification metadata is not returned for every terminal authoring kind. Engine `eval` can receive bounded evidence and an exact context. The authoring routes do not pass them yet. Example fixtures, base64 example files, and encoded binary references are not in these commits. The benchmark worker owns the public fixture data.

Open-feed confirmed-time expiry and cursor pagination belong to Worker B. This service does not edit `open-claim.ts`. The client contract remains `GET /v1/open-jobs` with `cursor` and `limit` from 1 to 50. The response shape is `{jobs, nextCursor}`. `nextCursor` is a string or null. Detail may still return an expired job. Confirmed expiry compares the snapshot timestamp with the job expiry. `1121a7f` preserves a UTF-8 scalar split across child output chunks. The coordinator already has the same decoder in `9e70e51`, so `1121a7f` was not cherry-picked. This branch keeps that decoder. `a7b2e5e` makes a read-only database fail the write probe, shares one readiness evaluation, and accepts `max_completion_tokens`. It also pins the docker shim on the child PATH and reads the prewarm record. A missing or warming record returns 503 and does not block listen. Migration 016 remains the halt backfill. Migration 017 is on the coordinator and is not in this branch. Migration 018 is reserved here for solver attempts. Migration 019 stays free for Worker B. Coordinator `4135ab4` advertises the model slug as `id`, and the exact non-reasoning slug also advertises `max_completion_tokens` and `providerCostBound`. This branch does not edit `grok.ts`. This branch does not contain the coordinator billing edits `048c0f2` and `49d56e9` or `cancelDraftRequests` from `9cba871`. Integration must keep those functions. This service did not implement them. `a3ce2b5` publishes solver attempts and does not confirm payment. Protected metrics, sanitized logs, auth challenge limits, and queue admission bounds are not in these commits. The public host, the secure credential, and separate caps are still unknown. Disk quotas are not enforced by `/readyz`. A warm compiler record is not a cold-cache proof.

The coordinator owns `deploy/`, Docker, backup and restore, `docs/hosted-api-contract.md`, and `docs/hosted-runtime.md`. No hosted release is claimed. No wallet was read. No model call was paid. No prover was started.
