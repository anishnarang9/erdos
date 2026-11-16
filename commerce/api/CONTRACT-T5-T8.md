# @ubc26/api contract, T5–T8 (drafting, compile, quotes, funding linkage)

**Status:** proposed, 2026-11-14.
- This file extends [CONTRACT.md](CONTRACT.md). Everything there still applies: error body, processing order, idempotency, auth, and the 2a–2c rules.
- The implementation and the tests both follow this file.

Three dependencies are SIMULATED until their owners deliver:

| Dependency | Owner | Stand-in |
| --- | --- | --- |
| Engine CLI (`engine validate`, `engine compile`) | Anish | `simulatedEngine` |
| Grok | Neil (needs `XAI_API_KEY`) | Fake `fetch` and recorded replies |
| Settlement ABI | Nick | `@ubc26/sdk` stub contracts on anvil |

Every SIMULATED code path carries a `// SIMULATED:` comment that names the owner and the open question.

## 0. New construction options

```ts
createApp({
  ...T4 options,
  engine?: Engine,                  // default simulatedEngine(); replaces validatePlan (validatePlan still works, used if engine absent)
  draftModel?: DraftModel,          // default: none -> POST /v1/drafts returns 503 model_unavailable
  chain?: { config: ChainConfig; publicClient: PublicClient },  // default: none -> chain routes return 503 chain_unavailable
});
```

New error codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `quote_expired` | 409 | The quote is past `validUntil` (minus 60 s at selection) |
| `terms_mismatch` | 409 | On-chain terms differ from the manifest or the selected quote |
| `chain_unconfirmed` | 409 | Transaction unknown, pending or reverted. The caller may retry. |
| `wrong_state` | 409 | Job state does not allow this action. `details` carries `{ state }`. |
| `engine_failed` | 502 | Engine crashed, gave unparseable output, or returned a manifest inconsistent with the revision |
| `model_failed` | 502 | Draft model HTTP error, missing content, or a reply that fails validation |
| `model_unavailable` | 503 | No draft model configured |
| `chain_unavailable` | 503 | No chain configured |

Job states, in order: `drafted` → `approved` → `compiled` (open for quotes) → `selected` → `linked`.

## 1. Engine (`src/engine.ts`)

```ts
interface Manifest {
  imageId: Hex; rulesHash: Hex; referenceHash: Hex; structureHash: Hex;
  toolchain: Record<string, string>; files: { name: string; sha256: Hex }[];
}
type ValidateResult = Awaited<ReturnType<PlanValidator>>;   // same union as T4
type CompileResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown };
interface Engine {
  validate(plan: unknown): Promise<ValidateResult>;
  compile(input: { plan: unknown; reference: BundleFile[] }): Promise<CompileResult>;  // throws on crash
}
```

**`simulatedEngine()`** is SIMULATED and deterministic.
- `validate` behaves like `simulatedValidatePlan`.
- `compile` validates first, then computes:

  ```text
  structureHash = sha256("UBC26/structure/v1" ‖ JCS(plan.structure ?? plan))
  rulesHash     = sha256("UBC26/rules/v1" ‖ structureHash ‖ sha256(JCS(plan.parameters ?? {})))
  referenceHash = sdk.referenceHash(sdk.encodeBundle(reference))
  imageId       = sha256("SIMULATED/image/v1" ‖ structureHash)
  ```

  It returns `toolchain: { engine: "simulated" }`, and `files` holds the reference files' sha256 values in bundle order.
- Strings are UTF-8 and all hashes are lowercase `0x` hex.
- The structure/parameter split is a guess until Anish answers Q-A2.

**`cliEngine({ bin, workDir, timeoutMs = 120_000 })`** runs the real CLI.
- It uses `execFile` with a fixed argument list and no shell. Inputs are written to a fresh temporary directory, which is deleted afterwards.
- It parses the JSON on stdout, using the shapes assumed in §1a.
- A non-zero exit, a timeout or output that won't parse throws `EngineError`, which maps to 502 `engine_failed`.

