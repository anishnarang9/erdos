# Hosted backend handoff for Neil

Working integration checkpoint: [`20b0dc2`](https://github.com/anishnarang9/UBC-26/commit/20b0dc2), draft PR #8. This is not the final release SHA. Public origin, 180 real authoring trials, final production acceptance and live settlement remain pending. Hosted attempts and expiry-safe discovery pass controlled checks. Exact browser origin/preflight policy is implemented. Paid compilation admission, replay and drain controls pass 939 API tests. The combined restricted image and exact-source CI pass. Final external review and public acceptance remain pending. See the [release ledger](../agents/anish/reports/hosted-release-readiness-2026-11-17.json). Update this document at the final reviewed release.

No UI code changed in this sprint. Use the wallet-owned [API contract](hosted-api-contract.md), [installed client](hosted-client.md) and [runtime runbook](hosted-runtime.md). Keep this open-bounty flow separate from the historical selected-provider UI.

## Authentication and ownership

Request a challenge with `POST /v1/auth/challenge` and `{wallet}`. Show the exact service origin, wallet, action and expiry before asking the wallet to sign its returned message. Exchange `{challengeId,signature}` at `POST /v1/auth/keys`. The response returns the raw bearer key once. It cannot be recovered by replay. `GET /v1/auth/keys/current` inspects it. `POST /v1/auth/keys/:id/revoke` revokes an owned key.

Keep bearer keys out of URLs, analytics, logs and bundled application configuration. A key belongs to its wallet owner. A new key for that wallet can resume its jobs/tasks. Another wallet cannot mutate them. Public mode rejects the old shared buyer token. Revocation takes effect before replay lookup. A signature from a pending challenge for another configured service origin is invalid.

## Buyer flow

1. Submit authoring with `POST /v1/tasks` and `{operation:"draft",input:{request,outputs,references,exampleFixtures?,clarifications,expirySeconds,maxBudget}}`. References contain their exact bytes as base64. Keep the original request and references until job creation succeeds.
2. Poll `GET /v1/tasks/:id`. A successful task may contain a draft, clarification or unsupported result. Only a usable draft can proceed. Show the complete normalized rules, units, examples, quote checks, requirement coverage and unresolved assumptions before approval. Public approval now checks finite rule/quote links and requires the exact buyer-reviewed coverage digest. These links do not prove complete intent. `exampleInputs` shows exact bounded files, evidence and preview context.
3. Create the unapproved job with `POST /v1/jobs` and `{source:"grok",draftId,revision,references}`. Import exact rules with `source:"import"` instead. Preserve the draft ID and reference bytes.
4. If needed, append buyer-supplied witnesses at `POST /v1/drafts/:draftId/example-checks`. It accepts only exact revision-bound complete examples. Keep the original task response unchanged. Approve with `POST /v1/jobs/:id/approve`, current `revisionHash`, `referenceDigest`, reviewed `coverageDigest` and exact `If-Match`. `exampleCheckId` can select a later successful record. Otherwise approval uses the immutable initial check. The service signs no witnesses. A material revision voids approval.
5. Enqueue compilation with `POST /v1/tasks` and `{operation:"compile",jobId,revisionHash}`. Poll the returned task. Inspect the compiled package and commitments before preparing funding.
6. Obtain `POST /v1/jobs/:id/open-claim-terms` with `{revisionHash,buyer,budget,expiry}`. The buyer must equal the authenticated wallet. Budget is a decimal string in six-decimal token units. Expiry is an absolute chain timestamp. The service requires a measured deadline margin.
7. Execute the five funding steps below, then link confirmed funding with `POST /v1/jobs/:id/open-claim-link`. Only confirmed chain state establishes the funded open bounty.

Every job/task mutation needs an explicit `Idempotency-Key`. Reuse it only for the same request bytes and purpose. The server atomically stores task acceptance, reservation and replay response. Equal inputs under another key may still select the same task for that wallet. Poll its ID. Do not create another request to escape an uncertain outcome.

## Funding and chain authority

The five steps are **create job → set budget → approve exact token amount → fund → register terms**. The create receipt supplies the chain job ID used by later calls. The protected runner builds those dependent calls, checks deployment pins and persists send/nonce journals. The initial terms response alone is not a complete signed batch. The hosted API holds no buyer or solver signer.

Show chain ID, exact contract destinations, buyer, token units, bounty, absolute deadline, manifest commitments and allowed gas before signing. Service compilation charges, including x402, are separate from the escrow bounty. A pending payment requires reconciliation; replay must not charge again.

Read `/v1/open-jobs` for discovery and `/v1/open-jobs/:id` for a confirmed snapshot. Use `?limit=10&cursor=OPAQUE`, follow non-null `nextCursor`, and allow short or empty pages while the cursor advances. Each request scans at most its limit. A chain dependency failure returns 503 and requires retrying the same cursor. List/detail expose `confirmedTimestamp`, `confirmedBlockNumber` and `expired`. Expired funded detail remains distinct from refund. Confirmed chain time controls expiry even when a funded job has not yet been refunded.

The winner, proof acceptance, release, payment and refund come from confirmed chain state. A worker's failed attempt does not reject the whole bounty. A claimed proof does not yet establish payment. Display payment only after the winning key release and payout are confirmed.

## Responses and recovery

A newly accepted task returns HTTP 202:

```json
{"id":"TASK_ID","operation":"compile","state":"queued","attempt":0,"createdAt":"2026-11-16T23:00:00.000Z","updatedAt":"2026-11-16T23:00:00.000Z"}
```

`running` remains pending. `succeeded` includes the existing draft/compile body in `result`. `failed` includes a sanitized `error`. `uncertain` requires reconciliation before another paid dispatch. Task `attempt` counts queue executions. `qualification.repairCount` counts the optional model repair. All authoring terminal kinds retain model/prompt/catalog, latency, traces and usage. Rejected replies retain available metadata in sanitized error details. Unknown usage remains null. One 120-second deadline covers inference, validation, examples and repair.

Terminal authoring results include these distinct branches:

```json
{"kind":"clarification","draftId":"DRAFT_ID","questions":["Which fee table applies?"],"round":1}
```

```json
{"kind":"unsupported","draftId":"DRAFT_ID","reason":"The requested external fact has no approved evidence source."}
```

These are authoring outcomes, not funded or rejected bounties. A request error uses the common shape:

```json
{"error":{"code":"service_disabled","message":"Expensive operations are disabled"}}
```

Use error codes to choose a UI action. The exact free-text message can change. Retain pending task IDs and transaction hashes across refreshes. Resume polling or receipt reconciliation. An expired deadline requires confirmed refund state; a local timer alone cannot establish refund success.

Package/reference reads are public protocol inputs and do not need a buyer key. Verify their hashes and manifest bindings. Public recovery reads the accepted envelope and released key from confirmed chain data, then recovers the exact files through the SDK and engine. The result becomes public when the release key is broadcast. The encoded result permits 16 files and 16,384 bytes.

## Solver attempts and remaining integration gates

The installed runner emits a sanitized UUID `attemptId` and per-attempt `cursor`. Merge events by `(attemptId,cursor)`. Never combine independent solvers' local sequence numbers as one global order. The local command is documented in the client guide. Hosted publication uses `POST /v1/jobs/:id/attempts`; public list/detail reads use that path and `/:attemptId`. See the [attempt contract](hosted-api-contract.md#hosted-solver-attempts). The solver key owns its attempt. Browser code must not read operator state files or filesystem paths. Detail `nextCursor` is the high-water mark; follow non-null `resumeCursor` to avoid skipping history. All published phases remain solver-reported and carry no settlement confirmation.

Before the final UI handoff, publish the final origin/SHA, real authoring qualification, representative confirmed refund snapshots, and external acceptance evidence. Demo signers and presenter-only routes remain absent from the public API. No frontend merge or deployment is part of this handoff.

Browser integration permits the canonical API service origin and one separately configured `BROWSER_ORIGIN`. Use the exact HTTPS frontend origin without credentials, path, query, fragment or wildcard. Preflight supports Authorization, Content-Type, Idempotency-Key, If-Match and payment-signature for GET/POST. The response exposes ETag, payment-required, payment-response and idempotent-replayed. Cookies remain disabled. Wallet challenge signatures still bind the API service origin, not the frontend origin. Unapproved browser origins receive 403 before route work.


The latest [candidate evidence](../agents/anish/reports/hosted-release-candidate-2026-11-17.json) pins the runner archive and image to `20b0dc2`. The qualification harness now preserves model/prompt/catalog metadata and binds live mode and model identity to campaign v2. Public API routes and UI payloads retain the documented contract. The [final review scope](hosted-final-review-scope.md) remains open. No hosted endpoint is available yet.
