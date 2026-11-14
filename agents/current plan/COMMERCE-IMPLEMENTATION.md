# Agent-to-agent commerce implementation plan

**2026-11-14 15:45 -05:00 · Neil (workstream 3 owner) · Proposed**

This document covers workstream 3 in the [three-way work split](WORK-SPLIT.md). It is written to the [engine plan](ZKVM-IMPLEMENTATION.md), which owns the wire format, and to the settlement section of the work split, which owns the contracts.

Workstream 3 connects the buyer agent and the solver agent to one funded ERC-8183 job on Arc Testnet. It covers authoring, approval, quotes, funding linkage, the solver's decision loop, submission, key release and delivery to the buyer.

Where Anish's or Nick's docs leave something undecided, this plan marks it **UNSPECIFIED** and lists it under [§15 Open questions](#15-open-questions). Nothing here overrides the engine or settlement specs. Where this plan contradicts them, theirs wins.

**Contents**
- [0 Scope](#0-scope)
- [1 Interfaces consumed](#1-interfaces-consumed)
- [2 System design](#2-system-design)
- [3 API](#3-api)
- [4 Authoring with Grok](#4-authoring-with-grok)
- [5 Solver agent](#5-solver-agent)
- [6 Delivery to the buyer](#6-delivery-to-the-buyer)
- [7 Marketplace and sponsor integration](#7-marketplace-and-sponsor-integration)
- [8 Demo script](#8-demo-script)
- [9 Security](#9-security)
- [10 Observability and evidence](#10-observability-and-evidence)
- [11 Test strategy](#11-test-strategy)
- [12 Tasks](#12-tasks)
- [13 Risks](#13-risks)
- [14 Handoffs](#14-handoffs)
- [15 Open questions](#15-open-questions)
- [16 Decision log](#16-decision-log)

## 0. Scope

| In scope (Neil) | Out of scope (owner) |
| --- | --- |
| HTTP JSON API (11 `/v1` endpoints) and its storage | Rule schema, compiler, guest, `engine` CLI, proofs (Anish) |
| TypeScript SDK: byte codec, chain adapter, API client | ERC-8183 core, hook/evaluator, verifier, deployment manifest (Nick) |
| Grok authoring adapter, typed import, approval flow | Groth16 proving environment (Anish; it runs on Neil's WSL2 host) |
| Off-chain quotes and solver selection | On-chain funded competitions (follow-on work for everyone) |
| Solver agent: polling, solving, calling `engine prove`, submit, release | |
| Buyer web UI, delivery and decryption, demo trace | |
| Sponsor extras after the core works: x402, Circle Agent Marketplace listing, ERC-8004, A2A | |
| Grok Bot bounty evidence | |

**Brief coverage.** The table shows which parts of the brief this workstream must make visible in the demo.

| Brief item | Where it is delivered |
| --- | --- |
| Grok drafts rules with pass/fail examples, and the buyer approves | §4, task T5, task T6 |
| Two different job types | §8. Anish owns the fixtures; commerce drives them end to end. |
| A rejected submission leaves the escrow funded | §8 step 4 and task T13 |
| A valid submission pays out | §8 step 5 and task T10 |
| Plugs into an existing agent marketplace | §7 and task T14 |

## 1. Interfaces consumed

### 1.1 Engine CLI (Anish)

Commerce calls these commands and does not reimplement them.

| Command | Caller | Commerce depends on |
| --- | --- | --- |
| `engine validate --plan PLAN` | API (drafting, typed import) | Canonical structure and parameters, a readable preview, and capability errors with paths |
| `engine compile --plan PLAN --reference DIR --out DIR` | API (compile) | Checker ELF and a manifest containing the image ID, `rulesHash`, `referenceHash`, toolchain versions and package digests |
| `engine prove --package DIR --job JOB --deliverables DIR --reference DIR --evidence DIR --out DIR` | Worker only | `proof.json` and a separate private key file |
| `engine decrypt --submission FILE --key-file FILE --out DIR` | Buyer (reference path) | The original named files |

Behaviour commerce relies on:
- JSON goes to stdout and diagnostics go to stderr.
- Input and commitment errors are reported separately from build and prover failures. The exit codes are UNSPECIFIED.
- A deliverable that is well formed but fails the rules returns a real receipt with `verdict = 0`, not an error. The worker must read `verdict` before deciding to submit.

### 1.2 Byte formats

The SDK re-implements these in TypeScript for reading and checking only. It never produces proofs.

```text
context       = 0x01 || chainId[32] || escrow[20] || jobId[32] || provider[20] || rulesHash[32] || referenceHash[32]   // 169 bytes
bundle        = 0x01 || u16be(count) || { u16be(nameLen) || name || u32be(len) || content }*  sorted by name bytes
envelope      = nonce[12] || ciphertext || tag[16]       // ChaCha20-Poly1305, AAD = context, plaintext = bundle
envelopeHash  = SHA256(envelope)
keyCommitment = SHA256("UBC26/key/v1" || context || key[32])
journal       = context || verdict[1] || envelopeHash || keyCommitment                                          // 234 bytes
journalDigest = SHA256(journal)
```

`proof.json` has the fields `version`, `context`, `imageId`, `verdict`, `envelope`, `keyCommitment`, `journal` and `seal`, all as 0x-prefixed hex. The seal starts with selector `0xe71e6620`.

**Test vectors.** These are copied from the engine plan's synthetic fixture and recomputed independently with Node `crypto` on 2026-11-14. They must pass in `commerce/sdk` before any other SDK code merges.

Fixture inputs:

| Input | Value |
| --- | --- |
| Chain | 5042002 |
| Job | 7 |
| Escrow | `11`×20 |
| Provider | `22`×20 |
| Rules hash | `33`×32 |
| Reference hash | `44`×32 |
| Verdict | 1 |
| Key | `55`×32 |
| Nonce | `66`×12 |

Expected values:

| Value | Hex |
| --- | --- |
| context | `01` · `00`×29 `4cef52` · `11`×20 · `00`×31 `07` · `22`×20 · `33`×32 · `44`×32 |
| bundle (`a.txt` = `ok`) | `0100010005612e747874000000026f6b` |
| envelope | `666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556` |
| envelopeHash | `ad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6` |
| keyCommitment | `3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d` |
| journalDigest | `9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e` |

### 1.3 Settlement (Nick)

The contract H is the single hook-and-evaluator contract. It is set as both `hook` and `evaluator` when the job is created.

| # | Call | Signer | Commerce-side checks | Result |
| --- | --- | --- | --- | --- |
| 0 | `USDC.approve(core, budget)` | buyer | Exact budget only, never unlimited | — |
| 1 | `core.createJob(provider, evaluator = H, expiredAt, description, hook = H)` | buyer | The provider comes from the selected quote. `expiredAt` covers the quote's proving estimate plus margin. | Open. `jobId` is read from the creation event. |
| 2 | `core.setBudget(jobId, amount)` *(if the pinned core has it)* | UNSPECIFIED | — | Budget set |
| 3 | `core.fund(jobId, …, optParams = abi.encode(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash))` | buyer | The tuple matches the compile manifest exactly | Funded. H freezes the terms. |
| 4 | `core.submit(jobId, envelopeHash, abi.encode(bytes envelope, bytes seal, bytes32 keyCommitment))` | provider | Preflight with `eth_call`. `verdict = 1`. Envelope within the cap. Enough time left before expiry. | Submitted if the proof verifies. Otherwise the call reverts and the job stays Funded. |
| 5 | `H.release(jobId, bytes32 key)` | provider | Accepted `keyCommitment` matches the local key. Time remaining is above the release margin. | `complete` runs, the provider is paid, and the key is emitted |
| 6 | `core.claimRefund(jobId)` | anyone | `now >= expiredAt` | Expired, and the buyer is refunded |

The following are UNSPECIFIED until Nick publishes the ABI:
- event names and fields
- the exact `createJob` and `fund` signatures, including whether `fund` takes `expectedBudget`
- who calls `setBudget`
- revert error selectors
- the expiry comparison (`<` or `<=`)
- the final delivery cap

The SDK keeps all of these behind one adapter (`commerce/sdk/src/chain/`), so a change to the ABI touches only one file.

Arc facts that were checked on-chain and still apply:
- Gas is paid in USDC from the same balance as the bounty, so assertions must use event amounts, not raw balance changes.
- The public RPC rate-limits after a few calls per second (error `-32005`).
- `eth_getLogs` is capped at 10,000 blocks, about 2 hours.
- Fork tests cannot move Arc USDC, so local tests use anvil with a mock USDC.

## 2. System design

### 2.1 Components

```text
commerce/                      pnpm workspace, Node 22 LTS, TypeScript strict
  sdk/      @ubc26/sdk         byte codec, chain adapter (viem), API client, EIP-712 quote types
  api/      @ubc26/api         Hono HTTP server, SQLite storage, engine CLI wrapper, Grok adapter, chain indexer
  worker/   @ubc26/worker      solver agent: poll → solve → engine prove → submit → release (runs in WSL2)
  web/      @ubc26/web         Vite + React buyer UI (draft, approve, quotes, fund, watch, decrypt)
  fixtures/                    SIMULATED API and chain fixtures, demo inputs, recorded Grok replies
docs/grok-bot/                 Grok Bot bounty chat exports and README
```

Proposed libraries (all pinned exactly in the lockfile):

| Library | Purpose |
| --- | --- |
| `viem` | Chain access |
| `hono` | HTTP server |
| `better-sqlite3` | Storage |
| `zod` | Request validation |
| `@noble/hashes`, `@noble/ciphers` | SHA-256 and ChaCha20-Poly1305 for checking and for decrypting in the browser |
| `canonicalize` | RFC 8785 |
| `vitest` | Tests |

The worker calls `engine` through `child_process.execFile` with a fixed argument list and no shell.

### 2.2 End-to-end sequence

```text
Buyer UI ──draft──▶ API ──structured output──▶ Grok
                    API ──engine validate──▶ draft | clarification | unsupported
Buyer ──approve(revisionHash)──▶ API ──engine compile──▶ manifest(imageId, rulesHash, referenceHash)
Solver ──GET /v1/jobs, POST quote (EIP-712 signed)──▶ API
Buyer ──select-quote──▶ API ──▶ funding tx request
Buyer wallet ──approve, createJob, fund──▶ Arc core ──hook──▶ H (terms frozen)
Buyer ──funding-receipt(txHash)──▶ API (reads chain, verifies terms, links chainId/core/jobId)
Solver ──GET /v1/assignments──▶ checks terms ──solve──▶ engine prove ──▶ proof.json + key file
Solver ──submit(eth_call preflight, then send)──▶ core ──▶ H.verify ──▶ Submitted (or revert: stays Funded)
Solver ──release(key)──▶ H ──complete──▶ USDC to provider, key emitted
Buyer UI ◀── API index ◀── events; UI pulls envelope from submit calldata, key from release, decrypts
```

### 2.3 State model

App states and chain states are stored separately. Chain state comes only from reads of confirmed blocks.

| App state (local) | Meaning | Allowed next state |
| --- | --- | --- |
| `drafting` | Grok or typed import in progress | `clarifying`, `unsupported`, `drafted` |
| `clarifying` | Waiting on the buyer (max 2 rounds) | `drafting` |
| `unsupported` | Engine capability error; the request payload is stored | terminal (re-draft) |
| `drafted` | A validated revision exists | `approved`, or `drafted` (new revision) |
| `approved` | Buyer approved an exact `revisionHash` and reference digest | `compiled`. Any edit returns the job to `drafted` and voids the approval. |
| `compiled` | Manifest stored | `quoting` |
| `quoting` | Open in `GET /v1/jobs` | `selected` |
| `selected` | One quote is bound to the revision; the funding request has been issued | `funding_pending` |
| `funding_pending` | Transaction hash recorded but not yet confirmed | `linked`, or `selected` if it reverted or was dropped |
| `linked` | The chain identity `(chainId, core, jobId)` has been checked against the manifest | chain-driven |

| Chain state (confirmed) | Source |
| --- | --- |
| `Open` → `Funded` → `Submitted` → `Completed`, or `Expired` (refunded) | Core `getJob` and events |

The worker's own states are `proving`, `submit_pending`, `release_pending`, `released` and `abandoned`. They are local to the worker, shown in the UI as "local", and never shown as confirmed.

### 2.4 Data model (SQLite)

| Table | Key columns |
| --- | --- |
| `jobs` | `id` (ULID), `state`, `current_revision_id`, `created_at` |
| `revisions` | `id`, `job_id`, `n`, `plan_json`, `structure_hash`, `rules_hash`, `reference_digest`, `revision_hash`, `source` (`grok`/`import`), `grok_trace_id` |
| `approvals` | `job_id`, `revision_id`, `revision_hash`, `reference_digest`, `approved_by`, `at` |
| `manifests` | `revision_id`, `image_id`, `rules_hash`, `reference_hash`, `manifest_json`, `package_path` |
| `quotes` | `id`, `job_id`, `revision_hash`, `provider`, `price_units`, `valid_until`, `signature`, `status` |
| `chain_links` | `job_id`, `chain_id`, `core`, `chain_job_id`, `funding_tx`, `verified_at` |
| `pending_txs` | `tx_hash`, `job_id`, `kind`, `from`, `nonce`, `sent_at`, `status` |
| `idempotency` | `key`, `route`, `request_hash`, `response_json`, `created_at` |
| `index_cursor` | `chain_id`, `contract`, `last_block` |
| `events` | `chain_id`, `block`, `log_index`, `tx_hash`, `name`, `job_id`, `args_json` |

`revision_hash = SHA256("UBC26/revision/v1" || JCS(revision without ids))`. The approval binds to this hash, the reference digest, the expiry and the price ceiling.

## 3. API

Every request and response is JSON. All writes take an `Idempotency-Key` header and return `409 revision_conflict` when `If-Match: <revisionHash>` is stale. Errors use one shape: `{ "error": { "code", "message", "details" } }`.

| # | Method and path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| 1 | `POST /v1/drafts` | buyer | `{ request, files: [{name, format}], references?: [{name, b64}] }` | `{ kind: "draft", revision }`, `{ kind: "clarification", questions[] }` or `{ kind: "unsupported", capabilityError }` |
| 2 | `POST /v1/jobs` | buyer | `{ revision }` (from #1, or a typed import) | `{ jobId, revisionHash }` |
| 3 | `POST /v1/jobs/{id}/approve` | buyer | `{ revisionHash, referenceDigest }` | `{ approval }`. Returns `409` if either value differs from the current one. |
| 4 | `POST /v1/jobs/{id}/compile` | buyer | `{ revisionHash }` | `{ manifest: { imageId, rulesHash, referenceHash, … }, packageUrl }` |
| 5 | `GET /v1/jobs?capability=&open=true` | public | — | Jobs open for quotes, with type, capability, expiry window and budget ceiling |
| 6 | `POST /v1/jobs/{id}/quotes` | provider | `{ quote, signature }` (EIP-712) | `{ quoteId, validUntil }` |
| 7 | `POST /v1/jobs/{id}/select-quote` | buyer | `{ quoteId, revisionHash }` | `{ fundingTerms, txRequests: [approve, createJob, fund] }` |
| 8 | `POST /v1/jobs/{id}/funding-receipt` | buyer | `{ txHash }` | `{ chainJob: { chainId, core, jobId } }`, returned only after the on-chain terms equal the manifest and the quote |
| 9 | `GET /v1/jobs/{id}` | public | — | App state, local worker state and confirmed chain state, each labelled separately |
| 10 | `GET /v1/assignments` | provider | — | Funded jobs whose on-chain provider is the caller, with the package URL |
| 11 | `GET /v1/jobs/{id}/submission` | public | — | `{ submitTx, envelopeHash, keyCommitment, releaseTx?, status }` |

**Authentication** (hackathon level, stated plainly in the README):
- **Buyer:** a bearer token from the environment (`BUYER_API_TOKEN`).
- **Provider:** an EIP-191 signature over `METHOD\nPATH\nsha256(body)\ntimestamp\nnonce`. The signature must be no more than 60 s old, and each nonce is accepted only once.
- **Quotes:** EIP-712 with domain `{ name: "UBC26 Commerce", version: "1", chainId }` and type `Quote(bytes32 revisionHash,address provider,uint256 price,uint64 validUntil,uint256 nonce)`.

Planned error codes:

| Code | Meaning |
| --- | --- |
| `validation_failed` | Request is malformed |
| `capability_unsupported` | Engine capability error |
| `revision_conflict` | Stale `revisionHash` |
| `approval_required` | Action needs a current approval |
| `quote_expired` | Quote validity has passed |
| `terms_mismatch` | On-chain terms differ from the manifest or quote |
| `chain_unconfirmed` | Transaction not yet confirmed |
| `engine_failed` | Engine CLI failed |
| `rate_limited` | Request rate limit hit |

## 4. Authoring with Grok

1. **Inputs to the model:** the engine's rule schema and supported-operation catalog (from Anish at the Interface gate), the buyer's request, the declared output file names and formats, and digests of the reference files. The model receives only the declared reference files, never other secrets.
2. **Call:** xAI chat completions with `response_format` set to a JSON schema and temperature 0. The model ID is pinned in `XAI_MODEL` and recorded on every revision. The key lives in the API's `.env` only and is never sent to the browser. The schema must stay within xAI's supported subset; anything outside it is checked afterwards by `engine validate`.
3. **Output union:** `draft`, `clarification` (at most 2 rounds, then the API returns `unsupported` with the reason) or `unsupported`. Every `draft` goes through `engine validate`, and the engine's error is passed back word for word.
4. **Typed import:** a typed plan posted to `POST /v1/jobs` goes through the same `engine validate` step. Grok is optional.
5. **Pass/fail examples:** Grok proposes small sample deliverables, and the **engine evaluates them**. Labels come from the checker, never from the model. If Grok's predicted label disagrees with the checker's verdict, the disagreement is shown to the buyer. This needs a host-side evaluate entry point from Anish (Q-A1).
6. **What the buyer approves:** the normalized rules, rendered from canonical bytes rather than from the model's text, plus units, examples with verdicts, reference digests, evidence signer profiles, expiry, provider and price.
7. **Safeguards:**
   - Every constant has a `source_quote` that points into the buyer's request or a reference file.
   - Model output cannot reach source text or build commands, because the engine's templated emitter enforces this.
   - Every Grok call is recorded (`fixtures/grok/*.json`) so the demo can replay it offline.
   - The demo includes one prompt-injection attempt that fails.

## 5. Solver agent

### 5.1 Decision loop

```text
loop every POLL_MS with backoff on -32005:
  for a in GET /v1/assignments:
    job = core.getJob(a.chainJobId)                     # chain is the source of truth
    skip unless job.provider == self && hook == evaluator == H && state == Funded
    skip unless frozen terms == downloaded manifest (imageId, rulesHash, referenceHash)
    skip unless budget >= MIN_PRICE and (expiredAt - now) >= est_prove + est_submit + RELEASE_MARGIN
    deliverables = solver[jobType].solve(package, reference)          # pluggable, per job type
    out = engine prove … --out attempts/<jobId>/<n>/                  # key file is written privately
    if out.verdict != 1: record, stop (unless --demo-rejected), never release
    eth_call submit → send submit (explicit gas) → wait for receipt → reconcile on timeout
    confirm acceptance event: envelopeHash and keyCommitment equal out
    if (expiredAt - latest.timestamp) < RELEASE_MARGIN: abandon (buyer refunds after expiry)
    send release(key) with explicit gas → wait for receipt → confirm completion event
```

- Each job type has a solver plug-in (`worker/src/solvers/<type>.ts`). A plug-in can call Grok for drafting work, such as producing the text for the signed-text job. Plaintext and keys still never leave the worker host.
- The worker persists its attempts and pending transaction hashes. On restart it reads the chain before taking any action.

### 5.2 Signer policy

The worker's signing wrapper enforces this policy. It is not left to agent discretion.

| Rule | Value |
| --- | --- |
| Chain | `5042002` only |
| `to` | Core or H from the deployment manifest |
| Function selectors | `submit`, `release`, and `setBudget` only if Nick's core makes it provider-only |
| Native value | `0` |
| Gas | Explicit cap per call, plus a daily USDC gas budget (`MAX_GAS_USDC_PER_DAY`) |
| Release margin | `RELEASE_MARGIN = 120 s` by default (block timestamps can jump) |
| Key handling | Never `eth_call` `release` with the real key, because that leaks it to the RPC. Preflight with a dummy key and expect the commitment-mismatch revert. |
| Keystore | Encrypted JSON outside the repo, at `~/.config/ubc26/worker.json` on the WSL2 host |

## 6. Delivery to the buyer

1. `GET /v1/jobs/{id}/submission` returns the accepted submit transaction and the hashes.
2. The UI calls `getTransaction(submitTx)`, decodes `submit(jobId, envelopeHash, optParams)`, then decodes `optParams` to get `envelope`. It checks that `sha256(envelope)` equals the `envelopeHash` from the event.
3. It reads `key` from the confirmed release event (field name UNSPECIFIED) and checks that `SHA256("UBC26/key/v1" || context || key)` equals `keyCommitment`.
4. It decrypts in the browser with `@noble/ciphers`, using the context as AAD, then parses the bundle and offers the named files for download. As a reference path, `engine decrypt` must produce the same bytes. The e2e test (T13) checks this.
5. It shows the receipts for funding, submission (proof accepted), release (payout) and decryption.

## 7. Marketplace and sponsor integration

The main source is [MARKETPLACES.md](MARKETPLACES.md). Issue #4 there no longer applies because the core is now isolated.

| Item | What we do | When |
| --- | --- | --- |
| Job feed | `GET /v1/jobs` and the SDK are the integration surface. Any ERC-8183 marketplace can adopt it through one SDK helper (`createFundedProofJob`). | Core |
| Circle x402 | A paid `POST /v1/jobs/{id}/compile` (or `/v1/drafts`) through Circle's facilitator. First confirm that `gateway-api-testnet.circle.com/v1/x402/supported` lists Arc Testnet with `exact`, then make one real test payment. The bounty stays on ERC-8183. | After First funded job |
| Circle Agent Marketplace | Apply for a listing. Claim "listing submitted" only. | After x402 works |
| ERC-8004 | Register the solver identity at `0x8004A818BFB912233c491871b3d84c89A494BD9e` and put its `agentId` in quotes | Stretch |
| A2A | An agent card that advertises the job feed and quote endpoint | After the core flow |
| QuickNode Streams | Optional event webhooks, checked with HMAC and reconciled against the chain | Stretch |
| Grok Bot bounty (**kept**) | Do real design work with Grok Bot on X (schema prompts, demo fixtures, reviewing this plan). Export the chats daily to `docs/grok-bot/` and add a README on its role. | Daily, starting Nov 14 |

## 8. Demo script

Anish owns the two job types, which must come from unrelated domains. The engine plan proposes **structured record reconciliation** and **signed text**. Commerce runs both end to end with the same API, worker and UI.

1. **Job type A, reconciliation:**
   - Grok drafts from "every invoice must match exactly one payment by ID with equal amount; totals must match".
   - The buyer sees examples with checker verdicts and approves.
   - The job compiles and the buyer funds 1–5 USDC.
2. The solver quotes, is selected, solves, proves, submits and releases. The buyer decrypts.
3. **Job type B, signed text:** the deliverable is a text file plus Ed25519 evidence pinned in the plan. Same flow.
4. **Rejected path:**
   - On a funded job, the worker runs with `--demo-rejected` and submits a real `verdict = 0` receipt. Gas is set explicitly so the transaction is mined and reverts.
   - The explorer shows the failed transaction, and `getJob` still shows **Funded**.
   - The valid submission then pays out.
5. **Refund path:** a job with an expiry of 6–10 minutes and no valid submission. Anyone calls `claimRefund` and the buyer's USDC returns.
6. **Negative paths** (required by the work split):
   - A draft changed after approval is rejected with `409`.
   - A duplicate or interrupted request recovers through the idempotency key and reconciliation.
   - The expired job is refunded.

If live proving takes longer than the demo window, use a receipt generated beforehand for the **exact** funded job, created after the job context is known.

## 9. Security

| Threat | Control |
| --- | --- |
| Key exposed in the mempool before confirmation, or by a failed release | Synthetic data only. Release margin. No real-key `eth_call`. State this in the README. |
| Draft swapped after approval | The approval binds `revisionHash` and the reference digest. Compile and select-quote require that approval to be current. Funding-receipt compares the on-chain terms with the manifest. |
| Replay across jobs or chains | Handled by the engine context and H. The worker also checks provider, chain and H before signing. |
| Malicious or hijacked model output | Engine validation, the templated emitter, `source_quote`, and labels from the checker only |
| Provider impersonation on assignments or quotes | EIP-191 signed requests, EIP-712 quotes, and checks against the on-chain provider |
| Plaintext or keys leaking through the API or logs | The worker never uploads them. Logs exclude secrets, plaintext and keys. The key file has mode `0600`. |
| Secrets in the repo | `.env` is gitignored and `.env.example` is committed. The xAI key, the buyer token and keystores stay outside the repo. |
| RPC abuse or rate limits | Backoff, a second RPC URL, and a persisted log cursor in chunks of 10,000 blocks or fewer |

## 10. Observability and evidence

- Logs are structured JSON (`pino`) with `traceId = app job id`, plus `chainJobId` once linked. There is no secret, plaintext or key field anywhere.
- An evidence ledger, `commerce/fixtures/evidence/<date>.md`, collects every Arc transaction link, gas used, proving time and outcome for the demo and README.
- The UI timeline shows local and confirmed states in separate columns.

## 11. Test strategy

| Layer | Tooling | Coverage |
| --- | --- | --- |
| SDK codec | vitest | §1.2 vectors exact; bundle edge cases (empty `010000`, sort order, name rules); a mutated context fails decryption |
| API | vitest + supertest-style Hono client | Every endpoint, idempotency replay, `409` on stale revision, approval voided on edit, quote expiry |
| Engine boundary | vitest calling the real `engine` binary when present, otherwise recorded SIMULATED outputs | validate, compile and prove parsing; the capability error path |
| Chain | anvil + Nick's contracts (or the ABI stub) + mock USDC | approve → create → fund → submit (accept and revert) → release → refund; reconciliation after a dropped tx |
| End to end | Script `commerce/scripts/e2e.ts` | One full trace; the three negative paths; browser decryption equals `engine decrypt` |
| Live | Arc Testnet scripts | The final evidence only. Fixtures are labelled **SIMULATED** until then. |

CI (GitHub Actions) runs `pnpm -r lint`, `pnpm -r typecheck` and `pnpm -r test` on Linux. The engine and anvil tests are skipped when their binaries are missing, and the skip is reported in the output rather than hidden.

## 12. Tasks

Size key: **S** is 1–2 files, **M** is 3–5. Dependencies are noted with `→`. Gate dates are proposed. The gate names come from WORK-SPLIT.

### Phase 1, Interface gate (target Nov 15 12:00)

**T1 Workspace scaffold (S).**
- Work: pnpm workspace, TS strict, eslint, vitest, CI workflow, `.env.example`.
- Acceptance: `pnpm -r test` passes in CI with zero tests skipped silently.
- Verify: CI is green on the branch.

**T2 SDK byte codec (S) → T1.**
- Work: context, bundle, envelope parse and decrypt, key commitment, journal, `proof.json` types.
- Acceptance: every §1.2 vector matches, and a mutated AAD fails decryption.
- Verify: `pnpm --filter @ubc26/sdk test`.

**T3 Chain adapter on the ABI stub (M) → T1.**
- Work: viem client, contract writes and reads, event decoders, preflight helpers, and a chunked log cursor.
- Acceptance: on anvil with the stub core and mock USDC, the flow create → fund → submit (mock verifier) → release → refund runs, and balance changes are asserted from events.
- Verify: `pnpm --filter @ubc26/sdk test:chain`.

**Checkpoint A:** the codec matches the fixture, and Nick has reviewed the adapter interface.

### Phase 2, First proof gate (target Nov 15 EOD)

**T4 API skeleton (M) → T2.**
- Work: Hono app, SQLite migrations (§2.4), auth, idempotency, revision checks, error format, and `GET /v1/jobs/{id}`.
- Acceptance: an idempotent replay returns the stored response, and a stale `If-Match` returns `409`.
- Verify: API tests.

**T5 Drafting (M) → T4.**
- Work: Grok adapter (structured output, replay recorder), typed import, `engine validate` wrapper, clarification limit, unsupported path, and examples evaluated by the checker.
- Acceptance: one real Grok draft validates, and one request returns `capability_unsupported` with the engine's payload. Both are handed to Anish.
- Verify: API tests plus one manual live Grok call.

**T6 Approval and compile (S) → T5.**
- Work: `approve` binds the hashes, an edit voids the approval, and an `engine compile` wrapper stores the manifest.
- Acceptance: the edit-after-approval test returns `approval_required`.
- Verify: API tests.

**T7 Quotes and selection (M) → T6.**
- Work: `GET /v1/jobs` filters, EIP-712 quote verification, `select-quote` that returns the three transaction requests.
- Acceptance: expired or mis-signed quotes are rejected, and the selected quote is bound to `revisionHash`.
- Verify: API tests.

**Checkpoint B:** draft, approve, compile, quote and status all run against fixtures, which satisfies WORK-SPLIT's commerce criterion for "First proof".

### Phase 3, First funded job gate (target Nov 16 EOD)

**T8 Funding linkage and indexer (M) → T3, T7.**
- Work: `funding-receipt` verifies the on-chain terms against the manifest and quote, then links the job. The indexer persists its cursor and backs off on `-32005`.
- Acceptance: a mismatched `rulesHash` returns `terms_mismatch`, and a restarted indexer resumes without gaps.
- Verify: chain tests.

**T9 Worker loop: solve and prove (M) → T3, T8.**
- Work: assignments, term checks, solver plug-ins for both job types, `engine prove` wrapper, time budget.
- Acceptance: on Anish's fixed funded context, it produces `proof.json` with `verdict = 1`. A verdict-0 receipt is never released.
- Verify: worker tests plus one real prove in WSL2.

**T10 Worker submit and release (M) → T9.**
- Work: signer wrapper (§5.2), preflight, persisted pending transactions, reconciliation, release margin.
- Acceptance: on Arc, the submit is accepted and release pays the provider. A process killed after submit resumes and releases exactly once.
- Verify: live Arc transactions recorded in the evidence ledger.

**T11 Delivery (S) → T10.**
- Work: the submission endpoint, envelope taken from calldata, key taken from the event, browser decryption.
- Acceptance: the decrypted bytes equal both the solver's plaintext and the output of `engine decrypt`.
- Verify: e2e script.

**Checkpoint C:** one real funded job is approved, funded, proved, submitted, released, paid and decrypted on Arc.

### Phase 4, Demo gate (feature freeze Nov 17 EOD, rehearsal Nov 18)

**T12 Buyer web UI (M) → T7, T11.**
- Work: draft and approve screens (rules rendered from bytes, example verdicts), quote list, wallet funding, timeline with local and confirmed states, decrypt and download.
- Acceptance: the demo runs without any terminal on the buyer side.
- Verify: manual run plus a Playwright smoke test.

**T13 Negative paths and e2e trace (M) → T10, T11.**
- Work: rejected submission on Arc (job stays Funded), changed draft returns `409`, duplicate or interrupted request recovery, expiry refund.
- Acceptance: all four are recorded with transaction links.
- Verify: `commerce/scripts/e2e.ts` plus the evidence ledger.

**T14 Sponsor integration (M) → Checkpoint C.**
- Work: x402-paid compile through Circle's facilitator (after the testnet check), Agent Marketplace application, ERC-8004 registration if time allows.
- Acceptance: one real x402 test payment is settled, and the listing is submitted.
- Verify: payment transaction in the evidence ledger.

**T15 Grok Bot bounty (S, ongoing from Nov 14).**
- Work: daily exports to `docs/grok-bot/` and a README on its role.
- Acceptance: the exports show core design work.
- Verify: the files are present in the repo.

**T16 Demo package (S) → T12, T13.**
- Work: demo script, README sections (setup, decision loop, signer limits, trust assumptions), 2–3 minute video, pre-generated receipts as a fallback.
- Acceptance: a fresh clone reproduces the demo by following the README.
- Verify: Nov 18 rehearsal.

**Checkpoint D (Nov 18):**
- fresh jobs run end to end on Arc;
- the video is recorded;
- the evidence ledger is complete;
- the PR is reviewed by Anish and Nick.

**Cut order if behind:**
1. T14 ERC-8004
2. A2A and Streams
3. T14 x402
4. Grok examples (fall back to buyer-written examples that the checker labels)
5. Web UI polish (fall back to the CLI buyer script)

**Never cut:**
- engine-validated drafting with buyer approval;
- one funded job paying out on Arc;
- the rejected submission that leaves the job funded;
- two job types;
- the refund.

## 13. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Settlement ABI undecided (setBudget caller, fund signature, events) | High | All chain code sits behind one adapter (T3). Ask Nick Q-N1–Q-N6 at the Interface gate. |
| Engine schema or catalog late | High | T5 runs on recorded SIMULATED catalog responses. Typed import does not need Grok. |
| Proving time beyond the demo window | Medium | A pre-generated receipt for the exact funded job, plus a longer `expiredAt`. Measure at First proof. |
| Arc RPC limits and the `getLogs` cap | Medium | Cursor plus backoff, a second RPC, and indexing only our contracts |
| xAI schema subset rejects a complex rule tree | Medium | A flatter authoring schema, with the engine validating the full shape. Typed import as a fallback. |
| Faucet and gas both in USDC | Medium | 1–5 USDC bounties, wallets funded on Nov 15, a daily gas cap |
| A reverted submit cannot be shown, because tooling rejects it at estimateGas | Medium | Explicit gas limit on the `--demo-rejected` path; confirm on anvil first |
| Brief wants buyers to compare submissions, which main defers | Medium | Show the quote comparison now. Propose verified pre-proof comparison as follow-on (Q-T1). |
| Key visible before confirmation | Low (synthetic data) | Release margin. Disclose it in the README. |

## 14. Handoffs

| Gate | Commerce gives | Commerce needs |
| --- | --- | --- |
| Interface | Request and response field list (§3) and the chain reads/writes and status fields it expects (§1.3), sent to Nick | Engine: rule schema, catalog, capability error format, CLI JSON shapes. Settlement: ABI stub, chain config shape, mock receipts |
| First proof | One real Grok draft and one unsupported-capability job, sent to Anish | A tiny receipt and the parsed format of `proof.json` |
| First funded job | Funding context (chain ID, core, job ID, provider), so Anish can prove against it | Deployed core, H and verifier addresses, and the manifest |
| Demo | The trace, negative-path evidence and sample inputs | Verdict-1 and verdict-0 bundles for both job types, plus timings |

## 15. Open questions

**For Anish (engine):**
- **Q-A1.** Can the engine expose a host-side `engine eval --plan --deliverables`, so that pass/fail examples are labelled by the checker without proving?
- **Q-A2.** What is the plan JSON schema (op tags, version field, slot syntax)? Can it be published as JSON Schema for Grok?
- **Q-A3.** What is the capability error JSON shape, and what exit codes does each CLI command use?
- **Q-A4.** What are the manifest file names and keys, and what is the image ID's hex byte order?
- **Q-A5.** What format does `--job` take: raw 169 bytes, hex, or JSON?
- **Q-A6.** What format is the key file? Does it match the on-chain `bytes32`?
- **Q-A7.** Does `decrypt` take the context from `proof.json` or as a separate argument?
- **Q-A8.** What are the JSON types of `proof.json` `version` and `verdict`, and what does the timing output look like?
- **Q-A9.** How is `--evidence DIR` laid out, and is it optional when the plan has no evidence?
- **Q-A10.** What format is the preview for buyer approval?
- **Q-A11.** Who publishes the final delivery cap?
- **Q-A12.** Which concrete demo fixtures should be used for reconciliation and signed text?

**For Nick (settlement):**
- **Q-N1.** Which core source is pinned (draft reference or Circle's), and what are the exact `createJob`, `setBudget` and `fund` signatures?
- **Q-N2.** Who may call `setBudget`?
- **Q-N3.** What makes the fund tuple valid (non-zero hashes, an image allowlist)?
- **Q-N4.** What are the event names, fields and indexed topics? Does the release event carry the key?
- **Q-N5.** Is the expiry check `<` or `<=`? What is the minimum expiry, and is there an on-chain release margin?
- **Q-N6.** What are the revert error selectors?
- **Q-N7.** What is the final calldata cap, and the gas measured at 16 KiB?
- **Q-N8.** Does H recompute `envelopeHash` or trust the argument?
- **Q-N9.** Which read methods exist for the frozen terms and acceptance?
- **Q-N10.** When will the ABI stub, the anvil deploy script and the mock receipts be ready?
- **Q-N11.** Is `release` provider-only?
- **Q-N12.** Does `claimRefund` from Submitted refund the buyer even after a proof was accepted?
- **Q-N13.** Does H need whitelisting on the pinned core?

**For the team:**
- **Q-T1.** The brief says "the buyer can compare submissions". Main defers multi-solver competitions. Is a quote comparison plus a single verified submission enough for the demo?
- **Q-T2.** What bounty size should each job use (1–5 USDC proposed)?
- **Q-T3.** Who attends the Nov 21 in-person final?

## 16. Decision log

| Date | Decision | Reason | Status |
| --- | --- | --- | --- |
| 2026-11-14 | Workstream 3 follows main: isolated core with one hook/evaluator, verify inside `submit`, the 234-byte journal, off-chain quotes, two unrelated job types | WORK-SPLIT and ZKVM-IMPLEMENTATION are the agreed sources. This supersedes Neil's earlier proposals for Circle's shared ACP, `attest`, RFQ and scheduling. | Proposed |
| 2026-11-14 | TypeScript for the API, SDK, worker and UI; the worker shells out to `engine` | One language across commerce, viem for chain access. Rust stays in the engine. | Proposed |
| 2026-11-14 | Pass/fail example labels come from the engine, not Grok | Model-written labels are circular | Proposed |
| 2026-11-14 | Buyer decrypts in the browser, with `engine decrypt` as a cross-check | The buyer flow needs no CLI | Proposed |
| 2026-11-14 | Grok Bot bounty kept | User decision | Agreed (Neil) |
