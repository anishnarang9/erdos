# neil status

Follow the [shared status rules](../AGENTS.md#status-and-handoffs). Add a heading with date, time, and UTC offset for each new entry. Keep the newest entry first.

## 2026-11-15 14:30 -05:00 — Neil

- **Checkpoint C is met on Arc testnet.** All transactions and explorer links are in `commerce/evidence/arc-first-funded-jobs.md`.
  - **Job 1 (correct delivery):**
    - createJob, setBudget, approve and fund ran, then a real Groth16 proof (126 s, 812,683 cycles).
    - `submit` was accepted on chain (`ProofAccepted`), and `release` paid the Solver 0.01 USDC (`PaymentReleased`, `KeyReleased`).
    - The buyer decrypted the delivery from public chain data, byte for byte. Final state: Completed.
  - **Job 2 (tampered by one cent):** the proof is a real verdict 0. It was never submitted; the chain's own preflight reverts with `VerificationFailed`. The escrow stayed Funded, and after expiry `claimRefund` returned the budget. Final state: Expired.
- **Fixes found during the live run:**
  - A `.env` parser collapses a leading `\` in UNC paths, so we now use the `//wsl.localhost/...` form, guarded at config load.
  - SQLite cannot lock files on the WSL share, so the API database lives on local disk.
  - The indexer stays 3 blocks behind the head, because Arc's load-balanced RPC can lag.
- **Tests:** API 727, SDK 436, worker 147. Live read-only and real-engine suites are as before.
- **New scripts:** `worker/scripts/verify-delivery.ts` (buyer side) and `claim-refund.ts` (Poster).
- **Next:** the buyer web UI (T12) and the demo script. Nick's items (core freeze, gas figures) and Anish's lookup question are still open.

## 2026-11-15 12:40 -05:00 — Neil

- **Branch:** `neil/plan-architecture` ([PR #5](https://github.com/anishnarang9/UBC-26/pull/5)).
- **Connected to Nick's live contracts on Arc** (`nick-settlement` `80c8a4a`):
  - The SDK has an `arc` client: reads, Poster and Solver transaction requests, preflights, event decoding, and `sendTx` with the Arc fee floor.
  - `hook.contextOf` and `hook.expectedJournal` equal our encoders byte for byte. The context's escrow is the core proxy.
- **API:**
  - `CHAIN_MODE=arc` reads the real core and hook. The indexer starts at the deploy block and reads at most 10,000 blocks per log request.
  - select-quote also returns the `setBudget` and `fund` steps for Nick's 4-transaction order.
  - New `GET /v1/jobs/:id/submission` (T11) serves the submit tx, the hashes, the release tx and the released key.
- **Worker (T9/T10):**
  - `runFunded` takes the context from the chain, checks the job and its terms, and checks the time budget.
  - It submits and releases at most once, keeping progress in `state.json` so it can resume after a crash. A verdict-0 proof is never submitted.
  - A signer policy allows only `core.submit` and `hook.release`.
  - `scripts/first-funded-job.ts` runs the whole funded flow on Arc.
- **Checks:**
  - Default suites: API 695, SDK 436, worker 65.
  - Live read-only on Arc: SDK 31, API 3, worker 3.
  - An independent tester wrote 85 black-box tests for the SDK client. The two issues it found were interface naming and are now documented.
  - Engine drift check: `codex/engine-commerce` changes no interface we use.
- **Live facts:**
  - `jobCounter` is 0, so there are no jobs yet.
  - The core is NOT frozen: the deployer still holds the admin roles, although the manifest's policy text says they were renounced.
  - Arc rejects `eth_getLogs` over 10,000 blocks.
- **Blocked:** the first funded job needs two Arc testnet accounts with faucet USDC. Put the keys in `commerce/worker/.env` as `POSTER_PRIVATE_KEY` and `WORKER_PRIVATE_KEY`, then run `corepack pnpm exec tsx scripts/first-funded-job.ts`, and once more with `--tamper` for the rejected case.
- **For Nick:**
  1. Measured gas for `submit` and `release` (we default release to 500k).
  2. Is a zero priority fee accepted?
  3. When will the core be frozen? Please also fix the manifest's policy text.
- **For Anish:** are the `lookup` duplicate-key aborts intended (see `commerce/api/test/integration/fixtures/grok/README.md`)? Note that `engine/evaluation` on `codex/engine-commerce` imports commerce types from `3013d73`; `Manifest` and `packageDir` have changed since.

## 2026-11-15 10:15 -05:00 — Neil

- **Branch:** `neil/plan-architecture` ([PR #5](https://github.com/anishnarang9/UBC-26/pull/5)).
- **Real Grok drafting works (`grok-4.7`).** The recordings and the handoff for Anish are in `commerce/api/test/integration/fixtures/grok/` (see its README).
  - **Success:** a reconciliation draft that the real engine validates. The checker agreed with Grok's predicted verdict on 4 of 5 examples.
  - **Unsupported:** a regex job returns `capability_unsupported` with the engine's `request: {kind: operation, name: regex_match}`.
- **Changed:** the draft model now also gets the declared reference files as text, capped at 8 KiB each. With file names only, Grok asked twice for the ledger's shape.
- **End to end on live components:** Grok's recorded plan was approved and compiled on the real engine. The worker then proved a correct delivery (verdict 1; engine and SDK decryption match the files) and a tampered one (real verdict 0; decrypt refused). The passing proof took 103 s. An earlier run hung while the PC slept; the rerun passed.
- **Checks:** API 692 and real-engine API 14/14 (both Grok replays included); worker 47; SDK 275; worker e2e 2/2 on Anish's plan and 2/2 on Grok's plan.
- **For Anish:** `lookup` aborts with `invalid_deliverable` when a deliverable repeats an id, so that case gets no verdict-0 proof. Is that intended? Details are in the fixtures README.
- **Still blocked:** Nick's deployed core/evaluator ABI and addresses, for real funding, submit and release (T8 live, T10).
- **Next:** T10 once Nick deploys, then the buyer UI (T12).

## 2026-11-15 02:00 -05:00 — Neil

- **Branch:** `neil/plan-architecture`. Commits `f5d4368`, `91bbfc4` and `7e1dbd0`. The branch is merged with `origin/main` at `9a1b444`.
- **Real engine connected.** The API runs Anish's engine CLI (`codex/anish-engine`, `adda3a3`) in WSL2 through `wsl.exe -e env … engine`, with no shell:
  - `validate` stores `structureHash` and `rulesHash` on each revision.
  - Engine errors pass through unchanged. `unsupported_capability` returns 422 and includes the engine's `request`.
  - `eval` labels draft examples; the model never labels them. A wrong model prediction is flagged with `agrees: false`.
  - `compile` keeps the package under `PACKAGES_DIR` and serves it at `GET /v1/jobs/:id/package(/file)`. Reference files are served at `/references`.
- **Approval binding:**
  - An approval records the engine's `rulesHash`, `structureHash` and the reference digest, and the API re-validates the plan when it approves.
  - Compile rejects a package with different rules, structure or references (502), and deletes it.
  - Any new revision, including a change to reference files only, voids the approval.
  - A plan must declare exactly the job's outputs and the uploaded reference files.
- **Worker (`commerce/worker`):**
  - It downloads the package and checks each file's SHA-256, the manifest and the guest digest.
  - It builds a **SYNTHETIC** funded context, solves, runs `engine prove`, and checks `proof.json` with the SDK.
  - It recovers the files with both `engine decrypt` and SDK decryption. A verdict-0 proof is never decrypted.
- **Checks:**
  - Unit and spec tests: API 692, worker 47, SDK 275, all passing.
  - Real-engine API suite 12/12 (about 10 s). The compile on this PC reproduces Anish's reconciliation image ID `0x57eb5af8…` byte for byte.
  - Worker end to end 2/2 with real Groth16 proofs, 176 s total. One correct delivery gives verdict 1, and both decryption paths recover the exact files. One delivery is tampered by one cent; it gives a real verdict 0, and decrypt is refused.
  - **Native Linux proving (WSL2, 24 cores):** the reconciliation proof took 91.8 s, 812,703 cycles and 9.6 GB peak RSS. Anish's figure on an M3 was 260 s.
  - Cross-validation: two independent testers wrote 80 black-box tests and found 3 API bugs and 7 worker hardening issues. All are fixed.
- **Setup:** see `commerce/README.md` ("Real engine"). It covers Docker with buildx, r0vm 3.1.0 and the pinned prover image in WSL. Note that rzup puts r0vm under `~/.risc0/extensions/…`.
- **Blocked or remaining:**
  - Neil: put `XAI_API_KEY` and `XAI_MODEL` in `commerce/api/.env`, then run `pnpm --filter @ubc26/api record:grok`. That records the real Grok success and the unsupported (regex) example for the integration tests and for Anish. The recorder, the replay test and the cases are ready; the replay test reports itself as not run until the recordings exist.
  - Nick: the deployed core/evaluator ABI and addresses. Until then the worker uses a synthetic context, and T10 (submit and release) is not started.
  - Engine: the API uses copies of `plan-v1.schema.json` and `capabilities-v1.json` from `adda3a3` (`commerce/api/engine-contract/`). The real-engine test fails if `engine capabilities` drifts.
- **Next:** record Grok once the key is in. Then T9/T10 against Nick's deployment.

## 2026-11-14 20:10 -05:00 — Neil

- **Branch:** `neil/plan-architecture`. The workstream 3 plan docs are now on main. The code stays on the branch until it is reviewed.
- **Done on the branch:**
  - T1: the `commerce/` workspace, CI, and the SDK and API contracts.
  - T2: the byte codec, which matches the engine fixture exactly.
  - T3: the viem chain adapter, plus SIMULATED stub ERC-8183 contracts on anvil.
  - T4: the API skeleton covering auth, idempotency and revisions.
  - Each task had a coder and an independent black-box tester, and then each reviewed the other's work. That review found and fixed a provider nonce-replay bug and a path that could leak the release key.
- **Checks:** 394 API tests and 211 or more SDK tests pass locally. The SDK security fixes from the cross-review are in progress.
- **Next:** T5–T8 (Grok drafting, compile, quotes and funding linkage), using SIMULATED stand-ins for the engine and the chain.
- **Blocked on:**
  - Anish: the plan schema and the CLI JSON output shapes.
  - Nick: the settlement ABI, including an evaluator-binding guard.
  - Neil: an xAI API key for live Grok calls.

## 2026-11-14 15:45 -05:00 — Neil

- **Branch:** `neil/plan-architecture` ([PR #1](https://github.com/anishnarang9/UBC-26/pull/1)). I merged `origin/main` (`072cb2c`) into it.
- **Changed:**
  - Added the workstream 3 plan, [COMMERCE-IMPLEMENTATION.md](../current%20plan/COMMERCE-IMPLEMENTATION.md).
  - Added a new top entry in [PLAN.md](../current%20plan/PLAN.md) that adopts main's design. My earlier proposals for Circle's shared ACP, `attest`, RFQ and scheduling are marked superseded.
  - Added superseded banners to ARCHITECTURE.md and MARKETPLACES.md.
  - Added a document index to `agents/AGENTS.md`.
- **Checks:**
  - Recomputed the engine fixture (context, envelope, envelopeHash, keyCommitment, journalDigest) independently with Node `crypto`. All values match ZKVM-IMPLEMENTATION.md.
  - Ran `git diff --check`, checked that no conflict markers remain, and checked that the relative links resolve.
- **Blockers and dependencies:**
  - Anish has to answer Q-A1–Q-A12 (plan schema, capability error, CLI JSON shapes, `engine eval`).
  - Nick has to answer Q-N1–Q-N13 (ABI, events, `setBudget` caller, expiry rule) and provide the ABI stub.
- **Next:** T1–T3 for the Interface gate (Nov 15 12:00): commerce workspace, SDK byte codec against the fixture, and the chain adapter on the ABI stub.

## 2026-11-14 — Neil

- **Done:** wrote a proposed architecture and repository layout ([ARCHITECTURE.md](../current%20plan/ARCHITECTURE.md)), a dated plan entry with revised gates ([PLAN.md](../current%20plan/PLAN.md)) and marketplace integration options ([MARKETPLACES.md](../current%20plan/MARKETPLACES.md)).
- **Verified on-chain (read-only):** Circle's ERC-8183 `AgenticCommerce` on Arc has zero fees, about 193k jobs, `hook = 0` whitelisted and a provider-only `setBudget`. This led to the proposal to settle through a `ProofGateEvaluator` on Circle's live contract. Main has since chosen an isolated core instead.
- **Reviews done:** round 1 had two technical reviewers (zk, settlement/delivery). Round 2 had four reviewers, one per brief step (feasibility and real-world fit). Every verdict was "viable with fixes", and all fixes are applied. See the PLAN.md review log.
