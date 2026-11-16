# Open-claim HTTP routes, version 1

These routes use the real engine and the compiled `OpenClaimAdapter` ABI. The API prepares unsigned buyer transactions. It reads Arc at a confirmed block before it lists a bounty. The API does not sign a wallet transaction. See [the adapter interface](../../docs/overnight/open-claim-v1.md) for contract calls and proof bytes.

Set `ENGINE_MODE=native` with `ENGINE_PATH`, `PACKAGES_DIR`, `BUYER_API_TOKEN`, `OPEN_CLAIM_RPC_URL`, `OPEN_CLAIM_CHAIN_ID=5042002`, `OPEN_CLAIM_CORE`, `OPEN_CLAIM_ADAPTER`, `OPEN_CLAIM_USDC`, and `OPEN_CLAIM_VERIFIER` before starting `commerce/api/src/server.ts`. Set `HOST=127.0.0.1` for the local run so the buyer API binds only to loopback. `OPEN_CLAIM_CONFIRMATIONS` defaults to `3`. The server checks that an Arc open-claim route has a real engine. Leave `XAI_API_KEY` unset when using typed import; no draft model is needed.

All paths below start with `/v1`. Buyer POST routes require `Authorization: Bearer <buyer token>`. `open-claim-terms` and `open-claim-link` also require `Idempotency-Key`. `paid-compile` uses the signed x402 payment identity for replay. The error body is `{ "error": { "code": string, "message": string, "details"?: object } }`. The [base API contract](CONTRACT.md) defines job creation, revision approval, compile, package and reference downloads.

| Method and path | Caller | Request | Success |
| --- | --- | --- | --- |
| `POST /jobs/:id/open-claim-terms` | Buyer | `{ "revisionHash": "0x…", "buyer": "0x…", "budget": "1000000", "expiry": "<Unix seconds>" }` | `200` with `state: "open_prepared"`, exact commitments, `order`, and unsigned `txRequests` and `afterCreate` calls. |
| `POST /jobs/:id/open-claim-link` | Buyer | `{ "revisionHash": "0x…", "chainJobId": "3", "fundingTx": "0x…", "registrationTx": "0x…" }` | `200` with `state: "open_registered"` after both receipts and matching terms are confirmed. |
| `GET /open-jobs` | Public | None | `200 { "jobs": […] }`. Lists only linked, registered, funded jobs with no accepted claim. |
| `GET /open-jobs/:id` | Public | None | `200` with the current confirmed `status`, `winner`, `envelopeHash`, `keyCommitment`, `released`, budget, expiry, buyer, and manifest. The detail remains readable after claim or release. |
| `POST /jobs/:id/paid-compile` | Buyer | `{ "revisionHash": "0x…" }`; signed retry uses `Payment-Signature` | Without payment, `402` and an x402 v2 `Payment-Required` quote. After the facilitator confirms payment, `200` returns the normal compile response and `Payment-Response`. Exact replay uses the stored response and `Idempotent-Replayed: true`. |

The returned funding order is `createJob`, `setBudget`, `approve`, `fund`, `register`. The buyer must sign and confirm each step. `open-claim-link` checks a `JobFunded` event from the core, a later `TermsRegistered` event from the adapter, and the exact approved image, rules, references, buyer, budget and expiry at a confirmed block. A pending transaction or a changed revision cannot enter the public feed. The x402 payment covers the API compile service only; it does not fund the ERC-8183 bounty. An uncertain facilitator result stays pending and needs reconciliation. A confirmed payment can retry a transient compile failure without another charge.

## Buyer request examples

Use a fresh idempotency key for each distinct `open-claim-terms` or `open-claim-link` request. The values below are placeholders, not live deployment pins. `job_id` comes from typed job import and approval; `revision_hash` comes from its approved current revision.

```sh
api=http://127.0.0.1:8787
job_id=<api-job-id>
revision_hash=<approved-revision-hash>
buyer=<buyer-address>
expiry=<unix-seconds>
curl -sS -X POST "$api/v1/jobs/$job_id/open-claim-terms" \
  -H "Authorization: Bearer $BUYER_API_TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: terms-$job_id" \
  -d "{\"revisionHash\":\"$revision_hash\",\"buyer\":\"$buyer\",\"budget\":\"1000000\",\"expiry\":\"$expiry\"}"

# Send the five returned calls from the buyer wallet, in order. Check each receipt.
curl -sS -X POST "$api/v1/jobs/$job_id/open-claim-link" \
  -H "Authorization: Bearer $BUYER_API_TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: link-$job_id" \
  -d "{\"revisionHash\":\"$revision_hash\",\"chainJobId\":\"<core-job-id>\",\"fundingTx\":\"<fund-hash>\",\"registrationTx\":\"<register-hash>\"}"
curl -sS "$api/v1/open-jobs/$job_id"
```

The local acceptance command and tool pins are in [the local runbook](../../docs/overnight/open-claim-local-runbook.md). Live Arc deployment, wallet signing and Circle Gateway settlement require separate operator inputs and approval.
