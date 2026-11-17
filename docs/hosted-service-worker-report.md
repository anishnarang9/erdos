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

When every returned attempt has complete usage, the service sums the quoted micro-USD. The quote uses input, output, and optional cached prices. A missing cached price uses the input price. Reasoning tokens are not added again on top of completion tokens. `cost_in_usd_ticks` is stored and is not a price. The reservation settles only when that sum is a safe integer and it is less than or equal to the ceiling. A larger quote stays `uncertain` at the ceiling. The sum includes a failed plan call and the one repair call. A repair that throws keeps the ceiling even when the first cost is known.

A budget number that is not a positive safe integer throws at `createApp` before the database opens. Prices are operator configuration. These commits do not add configuration variables and do not permit spend. `server.ts` does not read budget variables yet.

UTF-8 reference files are sent in full up to the existing 32 KiB cap. A non-UTF-8 file returns `validation_failed` before dispatch. The service does not substitute a summary for the file. The model request uses `max_completion_tokens`. It does not send `max_tokens`, penalties, `stop`, tools, or `reasoning_effort`. Finish reason `length` or `content_filter` fails the call. A missing finish reason remains valid. The prompt says the model has no wallet, cannot spend, cannot run a shell, and cannot change a contract.

One repair is allowed when usage is complete and the request is still inside 120 seconds. Repair reasons are `plan_invalid`, `file_errors`, and `examples`. A capability refusal is not repaired. A draft that already has both example verdicts stays at one model call when no other repair applies. Missing examples can repair once. The response stays `kind: "draft"` when the plan is otherwise valid. Unmatched quotes appear in `quoteVerification` and `coverage`. They do not change `kind` and they do not block approval. A budgeted response also includes `billing` and `qualification`.

`POST /v1/tasks` commits the task, any draft reservation, and the idempotency response in one transaction. The same wallet, key, and a different body returns 422 `idempotency_key_reused`. That request does not keep a task or a reservation. The same key and the same input return one task. A second key for the same owner and input still returns that task. A different wallet does not share it. A quota rejection stores 429 and does not insert a second reservation. After restart, the stored 202 replays the same task. A different body still returns 422. The queued task runs once.

`EXPENSIVE_OPS_DISABLED=1` sets `expensiveDisabled`. A new expensive accept returns 503 `service_disabled`. The runner also does not dispatch a task that is already `queued`. That task stays `queued`. The model is not called. Reconcile still marks a running draft `uncertain`. Reconcile still returns a running compile to `queued`. That compile stays queued while dispatch is paused.

In public mode, `POST /v1/drafts` and `POST /v1/jobs/:id/compile` return 403 `forbidden`. The message is `Public authoring uses POST /v1/tasks`. The details field `use` is `POST /v1/tasks`. Those routes do not call the model or the compiler. Local mode keeps the synchronous routes. Public clients send draft and compile work to `POST /v1/tasks`.

`POST /v1/jobs/:id/paid-compile` stays synchronous. It uses the same single compiler as a queued compile task. One compile runs at a time. A completed Circle payment replays the stored response. The replay does not compile again and does not settle again. The x402 amount is a service charge. It is not the job bounty.

## Checkpoints

- `094a210` Add wallet API keys and job ownership.
- `9237298` Bind selected funding to the authenticated wallet.
- `7c6b3c9` Queue durable draft and compile tasks.
- `5cf64a4` Pause queued work when expensive operations are disabled.
- `5e6b5d8` Route public authoring through the durable task gate.
- `95c3b29` Settle authoring cost only after a known dispatch.
- `68b87fc` Commit task acceptance with its idempotency response.

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

## Gaps

Open-feed expiry and pagination are not in these commits. Public readiness, deployment pins, and rejection of a simulated engine or chain are not in these commits. A clean compiler child environment and process-group bounds are not in these commits. Protected metrics, sanitized logs, and attempt publication are not in these commits. Auth challenge pruning and a bound on paid-compile waiters are not in these commits. The coordinator owns `deploy/`, Docker, backup and restore, and `docs/hosted-runtime.md`. No hosted release is claimed. No wallet was read. No model call was paid. No prover was started.
