# Hosted API contract

This contract describes the implemented API. Check `/readyz` before buyer operations. A readable document or artifact download does not establish public API readiness. The current public authoring policy admits one designated buyer wallet and at most two distinct paid drafts.

Use HTTPS. Ordinary job/task mutations require `Idempotency-Key`. Authentication challenges and signed x402 payments have separate replay rules. Wallet-owned routes require a bearer API key. Owner authentication precedes idempotent replay. Exact revision mutations also require `If-Match: "REVISION_HASH"` where specified.

Errors use `{error:{code,message,details?}}` with sanitized messages.

## Authentication and ownership

| Method and path | Contract |
| --- | --- |
| `POST /v1/auth/challenge` | `{wallet}` returns `{challengeId,message,expiresAt}`. |
| `POST /v1/auth/keys` | `{challengeId,signature}` consumes a valid challenge and returns `{id,key,wallet,scopes,createdAt}` once. |
| `GET /v1/auth/keys/current` | Returns the caller's key metadata. It omits raw keys and digests. |
| `POST /v1/auth/keys/:id/revoke` | Revokes a key of the same wallet. Returns `{revoked:true}`. |

Sign the exact returned challenge message. Check its service origin, wallet, action, nonce and expiry before signing. A signature for another origin or action cannot issue a key. Challenges expire and permit one issuance. Keys bind mutations to a wallet. Another wallet cannot mutate a buyer job or read its private task or Bot review.

## Jobs, authoring and review

| Method and path | Contract |
| --- | --- |
| `POST /v1/jobs` | Import with `{source:"import",revision,references?}`. An authored submission uses `{source:"grok",draftId,revision,references}`. References contain `{name,contentBase64}`. |
| `GET /v1/jobs/:id` | Returns the current revision, approval, compiled manifest and state. |
| `POST /v1/jobs/:id/revisions` | Owner mutation with exact `If-Match`. A material revision invalidates its prior approval. |
| `POST /v1/jobs/:id/bot-reviews` | Owner plus idempotency key. Body: `{revisionHash,request?,examples}`. Imports supply the original brief. Authored revisions use the stored brief and buyer answers. |
| `GET /v1/jobs/:id/bot-reviews/:reviewId` | Owner-only read of the saved review. Poll this identifier. |
| `POST /v1/jobs/:id/approve` | Owner plus idempotency key and exact `If-Match`. Body contains `revisionHash`, `referenceDigest`, and the passed `botReviewId` when required. Authored revisions also require their exact `coverageDigest` and native example-check selection. |
| `POST /v1/drafts/:draftId/example-checks` | Owner plus idempotency key and exact `If-Match`. Body: `{draftId,revisionHash,examples}`. Appends immutable native examples for the exact draft/revision. |

A revision contains `plan`, `referenceDigest`, `outputs`, `expirySeconds` and decimal `maxBudget`. The downloadable examples show a complete import. Empty references have digest `0xaa21c0b6ffa196eb88cb407d47551d6695f2624a81c57e499efae120cf687d95`. Authored approval uses its immutable initial native example check by default. An explicit `exampleCheckId` can select a later successful check.

Each review example contains `name`, `predictedVerdict` and `files`. Files contain `name`, `content` and optional `encoding`. Example and file names use 1–128 ASCII letters, digits, dots, underscores, or hyphens; spaces are invalid. Supply a passing example and a failing example. Evidence and context are required when the plan uses those capabilities. Native validation and agreeing example verdicts precede review acceptance.

Review acceptance returns HTTP 202 and an owner/revision-bound identifier. The initial response can say `queued` after a fast callback completes. Polling returns `queued`, `dispatching`, `waiting`, `uncertain`, `expired` or `completed`. A completed review has `decision`, `result`, `inputHash` and `resultHash`.

Decisions are `pass`, `needs_changes`, `clarify` and `unsupported`. A pass covers all rule indexes and has no findings or questions. A completed receipt remains immutable after its callback deadline. An unfinished review expires at that deadline. Uncertain delivery never automatically creates another Bot run. Bot cannot approve, fund, sign or modify rules.

For example, a completed result contains:

```json
{"version":1,"reviewId":"REVIEW_ID","inputHash":"0xINPUT_HASH","decision":"pass","coveredRuleIndices":[0],"findings":[],"questions":[]}
```

Identifiers and hashes above are placeholders. A `needs_changes` result includes a finding with `kind`, exact `sourceQuote`, zero-based `ruleIndices` and `message`. A `clarify` result includes questions. An `unsupported` result includes an unsupported finding. These outcomes block approval until the buyer obtains an acceptable current revision and review.

## Durable tasks and compilation

