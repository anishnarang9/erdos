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

The current draft handler does not return token usage. A completed draft therefore leaves the reservation `uncertain` at the full ceiling. The cost is not recorded as zero. These codes release the reservation: `validation_failed`, `model_unavailable`, `not_found`, `unauthorized`, `forbidden`, `payload_too_large`, `approval_required`, `wrong_state`, `revision_conflict`. `model_failed` and other handler failures keep the ceiling in state `uncertain`. A budget number that is not a positive safe integer throws at `createApp` before the database opens. Prices are operator configuration. This checkpoint does not permit spend.

`EXPENSIVE_OPS_DISABLED=1` sets `expensiveDisabled`. A new expensive accept returns 503 `service_disabled`. The runner also does not dispatch a task that is already `queued`. That task stays `queued`. The model is not called. Reconcile still marks a running draft `uncertain`. Reconcile still returns a running compile to `queued`. That compile stays queued while dispatch is paused.

## Checkpoints

- `094a210` Add wallet API keys and job ownership.
- `9237298` Bind selected funding to the authenticated wallet.
- `7c6b3c9` Queue durable draft and compile tasks.
- `5cf64a4` Pause queued work when expensive operations are disabled.

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

## Gaps

Grok bounds, open-feed expiry pagination, deployment, backup, and readiness are not in these commits. No hosted release is claimed. No wallet was read. No model call was paid. No prover was started.