**§1a, assumed CLI JSON shapes** (UNSPECIFIED, Q-A3/Q-A4):

| Command | Assumed output |
| --- | --- |
| `validate` | `{ "ok": true }` or `{ "ok": false, "errors": [...] }` or `{ "ok": false, "capabilityError": {...} }` |
| `compile` | Writes `manifest.json` to `--out` with the fields of `Manifest` |

Tests cover `cliEngine` against a fake engine script, never a real binary.

## 2. Reference files

- `POST /v1/jobs` and `POST /v1/jobs/:id/revisions` accept an optional `references: [{ name, contentBase64 }]` beside `revision` and `source`. Names follow the bundle name rule, with at most 16 files and at most 32 KiB decoded in total.
- If `references` is given, `referenceHash(encodeBundle(files))` must equal `revision.referenceDigest`. Otherwise the request fails with 400 at `/references`.
- If `references` is omitted, the job has no stored references. Compile then succeeds only if `referenceDigest` equals the hash of the empty bundle (`010000`). Otherwise it returns 409 `wrong_state` with `details.reason = "references_missing"`.
- The files are stored in a new table `reference_files(job_id, revision_n, name, content)` added by a new migration file.

## 3. T5, drafting (`src/grok.ts`, `POST /v1/drafts`)

```ts
type ModelDraft =
  | { kind: "draft"; plan: unknown; examples: { name: string; files: { name: string; content: string }[]; predictedVerdict: 0 | 1 }[];
      sourceQuotes: { path: string; quote: string }[] }
  | { kind: "clarification"; questions: string[] }          // 1..5 questions
  | { kind: "unsupported"; reason: string };
interface DraftModel {
  draft(input: { request: string; outputs: Output[]; referenceNames: string[]; clarifications: { question: string; answer: string }[];
                 schema: unknown }): Promise<{ result: ModelDraft; model: string; traceId: string }>;
}
```

**`grokDraftModel({ apiKey, model, fetch = globalThis.fetch, baseUrl = "https://api.x.ai/v1" })`**
- Sends `POST {baseUrl}/chat/completions` with:
  - `Authorization: Bearer <apiKey>`
  - `temperature: 0`
  - `response_format: { type: "json_schema", json_schema: { name: "ubc26_draft", strict: true, schema } }`
  - a system message that states the job, the output union and the safety rules
- The schema is the `ModelDraft` union in the subset xAI supports. `plan` is typed as `{ type: "object" }` until Anish publishes the real schema (Q-A2).
- The reply is `choices[0].message.content`, parsed and validated against `ModelDraft`. HTTP errors, a missing `content`, or a reply that fails validation throw `ModelError`. The route turns it into 502 `model_failed`.
- `traceId` is the response `id`.
- The API key never appears in logs, errors or responses.

**`recordingDraftModel(inner, dir)` and `replayDraftModel(dir)`**
- The record key is `sha256(JCS(input))`.
- Each recording is one file, `<key>.json`, holding `{ input, result, model, traceId }`.
- `replayDraftModel` throws `ModelError("no_recording")` when no recording exists.

**`POST /v1/drafts` (buyer)**

| Body field | Rule |
| --- | --- |
| `request` | String of 1–8,000 characters |
| `outputs` | The T4 outputs rule |
| `references?` | As in §2 |
| `clarifications?` | Array of at most 2 rounds, each `{ question, answer }` with non-empty strings |
| `expirySeconds` | T4 rule |
| `maxBudget` | T4 rule |

The handler:
1. Calls `draftModel.draft` with `schema` set to the engine's plan schema (SIMULATED: `{ type: "object" }`).
2. If the model returns `clarification` while `clarifications.length` is already 2, it converts the result to `unsupported` with reason `"clarification_limit"`.
3. For a `draft`, it builds the T4 revision: `plan` from the model, `referenceDigest` from the references (or the empty-bundle hash), and `outputs`, `expirySeconds` and `maxBudget` from the body.
4. It then runs `engine.validate(plan)`. An invalid or unsupported result is returned as an `unsupported` draft response. It is **not** an HTTP error.