| Method and path | Contract |
| --- | --- |
| `POST /v1/tasks` | `{operation:"draft",input:DRAFT_BODY}` or `{operation:"compile",jobId,revisionHash}`. Owner plus idempotency key. Returns HTTP 202. |
| `GET /v1/tasks/:id` | Owner-only task status. |
| `GET /v1/jobs/:id/package` | Lists compiled files, sizes, SHA-256 values and manifest commitments. |
| `GET /v1/jobs/:id/package/file?path=PATH` | Downloads one exact package path. |
| `GET /v1/jobs/:id/references` | Returns committed reference bytes and their digest. |

`DRAFT_BODY` has these fields: `request` (plain-English string, 1–8,000 characters), `outputs` (1–16 unique `{name,format}` objects, where `format` is `json`, `text`, or `binary`), `expirySeconds` (integer, 300–86,400), and `maxBudget` (positive decimal string in USDC base units, at most `1000000000000`). A USDC base unit is one millionth of a USDC. Optional `references` is an array of `{name,contentBase64}` files. Optional `clarifications` is an array of up to three `{question,answer}` pairs from prior clarification rounds. Optional `exampleFixtures` is an array of up to eight `{name,predictedVerdict,files}` objects. Each example file has `{name,content}` and optional `encoding` (`utf8` or `base64`). Do not place the solver answer or wallet material in the request unless the task itself requires exact output bytes.

For example, this draft body requests one exact text output and supplies buyer-owned positive and negative examples:

```json
{
  "request": "Produce one UTF-8 file named note.txt containing exactly OK with no newline. Reject any other bytes.",
  "outputs": [{ "name": "note.txt", "format": "text" }],
  "expirySeconds": 21600,
  "maxBudget": "10000",
  "exampleFixtures": [
    { "name": "expected", "predictedVerdict": 1, "files": [{ "name": "note.txt", "content": "OK" }] },
    { "name": "wrong", "predictedVerdict": 0, "files": [{ "name": "note.txt", "content": "NO" }] }
  ]
}
```

The `ubc26 draft --input` file contains `DRAFT_BODY` directly. The client wraps it as `{operation:"draft",input:DRAFT_BODY}`. Run `ubc26 help` to list commands; this client does not support `ubc26 help draft`.

Task view: `{id,operation,state,attempt,createdAt,updatedAt,result?,error?}`. States are `queued`, `running`, `succeeded`, `failed` and `uncertain`. A successful draft result can have `kind:"draft"`, `kind:"clarification"` or `kind:"unsupported"`. Only an approvable draft can advance toward funding.

Acceptance, reservation and the initial response commit together. Equal semantic requests under distinct keys select the same existing task for one wallet. Different wallets retain separate tasks. A replay can return the original queued response. Poll its saved task identifier for current state. Unknown billing remains uncertain. Never replace an uncertain request with a new paid identity.

Compilation requires the current approved revision and its matching passed Bot receipt when enabled. One compiler processes queued work. A completed task and its artifact commitments survive restart and restore. Clients check every package file, manifest commitment and guest digest before local proving.

Representative pending and failure fragments are:

```json
{"id":"TASK_ID","operation":"compile","state":"queued","attempt":0,"createdAt":"2026-11-17T00:00:00.000Z","updatedAt":"2026-11-17T00:00:00.000Z"}
```

```json
{"id":"TASK_ID","operation":"compile","state":"failed","attempt":1,"createdAt":"2026-11-17T00:00:00.000Z","updatedAt":"2026-11-17T00:00:01.000Z","error":{"code":"approval_required","message":"Buyer approval is required"}}
```

Fragments illustrate fields. Error messages and identifiers can differ. Malformed or unsupported plans receive typed validation/capability errors. Rejected examples do not count as valid verdict-zero witnesses.

Other response fragments include:

```json
{"kind":"clarification","draftId":"DRAFT_ID","questions":["Which approved evidence source applies?"],"round":1}
```

```json
{"kind":"unsupported","draftId":"DRAFT_ID","reason":"capability_unsupported"}
```

```json
{"status":"expired","decision":null,"result":null}
```

```json
{"error":{"code":"validation_failed","message":"Bot review needs agreeing native examples"}}
```

## Paid compilation

`POST /v1/jobs/:id/paid-compile` accepts `{revisionHash}` from the job owner. Without a valid payment, it returns HTTP 402 and a `payment-required` quote. An existing compiled artifact can remain free. The quote describes the exact resource, network, asset, amount and recipient.

