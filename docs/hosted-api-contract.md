# Hosted API integration contract

Status: implementation contract, 2026-11-16. Final source and acceptance evidence remain pending.

All JSON errors use the existing `{error:{code,message,details?}}` shape. Job and task mutations require `Idempotency-Key`. Auth issuance consumes a signed challenge once and never replays its raw key. Key maintenance does not store a raw-key replay response. Authentication checks precede replay. API keys identify wallet owners. Public mode disables shared buyer credentials. Ownerless legacy jobs cannot be mutated by public users.

| Method | Path | Input and result |
| --- | --- | --- |
| POST | /v1/auth/challenge | `{wallet}` returns `{challengeId,message,expiresAt}`. Bind the signed message to configured service origin, wallet, issuance action, nonce and expiry. |
| POST | /v1/auth/keys | `{challengeId,signature}` returns `{id,key,wallet,scopes,createdAt}` once. Consume the challenge atomically. |
| GET | /v1/auth/keys/current | Bearer key returns `{id,wallet,scopes,createdAt}`. Never return its digest or raw key. |
| POST | /v1/auth/keys/:id/revoke | Bearer key revokes a key of the same wallet. Return `{revoked:true}`. |
| POST | /v1/tasks | Bearer key and idempotency key. `{operation:"draft",input:<existing draft body>}` or `{operation:"compile",jobId,revisionHash}`. Return 202 with task view. |
| GET | /v1/tasks/:id | Owner only. Return task view. No private paths or raw model errors. |

Task view: `{id,operation,state,attempt,createdAt,updatedAt,result?,error?}`. States: `queued`, `running`, `succeeded`, `failed`, `uncertain`. Results reuse existing draft/compile response bodies. Errors use sanitized API errors. Interrupted paid authoring becomes uncertain. Queued tasks resume. Compiler work is bounded and serialized. A task binds the owner and exact revision. Deduplicate before work starts.

Existing job import, approval, package, references, open-claim funding and discovery routes retain their documented body shapes. Public mutation routes require owner authorization. Funding buyer must equal the authenticated wallet. Compile approval and revision binding remain mandatory. Public results become readable according to the existing protocol.

Worker A must document any necessary runtime contract correction before SDK integration. Worker A owns the API engine, server, task, identity, limits, discovery and attempt modules plus its service report. The coordinator owns `authoring.ts`, `grok.ts`, `jobs.ts`, example input/approval modules and their tests. Migration 016 is reserved for service spend-halt history. Coordinator example records start at 017. The coordinator owns `deploy/`, `docs/hosted-runtime.md`, this document, SDK exports and the runner. Worker B owns engine fixtures and reports. No worker may change shared catalog copies without coordinator agreement.

## Local solver attempt status

The runner persists `attemptId` as a UUID for each attempt. Sanitized status contains `attemptId`, `job:{chainId,core,adapter,jobId}`, `solver`, `phase`, `paymentConfirmed`, `nextCursor`, and `events:[{attemptId,cursor,at,phase}]`. Optional fields are `winner`, `claimTx` and `releaseTx`. Cursors are local to an attempt. Compare `(attemptId,cursor)` pairs. Never merge two solvers' local sequence numbers into one global sequence.

A rejected or lost attempt changes only that attempt. Confirmed chain state defines the bounty's winner, payout, expiry and refund. Local progress does not establish chain acceptance. This source checkpoint exposes local runner status. A hosted publication/query route remains pending service integration.

## Authored job submission and references

`POST /v1/jobs` accepts `{source:"grok",draftId,revision,references}` for an authored draft. References use `{name,contentBase64}` records with the original bytes. The owner must own the draft. Deterministic imports use `{source:"import",revision,references}`. Preserve the reference digest and the exact draft ID. A task that requests clarification or reports unsupported work cannot supply a payable job through the client acceptance command.

Selected-provider funding terms include `buyer` for wallet-key callers. Funding linkage checks the confirmed job client against that wallet. Legacy local sessions keep their prior response shape. Open-claim terms keep the existing five funding steps.

## Task acceptance and service origin

Task acceptance commits the durable task, spend reservation and idempotency response in one transaction. Concurrent requests that reuse a key with different bodies leave one task and one reservation. Equal semantic inputs under distinct keys still select the same task for one wallet. Separate wallets have separate tasks. A successful task-accept replay returns the original 202 view; poll its identifier for current state.

Issuance checks the challenge's stored origin and action against the current service configuration. Restoring a database at another hostname does not make pending old-hostname signatures valid there. Existing credential digests remain owner records; review them as part of restore operations.

## Discovery pagination — client staged, server integration pending

The SDK accepts `openJobs({cursor?,limit?})`; the CLI accepts `discover --cursor CURSOR --limit LIMIT`. The wire request is `GET /v1/open-jobs?cursor=OPAQUE&limit=10`. Limit is an integer from 1 through 50. Treat cursors as opaque strings, URL-encode them and preserve them exactly.

The paginated response is `{jobs:[...],nextCursor:string|null}`. A page may contain fewer jobs than its limit. Continue with `nextCursor` until it is null. Cursor order must be stable and advance through scanned links, including links excluded by confirmed expiry or winner state. Do not return an unchanged cursor. Bound scanning and RPC work per request.

The client rejects oversized pages, malformed or repeated cursors, and an explicit pagination request whose response omits `nextCursor`. This prevents a legacy server that ignores query arguments from appearing to return another page. A no-argument client call still reads the legacy `{jobs}` shape, which does not establish complete discovery. Wallet credentials are not sent for this public read.

Worker A must implement and verify the server side, including confirmed-chain-time expiry filtering, before the discovery gate can close. Current client tests cover transport/response safety, not a completed paginated public service.