Response 200, one of:
- `{ kind: "draft", draftId, revision, revisionHash, examples: [{ name, predictedVerdict, checkerVerdict: null }], sourceQuotes, model, traceId }`
  - `checkerVerdict` stays null until `engine eval` exists (Q-A1).
- `{ kind: "clarification", draftId, questions, round }`, where `round` is 1 or 2.
- `{ kind: "unsupported", draftId, reason, capabilityError? }`

Every call is stored in the `drafts(id, request_json, result_json, model, trace_id, created_at)` table.

**`POST /v1/jobs` with `source: "grok"`** may carry `draftId`.
- An unknown `draftId` returns 400 at `/draftId`.
- The job records `draftId` and `edited`, which is true when the submitted `revisionHash` differs from the draft's.
- With `source: "import"`, sending `draftId` returns 400.

## 4. T6, revisions and compile

**`POST /v1/jobs/:id/revisions`** (buyer, requires `If-Match`). Body: `{ revision, source, references?, draftId? }`, the same rules as `POST /v1/jobs`.
- Allowed only in state `drafted` or `approved`. Any other state returns 409 `wrong_state`.
- A stale `If-Match` returns 409 `revision_conflict`.
- Success creates revision `n+1` and sets the state to `drafted`. Any approval is voided; it is kept in the table and marked `voided_at`.
- Returns 201 `{ state: "drafted", revision: { n, revisionHash } }`.
- `GET /v1/jobs/:id` shows the latest revision and `approval: null`.

**Approve after this change:** if the current revision has a voided approval, the buyer approves again as normal.

**`POST /v1/jobs/:id/compile`** (buyer). Body: `{ revisionHash }`.
- If the state is not `approved`, or the approval is not for the current `revisionHash`, return 409 `approval_required`.
- A `revisionHash` that is not current returns 409 `revision_conflict`.
- Otherwise call `engine.compile({ plan, reference })`:
  - `invalid` → 400 `validation_failed`
  - `unsupported` → 422 `capability_unsupported`
  - a throw → 502 `engine_failed`
  - `manifest.referenceHash` different from `referenceDigest` → 502 `engine_failed`
- On success, store the manifest in `manifests` and set the state to `compiled`. Respond 200 `{ state: "compiled", manifest }`.
- Compiling again in state `compiled` returns the stored manifest and does not call the engine.

The job view gains `manifest: Manifest | null`.

## 5. T7, job feed, quotes and selection

**`GET /v1/jobs?jobType=&limit=`** (public). Lists jobs in state `compiled`, newest first. `limit` is 1–100 and defaults to 50. Each item is:

```json
{ jobId, revisionHash, jobType, outputs, expirySeconds, maxBudget, manifest: { imageId, rulesHash, referenceHash } }
```

`jobType` is `plan.jobType` when it is a string, otherwise null. The `jobType` query filters on exact equality.

**Quote, EIP-712.**
- Domain: `{ name: "UBC26 Commerce", version: "1", chainId }`, where `chainId` comes from `chain.config.chainId`, or 5042002 when no chain is configured.
- Type: `Quote(bytes32 revisionHash,address provider,uint256 price,uint64 validUntil,uint256 nonce)`.

**`POST /v1/jobs/:id/quotes`** (provider auth). Body:

```json
{ quote: { revisionHash, provider, price: "<decimal>", validUntil: <unix s>, nonce: "<decimal>" }, signature }
```

The checks below run in order:

| # | Check | Failure |
| --- | --- | --- |
| 1 | Shape | 400 |
| 2 | Job exists | 404 |
| 3 | State is `compiled` | 409 `wrong_state` |
| 4 | `revisionHash` is current | 409 `revision_conflict` |
| 5 | `provider` equals the authenticated caller (case-insensitive) | 401 |
| 6 | `0 < price ≤ maxBudget` | 400 |
| 7 | `now + 60 ≤ validUntil ≤ now + 86400` | 400 |
| 8 | Signature recovers `provider` | 401 |
| 9 | `(provider, nonce)` not used before for this job | 409 `wrong_state`, `details.reason = "duplicate_quote"` |