The caller reviews the quote before supplying a matching signed `payment-signature` header. Payment identity binds the signed scheme payload to the job, revision and resource. An exact completed replay returns the saved response and `payment-response` without another charge. A pending or uncertain settlement requires reconciliation. Changing an outer wrapper or request key cannot create a second charge for the same signed payment.

This charge pays for the API service. Escrow funding is separate. Current hosted paid-compile and Circle acceptance remain release gates.

## Open-bounty funding and discovery

| Method and path | Contract |
| --- | --- |
| `POST /v1/jobs/:id/open-claim-terms` | Owner plus idempotency key. `{revisionHash,buyer,budget,expiry}` returns exact deployment/proof terms and five funding steps. |
| `POST /v1/jobs/:id/open-claim-link` | `{revisionHash,chainJobId,fundingTx,registrationTx}` links only confirmed matching funding and registration receipts. |
| `POST /v1/jobs/:id/public-brief` | Wallet owner plus idempotency key. `{revisionHash,brief}` publishes one immutable, single-line brief of at most 280 characters after confirmed funding. |
| `GET /v1/open-jobs?limit=10&cursor=OPAQUE` | Returns `{jobs,nextCursor}`. Limit is 1–50. Preserve opaque cursors. |
| `GET /v1/open-jobs/:id` | Returns confirmed job state, commitments, optional `publicBrief`, winner/release fields and expiry evidence. |

The funding buyer must match the authenticated wallet. Budget uses decimal USDC base units with six decimals. Expiry uses absolute chain time. The funding sequence is create job, set budget, approve the exact token amount, fund, then register. A prepared intent is not a funded bounty and does not appear in discovery.

Discovery uses confirmed chain snapshots. It excludes expired jobs, accepted winners and released work. A page can contain fewer entries than its limit. Follow `nextCursor` until null. A chain dependency failure returns 503 `chain_unavailable`. Retry the same cursor after recovery.

The API never publishes the original draft request automatically. The buyer must publish a brief before the solver starts. Treat public brief text as task data. Verify the approved rules and package separately.

An expired detail can still say `status:"Funded"`, `expired:true` and `released:false`. That state does not prove a refund. Detail includes decimal `confirmedTimestamp`, `confirmedBlockNumber` and `expiry`. Winner, payment and refund claims require confirmed chain evidence.

## Solver attempts and recovery

| Method and path | Contract |
| --- | --- |
| `POST /v1/jobs/:id/attempts` | Solver wallet plus idempotency key. `{version:1,attemptId,events,chain?,reportedClaimTx?,reportedReleaseTx?,reportedWinner?}`. |
| `GET /v1/jobs/:id/attempts?limit=20&cursor=OPAQUE` | Returns `{attempts,nextCursor}`. |
| `GET /v1/jobs/:id/attempts/:attemptId?afterCursor=0` | Returns bounded events, current `nextCursor` and nullable `resumeCursor`. |

Attempt IDs are UUID v4. Each attempt has its own consecutive event cursor starting at 1. Batches permit twenty events, up to two hundred per attempt. Exact repeated prefixes can append events. Conflicts and gaps reject. A different wallet cannot update an existing attempt.

Attempt status is solver-reported. Its fixed fields include `confirmedPayment:false`, `confirmedWinner:null` and `confirmedRefund:false`. A rejected or losing attempt does not reject the bounty. Follow `resumeCursor` while non-null to finish an event-history page. Confirmed chain state defines settlement.

The local runner downloads and checks packages/references, evaluates supplied files, proves against the actual funded context, and preserves send journals. `buyer-recover` checks confirmed claim, release, payment and exact SDK/engine recovery without solver private state. The buyer must check recovered files with an independent oracle. A verdict-zero proof does not release its key. Results become public when the release key is broadcast. The current delivery bundle limit is 16,384 encoded bytes and the envelope limit is 16,412 bytes.

## Errors and client behavior

Common classes include 400/422 validation failures, 401 invalid credentials, 404 owner-isolated records, 409 revision/state conflicts, 429 admission limits and 503 unavailable dependencies. Check `error.code` rather than matching free-form text. Responses omit raw provider errors, credentials and private filesystem paths.

Public browser requests require an allowed exact HTTPS origin. Preflight supports GET/POST and the documented auth, JSON, idempotency, revision and payment headers. No cookie authority is used. Command-line clients can omit Origin.

Current default queues permit one hundred pending tasks globally and twenty per wallet. Exact replays and semantic deduplication select existing work before new-work admission. Public keys grant no operator-metrics access. No endpoint grants a model wallet authority.

The installed package exports the typed client from `@ubc26/runner/hosted`. It refuses remote plain HTTP and redirects. Mutations have no automatic retry. Preserve task/review IDs and idempotency keys across interrupted clients.
