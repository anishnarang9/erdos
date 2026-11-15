# @ubc26/api contract (T4 skeleton)

**Status:** proposed, 2026-11-14. The implementation and the tests both follow this file. It narrows [COMMERCE-IMPLEMENTATION.md §2.4 and §3](../../agents/current%20plan/COMMERCE-IMPLEMENTATION.md#3-api) to what T4 delivers. Endpoints owned by later tasks are mounted but return `501 not_implemented`.

## Construction

```ts
import { createApp } from "@ubc26/api";
const { app, close } = createApp({
  dbPath: ":memory:",                 // node:sqlite DatabaseSync path
  buyerToken: "test-buyer-token",     // required; must be at least 16 characters, otherwise createApp throws
  now: () => Date.now(),              // injectable clock in ms; tests use a fixed clock
  validatePlan,                       // optional PlanValidator; defaults to simulatedValidatePlan
});
// app is a Hono instance; tests call app.request(path, init). close() closes the DB.
```

`src/server.ts` reads `PORT`, `DB_PATH` and `BUYER_API_TOKEN` from the environment and serves the app with `@hono/node-server`.

**Plan validator** (SIMULATED until Anish publishes the output shape of `engine validate`):

```ts
type PlanValidator = (plan: unknown) => Promise<
  | { ok: true }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown }>;
```

`simulatedValidatePlan` accepts any non-null, non-array JSON object that has a `version` field whose value is a number or a string. Anything else is `invalid`, with path `/plan` or `/plan/version`.

## Storage

- The database is `node:sqlite` with migrations in `migrations/NNN_name.sql`, applied in order at startup and recorded in `schema_migrations`.
- Tables: `jobs`, `revisions`, `approvals`, `manifests`, `quotes`, `chain_links`, `pending_txs`, `idempotency`, `index_cursor`, `events`, `auth_nonces`. All of them are created even if T4 does not use them yet.
- All writes for one request run in a single transaction.

## Common rules

1. **Error body.** Every error response is JSON of the form `{ "error": { "code": string, "message": string, "details"?: object } }`.

   | Code | HTTP status |
   | --- | --- |
   | `validation_failed` | 400 |
   | `unauthorized` | 401 |
   | `not_found` | 404 |
   | `revision_conflict` | 409 |
   | `approval_required` | 409 |
   | `payload_too_large` | 413 |
   | `idempotency_key_reused` | 422 |
   | `capability_unsupported` | 422 |
   | `rate_limited` | 429 |
   | `internal` | 500 |
   | `not_implemented` | 501 |

2. **Unknown routes** return 404 `not_found`.
2a. **Processing order** (settled during cross-validation, 2026-11-14):
   1. Read the raw body, capped at 1 MiB.
   2. Authenticate. This comes first because provider signatures cover the hash of the raw body.
   3. Parse the JSON.
   4. Check the idempotency key.
   5. Run the handler.

   So a wrong token with invalid JSON returns 401. Requests that fail auth, have a bad key, or have invalid JSON are never stored for replay.
2b. **`details.errors[].path`** values are JSON Pointers relative to the revision object, for example `/expirySeconds` or `/outputs/0/name`. Errors in the outer request body use `/revision`, `/source` or `/<unknownKey>`. Unknown keys are rejected in the outer body, in the revision, in each `outputs[]` entry, and in the approve body.
3. **Request bodies.** A body that is not valid JSON on a POST returns 400 `validation_failed`. A body over 1 MiB returns 413 `payload_too_large`.
4. **Idempotency.** Every `POST /v1/...` requires an `Idempotency-Key` header of 1–128 characters from `[A-Za-z0-9_.:-]`. A missing or malformed key returns 400 `validation_failed`.
   - The scope is `(key, METHOD, path, caller)`, where the caller is `"buyer"` or the provider address in lowercase.
   - `requestHash = sha256(METHOD + "\n" + path + "\n" + rawBody)`.
   - Same scope and same `requestHash`: replay the stored status and body exactly, and add the header `Idempotent-Replayed: true`.
   - Same scope but a different `requestHash`: 422 `idempotency_key_reused`.
   - Only responses with status below 500 are stored. Authentication is checked **before** the idempotency lookup.
5. **Buyer authentication.** Buyer routes require `Authorization: Bearer <buyerToken>`, compared in constant time. A missing or wrong token returns 401 `unauthorized`.
6. **Provider authentication** (EIP-191). Provider requests carry these headers:

   | Header | Value |
   | --- | --- |
   | `X-UBC26-Address` | Provider address |
   | `X-UBC26-Timestamp` | Integer unix seconds |
   | `X-UBC26-Nonce` | 8–64 characters from `[A-Za-z0-9_-]` |
   | `X-UBC26-Signature` | 0x hex of 65 bytes |

   The signed message is
   `["UBC26-API-v1", METHOD, pathWithQuery, sha256hex(rawBody), timestamp, nonce].join("\n")`.
   `sha256hex` is lowercase hex with a `0x` prefix, and an empty body hashes the empty string. The signature is checked with viem `verifyMessage`.

   The request returns 401 `unauthorized` if any of these hold:
   - the signature is wrong or a header is missing;
   - `|now - timestamp| > 60 s`;
   - the `(address, nonce)` pair was already used, which is recorded in `auth_nonces`.
7. **Revision hash.**
   ```text
   revisionHash = "0x" + hex(SHA256(UTF8("UBC26/revision/v1") || UTF8(JCS(revision))))
   ```
   JCS is RFC 8785 (`canonicalize`). `revision` is the validated revision object below, with `referenceDigest` lowercased.

## Revision object

```json
{
  "plan": { "version": 1 },
  "referenceDigest": "0x<64 hex>",
  "outputs": [{ "name": "result.json", "format": "json" }],
  "expirySeconds": 600,
  "maxBudget": "5000000"
}
```

| Field | Rule |
| --- | --- |
| `plan` | Checked by `PlanValidator` |
| `referenceDigest` | 32-byte hex |
| `outputs` | 1–16 entries. Each name matches `^[A-Za-z0-9._-]{1,128}$` and is not `.` or `..`. Names are unique. `format` is one of `json`, `text`, `binary`. |
| `expirySeconds` | Integer from 300 to 86400 |
| `maxBudget` | Decimal string, a positive integer at most `1000000000000` (USDC base units), no leading zeros |

Unknown top-level fields return 400 `validation_failed`, with `details.errors` given as `[{ path, message }]`.

## Endpoints

| Method and path | Auth | T4 behaviour |
| --- | --- | --- |
| `GET /healthz` | public | `200 { "ok": true }` |
| `POST /v1/jobs` | buyer | Body `{ "revision": Revision, "source": "import" \| "grok" }`. `source` is required and case-sensitive. Validates the shape, then runs `PlanValidator`. An `invalid` result returns 400 `validation_failed` with `details.errors`. An `unsupported` result returns 422 `capability_unsupported` with `details.capabilityError`. Success returns **201** `{ jobId, state: "drafted", revision: { n: 1, revisionHash } }`. `jobId` is a ULID. |
| `GET /v1/jobs/:id` | public | 200 with the job view below and the header `ETag: "<revisionHash>"`. Returns 404 if the job does not exist. |
| `POST /v1/jobs/:id/approve` | buyer | See the approval rules below. |
| `GET /v1/assignments` | provider | `200 { "assignments": [] }`. Chain linkage arrives in T8. |
| `POST /v1/drafts`, `POST /v1/jobs/:id/compile`, `GET /v1/jobs`, `POST /v1/jobs/:id/quotes`, `POST /v1/jobs/:id/select-quote`, `POST /v1/jobs/:id/funding-receipt`, `GET /v1/jobs/:id/submission` | as in the plan | 501 `not_implemented`. Authentication still runs first on authenticated routes. |

**Approval rules** for `POST /v1/jobs/:id/approve`. The body is `{ revisionHash, referenceDigest }` and the request needs an `If-Match` header, either the quoted `"<hash>"` or the bare hash.
- A missing `If-Match` returns 400 `validation_failed`.
- 409 `revision_conflict` if `If-Match`, the body's `revisionHash`, or the body's `referenceDigest` differs from the current revision.
- If the job is `drafted`, the approval is stored and the state becomes `approved`. The response is `200 { state: "approved", approval }`.
- If the job is already `approved` for the same `revisionHash`, the response is 200 with the existing approval and nothing changes.
- Returns 404 if the job does not exist.

**Job view:**

```json
{
  "jobId": "01J...",
  "state": "drafted",
  "revision": { "n": 1, "revisionHash": "0x...", "revision": { }, "source": "import", "createdAt": "ISO-8601" },
  "approval": null,
  "chain": null,
  "worker": null
}
```

When approved, `approval` is `{ revisionHash, referenceDigest, approvedAt }`. All timestamps come from `now()` as ISO-8601 UTC.