On success, store the quote and respond 201 `{ quoteId, validUntil }`.

**`POST /v1/jobs/:id/select-quote`** (buyer). Body: `{ quoteId, revisionHash }`.
- No chain configured → 503.
- State is not `compiled` → 409 `wrong_state`.
- `revisionHash` not current → 409 `revision_conflict`.
- Quote unknown or for another job → 404.
- `now ≥ validUntil - 60` → 409 `quote_expired`.

On success the state becomes `selected` and the response is 200:

```json
{ state: "selected",
  fundingTerms: { chainId, core, hook, usdc, provider, budget: price, expiredAt: nowSec + expirySeconds,
                  imageId, rulesHash, referenceHash, description: "ubc26:" + jobId },
  txRequests: [ { kind: "approve", to: usdc, data, value: "0" }, { kind: "createJob", to: core, data, value: "0" } ] }
```

- `data` is the exact calldata, built with viem from the SDK ABIs.
- `setBudget` and `fund` need the `jobId` from `JobCreated`, so they are not prebuilt. The SDK helper in §5a sends all four.
- `fundingTerms` is stored and replayed exactly, with `budget` and `expiredAt` as decimal strings.

**§5a, SDK addition (Coder D owns it):** `fundJob(chain, fundingTerms)` in `@ubc26/sdk`, file `src/chain/fund.ts`.
- It runs approve → createJob → setBudget → fund and returns `{ jobId, fundTx }`.
- Every step checks its receipt.

## 6. T8, funding linkage, assignments and indexer

**`POST /v1/jobs/:id/funding-receipt`** (buyer). Body: `{ txHash }`, which must be the `fund` transaction. Checks:
- No chain configured → 503.
- State is not `selected` → 409 `wrong_state`, except as described below.
- Receipt missing, pending or reverted → 409 `chain_unconfirmed`.
- The transaction must be sent `to == core` and its receipt must contain `JobFunded` and `TermsFrozen` for one `jobId`. Otherwise → 409 `terms_mismatch`, with `details.field` naming the field.
- Read `getJob` and `getTerms`, then check all of these:
  - `provider == quote.provider`
  - `evaluator == hook == config.hook`
  - `budget == fundingTerms.budget`
  - `expiredAt == fundingTerms.expiredAt`
  - `status == Funded`
  - the `imageId`, `rulesHash` and `referenceHash` terms equal the manifest

  Any difference → 409 `terms_mismatch`, with `details.field`.
- The same `(chainId, core, jobId)` already linked to another app job → 409 `terms_mismatch`, `details.field = "jobId"`.

On success, insert into `chain_links`, set the state to `linked`, and respond 200 `{ state: "linked", chainJob: { chainId, core, jobId } }`. A repeat call for the same transaction returns 200 with the same body; this is the one exception to the `selected`-state rule.

**`GET /v1/jobs/:id`** gains `chain`:

```json
chain: null | { chainId, core, jobId, status, statusSource: "index" | "live", fundTx }
```

`status` is a `JobStatus` name such as `"Funded"`. It comes from the indexed events when any exist, otherwise from a live `getJob`.

**`GET /v1/assignments`** (provider). Lists linked jobs whose chain provider is the caller and whose status is `Funded`:

```json
{ assignments: [ { jobId, chainJob, manifest, expiredAt, revisionHash, outputs } ] }
```

**Indexer** (`src/indexer.ts`): `createIndexer({ db, chain, cursorStart })`.
- `tick()` runs the SDK `LogCursor` over `[core, hook]`.
- The cursor is persisted in `index_cursor`, and decoded events go into `events`, de-duplicated by `(chainId, txHash, logIndex)`.
- It returns the number of new events.
- Status derivation:

  | Latest core event | Status |
  | --- | --- |
  | `JobCreated` | Open |
  | `JobFunded` | Funded |
  | `JobSubmitted` | Submitted |
  | `JobCompleted` | Completed |
  | `Refunded` | Expired |

- `server.ts` runs `tick()` every 5 s when a chain is configured.
