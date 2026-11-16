# Open-claim API routes, version 1

These routes add an open bounty beside the existing selected-provider flow. The buyer still creates a job, approves its current revision, and compiles it through the existing `/v1` routes. The open-claim routes use the compiled image, rules, and reference hashes.

## Approve exact terms

`POST /v1/jobs/:id/open-claim-terms` requires the buyer bearer token and an `Idempotency-Key`. The JSON body is:

```json
{
  "revisionHash": "0x<32-byte hash>",
  "buyer": "0x<on-chain buyer address>",
  "budget": "1000000",
  "expiry": "<Unix seconds>"
}
```

The job must be compiled and approved. The budget must be positive and within the revision's `maxBudget`. The API checks current chain time and requires at least 1,200 seconds before expiry. It stores this exact buyer, budget, expiry, revision, and manifest, then moves the job to `open_prepared`. This state removes it from the selected-provider feed and prevents a second funding mode. A second approval with different terms fails.

The response has `fundingTerms`, unsigned `txRequests` for `createJob` and exact USDC `approve`, and `afterCreate` instructions for `setBudget`, `fund`, and `register`. The required order is `createJob` → `setBudget` → `approve` → `fund` → `register`. Use the new chain job ID from the confirmed `JobCreated` event in the final three calls. The core receives `createJob(adapter, adapter, expiry, description, address(0))`; `fund` takes empty bytes. The adapter receives the compiled commitments and the exact amount and expiry. No API response authorizes a wallet signature by itself. The buyer client must check its deployment and signing policy.

## Confirm funding and registration

After the buyer has confirmed all five transactions, call `POST /v1/jobs/:id/open-claim-link` with the buyer token and an `Idempotency-Key`:

```json
{
  "revisionHash": "0x<32-byte hash>",
  "chainJobId": "7",
  "fundingTx": "0x<32-byte transaction hash>",
  "registrationTx": "0x<32-byte transaction hash>"
}
```

The API requires successful receipts addressed to the pinned core and adapter, with `JobFunded` and `TermsRegistered` for the same chain job. Funding must precede registration. It then checks a current confirmed chain snapshot: chain ID; core, adapter, verifier, and USDC; buyer; adapter provider and evaluator roles; zero hook and fees; exact funded budget and expiry; registration; compiled proof commitments; and an open Funded state. Only then does it store the link and move the API job to `open_registered`. Missing or reverted receipts return `chain_unconfirmed` (409). Wrong terms return `terms_mismatch` (409).

`GET /v1/open-jobs` is public. It lists at most 50 linked jobs whose current chain snapshot still shows an open, funded claim with no winner. A stale or unavailable job is omitted. `GET /v1/open-jobs/:id` returns the current status, manifest, budget, expiry, buyer, winner, envelope hash, key commitment, and release flag. Buyer and solver read the same status. A claimed job leaves the open feed but remains visible by ID.

The `OpenClaimReader` is a read-only dependency in `createApp`. `mode: "arc"` requires a real engine and real compiled artifact binding. `mode: "fixture"` exists for local API tests and returns `evidenceMode: "fixture"`. The Arc reader now uses the compiled adapter JSON ABI. It pins every job snapshot to one confirmed block and ignores receipts inside the three-block confirmation margin. It reads the live core job, registered terms, winner, token, fees and adapter wiring. The server enables it only when `OPEN_CLAIM_RPC_URL`, `OPEN_CLAIM_CHAIN_ID`, `OPEN_CLAIM_CORE`, `OPEN_CLAIM_ADAPTER`, `OPEN_CLAIM_USDC` and `OPEN_CLAIM_VERIFIER` are set. `OPEN_CLAIM_CONFIRMATIONS` defaults to `3`.

The [local funding report](../../agents/anish/reports/open-claim-local-funding-api-2026-11-16.json) records five confirmed buyer transactions and an API snapshot after registration. The [combined local acceptance report](../../agents/anish/reports/open-claim-local-acceptance-2026-11-16.json) records a fresh adapter-domain proof, claim, exact payout, recovery and a separate refund. Both use synthetic unlocked accounts on forkless local Arc. The local addresses are not testnet deployment pins; the testnet adapter address remains null in the template. The [current route contract](OPEN-CLAIM-v1.md) names the HTTP setup and response fields.
