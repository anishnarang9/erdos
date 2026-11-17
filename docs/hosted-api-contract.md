# Hosted API integration contract

Status: implementation contract, 2026-11-17. Final source and acceptance evidence remain pending.

All JSON errors use the existing `{error:{code,message,details?}}` shape. Job and task mutations require `Idempotency-Key`. Auth issuance consumes a signed challenge once and never replays its raw key. Key maintenance does not store a raw-key replay response. Authentication checks precede replay. API keys identify wallet owners. Public mode disables shared buyer credentials. Ownerless legacy jobs cannot be mutated by public users.

| Method | Path | Input and result |
| --- | --- | --- |
| POST | /v1/auth/challenge | `{wallet}` returns `{challengeId,message,expiresAt}`. Bind the signed message to configured service origin, wallet, issuance action, nonce and expiry. |
| POST | /v1/auth/keys | `{challengeId,signature}` returns `{id,key,wallet,scopes,createdAt}` once. Consume the challenge atomically. |
| GET | /v1/auth/keys/current | Bearer key returns `{id,wallet,scopes,createdAt}`. Never return its digest or raw key. |
| POST | /v1/auth/keys/:id/revoke | Bearer key revokes a key of the same wallet. Return `{revoked:true}`. |
| POST | /v1/tasks | Bearer key and idempotency key. `{operation:"draft",input:<existing draft body>}` or `{operation:"compile",jobId,revisionHash}`. Return 202 with task view. |
| GET | /v1/tasks/:id | Owner only. Return task view. No private paths or raw model errors. |
| POST | /v1/drafts/:draftId/example-checks | Owner key, idempotency key and exact `If-Match`. `{draftId,revisionHash,examples}` appends an immutable native-check record. Returns 201, its id, bindings and actual verdict labels/counts. |
| POST | /v1/jobs/:id/approve | Exact `revisionHash`, `referenceDigest` and `If-Match`. Public authored jobs also require `coverageDigest`. Optional `exampleCheckId` selects a later owner-bound check. Approval retains both review identifiers. |

Task view: `{id,operation,state,attempt,createdAt,updatedAt,result?,error?}`. States: `queued`, `running`, `succeeded`, `failed`, `uncertain`. Results reuse existing draft/compile response bodies. Errors use sanitized API errors. Interrupted paid authoring becomes uncertain. Queued tasks resume. Compiler work is bounded and serialized. A task binds the owner and exact revision. Deduplicate before work starts.

Existing job import, package, references and open-claim funding routes retain their documented body shapes. Public authored approval adds the review fields above. Discovery pagination is staged below. Public mutation routes require owner authorization. Funding buyer must equal the authenticated wallet. Compile approval and revision binding remain mandatory. Public results become readable according to the existing protocol.

Worker A must document any necessary runtime contract correction before SDK integration. Worker A owns the API engine, server, task, identity, limits, discovery and attempt modules plus its service report. The coordinator owns `authoring.ts`, `grok.ts`, `jobs.ts`, example input/approval modules and their tests. Migration 016 is reserved for service spend-halt history. Coordinator example records start at 017. The coordinator owns `deploy/`, `docs/hosted-runtime.md`, this document, SDK exports and the runner. Worker B owns engine fixtures and reports. No worker may change shared catalog copies without coordinator agreement.

## Local solver attempt status

The runner persists `attemptId` as a UUID for each attempt. Sanitized status contains `attemptId`, `job:{chainId,core,adapter,jobId}`, `solver`, `phase`, `paymentConfirmed`, `nextCursor`, and `events:[{attemptId,cursor,at,phase}]`. Optional fields are `winner`, `claimTx` and `releaseTx`. Cursors are local to an attempt. Compare `(attemptId,cursor)` pairs. Never merge two solvers' local sequence numbers into one global sequence.

A rejected or lost attempt changes only that attempt. Confirmed chain state defines the bounty's winner, payout, expiry and refund. Local progress does not establish chain acceptance. This source checkpoint exposes local runner status. Hosted publication and public reads use the routes below.

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


## Authoring review and failure metadata

