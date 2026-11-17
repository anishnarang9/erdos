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

## Checkpoints

- `094a210` Add wallet API keys and job ownership.
- `9237298` Bind selected funding to the authenticated wallet.

## Commands

From `commerce/api` after `094a210`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 788 tests passed.

From `commerce/api` after `9237298`:

- `pnpm exec tsc -p tsconfig.json --noEmit` exited 0.
- `pnpm exec vitest run` exited 0. 789 tests passed.

## Gaps

Durable tasks, Grok bounds, deployment, backup and readiness are not in these commits. No hosted release is claimed. No wallet was read. No model call was paid. No prover was started.