The task result discriminant is `kind`: `draft`, `clarification` or `unsupported`. A task can succeed while the draft is unapprovable. `exampleApprovalReady` requires an engine pass and a valid verdict 0, with no rejected or disagreeing examples. `coverage.ruleCoverageComplete` checks requirement links and source quotes. The buyer must still inspect the intended policy. This finite flag does not prove complete natural-language intent.

`examples` preserves verdict labels. Owner-only `exampleInputs` shows exact bounded files, evidence and preview context. Complete entries include `status:"complete"`. An invalid selection has `status:"rejected"` and omits its unusable content. Keep this result private to the owner's account. Job/package/reference data retain the existing public protocol boundary.

`coverage.coverageDigest` binds the requirement links and verified quotes. A public authored approval without that exact digest fails. Every wallet-owned draft has an immutable initial `exampleCheckId`. A buyer can append witnesses for the exact returned plan and select the new id at approval. Missing evidence, invalid signatures and changed contexts stay rejected. The service provides no issuer signing key. See [the full review contract](hosted-authoring-coverage.md).

All model terminal classes retain `qualification:{model,promptVersion,catalogVersion,latencyMs,repairCount,traceId,traceIds,usage}` and separate `attempts`. Failed model replies put available metadata in sanitized error `details`. Unknown identity/usage remains null. A rejected repair uses `kind:"model_failed"` and its reason. Available billed ticks participate in accounting. Unknown bills remain uncertain. See [spending bounds](hosted-model-costs.md).

One 120-second controller covers initial inference, validation, examples and repair. Service drain cancels active controllers and checker groups before closing durable state. A client timeout does not authorize a new paid request. Poll the original task and reconcile uncertainty.

## Hosted solver attempts

A live wallet API key can submit `POST /v1/jobs/:id/attempts` with an idempotency key. The key determines the solver; the solver need not own the buyer job. The request is `{version:1,attemptId,events:[{cursor,reportedAt,phase}],chain?,reportedClaimTx?,reportedReleaseTx?,reportedWinner?}`. `attemptId` is a UUID v4. Times are canonical UTC ISO strings with milliseconds. They must be at least 2024-01-01 and no more than five minutes ahead of server receipt. Unknown fields reject.

First publication needs events starting at cursor 1. Later batches may repeat an identical stored prefix and append consecutive events. A conflicting repeat or gap rejects. Each batch permits 20 events; each attempt permits 200. An empty later batch can fill or repeat optional metadata. A different wallet cannot update the same attempt. Supplied chain bindings must match the linked open-claim job. Existing bindings and reported transaction hashes cannot be replaced.

Allowed phases are `preparing`, `proving`, `proved`, `rejected`, `claim_broadcasting`, `claim_sent`, `claimed`, `lost`, `release_broadcasting`, `release_sent`, `released`, and `abandoned`. These are solver reports. They do not establish proof validity or settlement.

Publication returns the summary plus `accepted` (new event count) and the acknowledged request events, each with `attemptId` and server `receivedAt`. First creation returns 201; append returns 200. Exact idempotent replay returns the stored response. Summary fields include `attemptId`, API `jobId`, `solver`, `phase`, `highWaterCursor`, `eventCount`, first `receivedAt`, nullable `chain` and optional reported transaction/winner fields. Every summary has `progress:"solver-reported"`, `confirmedPayment:false`, `confirmedWinner:null`, and `confirmedRefund:false`. These fixed fields mean this endpoint supplies no chain confirmation. Read the confirmed open-job snapshot for actual settlement.

Public `GET /v1/jobs/:id/attempts?limit=20&cursor=OPAQUE` returns `{attempts,nextCursor}`. Limit is 1–50. The opaque cursor follows first receipt time and UUID. It differs from an attempt event cursor. Public `GET /v1/jobs/:id/attempts/:attemptId?afterCursor=0` returns a summary, up to 50 consecutive events, `nextCursor` and `resumeCursor`. Here `nextCursor` is the current event high-water mark. **Follow `resumeCursor` while it is non-null** to read an unfinished history page; using the high-water mark would skip unseen events. Once caught up, retain the last observed event cursor for polling.

SDK methods are `publishAttempt`, `attempts` and `attempt`. Publication validates the outgoing allowlist before transport. Read decoders check job/attempt bindings, bounded pages, cursor continuity and the fixed confirmation boundary. Public reads send no bearer credential. Mutations have no automatic retry.
