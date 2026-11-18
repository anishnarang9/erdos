# Architecture and repository layout

> **2026-11-18 — Anish — Historical research.** Preserve the proposals below for context. Main contains both the selected-provider path and a separate [open-claim adapter](../../docs/overnight/open-claim-v1.md). The [prepared Arc report](../anish/reports/open-claim-arc-live-acceptance-2026-11-16.md) covers the later 0.01-USDC exchange. Current status belongs in [PLAN.md](PLAN.md), not this research snapshot.

> **Superseded in part (Neil, 2026-11-14 15:45 -05:00).** Main's [WORK-SPLIT.md](WORK-SPLIT.md) and [ZKVM-IMPLEMENTATION.md](ZKVM-IMPLEMENTATION.md) are the agreed design. Commerce work follows [COMMERCE-IMPLEMENTATION.md](COMMERCE-IMPLEMENTATION.md).
>
> **Superseded:**
> - Settling on Circle's shared ACP with an evaluator only (`hook = 0`), `registerTerms`, `attest`/`ProofRejected`, the sealed-bid RFQ and the `scoreFloor` (main uses an isolated core, one hook/evaluator contract, verify inside `submit`, and off-chain quotes)
> - Encoding v1 (`PG/*` tags, 114-byte journal; main uses a 234-byte journal with `UBC26/*` tags)
> - The generic `LinearPlan` guest and the scheduling and procurement job types (main uses a typed rule compiler and two unrelated domains)
> - The `crates/pg-*` layout (main uses `engine/`; commerce uses `commerce/`)
>
> **Still valid:**
> - The verified Arc facts in §2
> - The verifier pin
> - The Circle ACP source behaviour, for comparison
> - The RPC and `getLogs` limits
> - No fork tests on Arc
> - The image-ID determinism notes
> - The Grok safeguards (§7)
> - The signer policy and decision-loop discipline (§8)
> - The WSL2 prover setup (§10)

Status: **proposed** by Neil, 2026-11-14. This builds on Anish's [context](../anish/AGENTS.md) and the 2026-11-14 plan entry. Sections marked **[changed]** differ from that entry, and the reason is given next to each change. Reviewer findings and their resolutions are in [PLAN.md](PLAN.md).

## 1. What we are building

A buyer commissions work in plain English and approves deterministic acceptance rules. The buyer escrows USDC in an ERC-8183 job. The worker solves off-chain and proves in a RISC Zero zkVM that the hidden deliverable passes the rules and that the ciphertext it posts encrypts those exact bytes. A contract on Arc verifies the proof, and the escrow stays funded. The worker then reveals the key in the transaction that pays it, and the buyer decrypts the result.

Non-goals for the hackathon: buyer-only key delivery (pre-inclusion confidentiality), funded competitions with multiple solvers, mainnet, non-linear or ML-judged rules.

## 2. Key verified facts (2026-11-14, read-only RPC and source checks)

| Fact | Value | How checked |
| --- | --- | --- |
| Arc Testnet chain ID | `5042002` (`0x4cef52`) | `eth_chainId` at `rpc.testnet.arc.network` |
| Circle ERC-8183 `AgenticCommerce` proxy | `0x0747EEf0706327138c69792bF28Cd525089e4583` | bytecode present; ERC-1967 impl `0xa316fd02827242d537f84730f8a37d0ba5fd351a`, verified source `src/AgenticCommerce.sol`, solc 0.8.28 |
| Its payment token | `0x3600000000000000000000000000000000000000` (Arc USDC, ERC-20 interface, 6 decimals) | `paymentToken()` |
| Its fees | `platformFeeBP = 0`, `evaluatorFeeBP = 0` | view calls |
| Its usage | `jobCounter = 192,715` | view call |
| `whitelistedHooks(address(0))` | `true`. A custom hook requires Circle's admin role. | view call |
| `setBudget` | **provider-only**. The spec says "client or provider". | verified source |
| `fund(jobId, optParams)` | no `expectedBudget` argument. The spec has one. | verified source |
| `complete` | does **not** check expiry; evaluator-only; status must be `Submitted` | verified source |
| `claimRefund` | permissionless at `>= expiredAt` from Funded/Submitted; not hookable | verified source |
| Job struct | has **no** stored `deliverable`; it exists only in the `JobSubmitted` event | verified source |
| `createJob` | `expiredAt > now + 5 min` | verified source |
| RISC Zero | `v3.1.0` released 2026-11-10; risc0-ethereum `v3.1.0` 2026-11-11 | GitHub releases API |
| **Verifier pin [changed]** | risc0-ethereum tag **`v3.1.0` = `ff30da77ba4afdd496290ebebedb205348b15d83`**: control root `e6feef13…`, selector **`0xe71e6620`**. The previously pinned `f6d9398a` is a **pre-release** commit (selector `0x8b38038c`, old control root). It rejects every real 3.1.0 proof, although its bundled test receipt still passes. | commit messages of `f6d9398a` and `7348df7e`; tag ref |
| Arc precompiles | sha256 (0x02), BN254 ecAdd (0x06) and ecPairing (0x08) return correct results | `eth_call` with test vectors (zk review) |
| RISC Zero on Arc | no existing verifier or router deployment, so we deploy our own | risc0-ethereum `deployment.toml` |
| Groth16 trusted setup | single-party setup `2026-10-20.1`. This is a stated trust assumption in our README. | `f6d9398a` commit message |

## 3. Settlement design **[changed]**

**Old:** an isolated ERC-8183 deployment with a custom policy hook.
**New:** use **Circle's live ERC-8183 contract unchanged**, with `hook = address(0)` and `evaluator = ProofGateEvaluator`, our contract.
**Why:** custom hooks need Circle's admin whitelist, which we cannot get. The evaluator role has no whitelist. Building on the shared kernel also makes the "plugs into an existing marketplace" claim literally true: any ERC-8183 client can name our evaluator. **Fallback:** deploy the same verified source ourselves (admin = us) if Circle's proxy is upgraded or misbehaves. The `ProofGateEvaluator` code stays the same either way.

### 3.1 Lifecycle

```
Buyer                       ACP (Circle ERC-8183)            ProofGateEvaluator (ours)           Worker
  | createJob(provider=W, evaluator=PG, expiredAt, desc=manifestURI#hash, hook=0) -> jobId
  | ---------------------------------------------------------> registerTerms(jobId, terms) [client-only, job Open, once]
  |                                                                                         setBudget(jobId, budget) <-|
  | approve(ACP, budget)  (exact amount: caps any budget change)
  | fund(jobId, "")  -> Funded, USDC pulled into ACP
  |                                                                       solve -> prove (zkVM) |
  |                                              attest(jobId, envelope, seal, keyCommit, scoreFloor) <-| (reverts on bad proof; job stays Funded)
  |                            submit(jobId, deliverable=envelopeDigest, "") <--------------------------| (only after attest succeeded)
  |  buyer sees: ProofAccepted event + envelope bytes, answer still hidden
  |                                                   release(jobId, key) <----------------------------|
  |                                                     check commit, now < expiredAt
  |                            complete(jobId, envelopeDigest, "") <- PG     => USDC to worker, KeyReleased(jobId,key) same tx
  | decrypt envelope with key (off-chain)
  | expiry path: anyone -> ACP.claimRefund(jobId) when now >= expiredAt and not Completed
```

### 3.1b Sealed-bid RFQ mode (compare verified submissions) **[added, round 2]**

The brief says "a requester can compare verified submissions while the answers stay hidden". The deployed ACP supports this without changes: `createJob` accepts `provider = 0`, and `setProvider` is client-only, Open-only and allowed only while the provider is 0.

1. The buyer runs `createJob(provider=0, evaluator=PG)`, then `registerTerms`. `terms.budget` fixes the price, so workers compete on quality.
2. Each candidate W calls `PG.attestCandidate(jobId, envelope, seal, keyCommit, scoreFloor)` while the job is Open.
   - The context uses `provider = msg.sender`, and the budget check is skipped.
   - The attestation is stored per `(jobId, W)` and `ProofAccepted` is emitted.
   - The UI ranks bids by `scoreFloor` while every answer stays encrypted.
3. The buyer calls `setProvider(jobId, best)`, the winner calls `setBudget(terms.budget)`, and the buyer funds.
   - The winner's proof is still valid, because its `ctxH` already contained its address.
4. The winner calls `submit`, then `release`. `release` uses `attestation[jobId][job.provider]` and rechecks `budget == terms.budget`.

Losing bidders do unpaid work, as in any sealed-bid RFQ. If the winner never quotes, the buyer calls `reject` while the job is Open, re-creates it, and the bidders re-prove. The demo runs this on type-A Job A with two workers. The score is `cap − cost` cents, so a cheaper roster scores higher. The losing bid's proof is pre-generated.

### 3.2 `ProofGateEvaluator` contract (Solidity 0.8.28, non-upgradeable)

- Immutables: `acp` (ERC-8183 kernel), `verifier`, and `releaseMargin` (seconds). `verifier` is **our own `RiscZeroVerifierRouter`**, which routes selector `0xe71e6620` to `RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID)` built from tag v3.1.0. The router lets a 3.1.x security re-release be added as a new route without redeploying the evaluator. The deploy script and CI assert `SELECTOR() == 0xe71e6620`.
- `registerTerms(jobId, Terms{imageId, planHash, datasetHash, budget})`. Requires:
  - the caller equals `acp.getJob(jobId).client`;
  - status `Open`;
  - **`job.evaluator == address(this)` and `job.hook == address(0)`**;
  - `budget > 0`;
  - terms not already set (they are immutable once set).

  Emits `TermsRegistered`. A mistake means the client calls `reject` while the job is Open and creates a new job.
- `getJob` returns a tuple with a dynamic, client-chosen `description`. PG decodes only the head words through a low-level `staticcall`, so a long description cannot inflate its gas.
- `attest(jobId, bytes envelope, bytes seal, bytes32 keyCommitment, uint64 scoreFloor)`. Requires status **`Funded` or `Submitted`**. The deployed `submit` also works from Open when the budget is 0 and has no expiry check, so a provider who submits early must not be stranded, and step order should not matter for liveness. It also requires `msg.sender == job.provider`, terms set, `job.budget == terms.budget`, and `block.timestamp + releaseMargin < job.expiredAt`. The contract **computes `envDigest = sha256(envelope)` itself** and never accepts it as a parameter. It rebuilds the context and checks the proof in three steps **[changed, round 2]**:
1. `try verify(seal, imageId, sha256(journal with verdict=1))`. On success it stores `{envelopeDigest, keyCommitment, scoreFloor}` under `(jobId, provider)`, overwriting any earlier attempt, and emits `ProofAccepted(jobId, provider, envelopeDigest, keyCommitment, scoreFloor, envelope)`.
2. Otherwise, `try verify(... verdict=0)`. On success it **emits `ProofRejected(jobId, provider, envelopeDigest, scoreFloor)`, stores nothing and returns without reverting**. The explorer then shows a *successful* transaction with a durable rejection record, the job still Funded and the escrow unchanged. A reverted transaction looks like a bug to judges, and wallets refuse to send one. `acp.reject` is never called, because it would refund the client.
3. Otherwise, `revert InvalidProof()`. Garbage proofs still revert.
- `release(jobId, bytes32 key)`. Requires status `Submitted`, an attestation present, `block.timestamp < job.expiredAt`, and `sha256(KEY_TAG ‖ contextHash ‖ key) == keyCommitment`. It emits `KeyReleased(jobId, key)` and then calls `acp.complete(jobId, envelopeDigest, "")`. It is permissionless because the key alone authorizes it, and payout always goes to `job.provider`.
- `inspect(jobId, envelope, seal, keyCommitment, scoreFloor) view returns (bool passVerdict, bool failVerdict)`. Each verify call is wrapped in `try/catch`, because `verify` reverts on failure. The demo uses it to show "this is a *valid* proof that the rules **failed**", which distinguishes that case from garbage. It does not change state.
- `releaseMargin` = 120 s, measured against `block.timestamp`. Arc timestamps are whole seconds, several blocks share one, and jumps of 5 s or more have been seen.
- No `reject` path. The evaluator never refunds early. Expiry plus `claimRefund` is the only refund. An optional `cancel` is a stretch goal and must be strictly **`Funded` and no attestation**. If it were allowed later, the client could front-run `release`, collect a refund and still read the key from the mempool.
- Double payout or refund is prevented by the kernel's status machine (Completed, Expired and Rejected are terminal). Tests must still cover it.

**Known, accepted residual risks**
1. The key becomes public in calldata or the mempool before inclusion. Payment still goes only to `job.provider`. A release that fails after broadcast, for example because the deadline passed, leaks the key without payment.
   - Mitigations: `releaseMargin` at attest, and a worker that refuses to release when `expiredAt − latestBlock.timestamp < 120 s`.
   - The preflight is **local** (status, expiry, recomputed commitment), or an `eth_call` of `release` with a *dummy* key that expects the commit-mismatch revert. Never `eth_call` with the real key: that sends it to the RPC operator.
2. A provider may `submit` a deliverable different from the attested one. This is harmless: release uses the attested envelope, which is the single source of truth, and the UI reads `ProofAccepted`, not `JobSubmitted`.
3. **Budget games:**
   - The deployed `fund` does not require `budget > 0`.
   - A provider can front-run `fund` with `setBudget(lower)`. `fund` then pulls the lower amount and `attest` fails forever, leaving allowance on ACP.

   Mitigations:
   - The UI `eth_call`s `getJob` immediately before `fund` and requires `budget == terms.budget > 0`.
   - The UI approves the exact amount per job and resets the allowance to 0 afterwards.
   - `attest` rechecks the budget.
4. **Circle can upgrade the ACP** (UUPS, Circle's DEFAULT_ADMIN). Before signing, the worker and UI check that ERC-1967 slot `0x3608…2bbc == 0xa316fd02…351a`. Changes to fees do not break `complete`. Fallback: the self-deployed kernel.
5. **The buyer has no exit before expiry** (`reject` in Funded is evaluator-only). Keep demo expiries short. `createJob` needs more than 5 minutes, so allow 6–10 minutes of wall time for the expiry-refund demo.
6. **The result is hidden only until it is paid for.** After payout, `ProofAccepted` (the envelope) and `KeyReleased` (the key) are both public, so anyone can decrypt the deliverable. The pitch says *"hidden until paid"*, never "confidential". A buyer-only key is roadmap work: the guest derives `k = KDF(s, ECDH(eph, buyerPk))` and `release` reveals only `s`. This design is ZKCP-style fair exchange, and we acknowledge that lineage.

## 4. Cryptographic binding (encoding v1)

All integers are big-endian and fixed-width. Tags are ASCII. The same bytes are produced by `pg-core` (Rust, no_std), `ProofGateEvaluator` (`abi.encodePacked`) and `packages/sdk-ts`. Golden vectors live in `fixtures/` and CI checks all three implementations against them.

```
CTX   = "PG/ctx/v1" ‖ chainId:u64 ‖ acp:addr20 ‖ evaluator:addr20 ‖ jobId:u256 ‖ provider:addr20 ‖ planHash:b32 ‖ datasetHash:b32
ctxH  = sha256(CTX)
envelope = nonce:12 ‖ ciphertext ‖ tag:16          ChaCha20-Poly1305(key:32, nonce, plaintext=canonicalDeliverable, aad=ctxH)
envDigest = sha256(envelope)
keyCommit = sha256("PG/key/v1" ‖ ctxH ‖ key)
JOURNAL = "PG/jrn/v1" ‖ ctxH:b32 ‖ verdict:u8 ‖ scoreFloor:u64 ‖ envDigest:b32 ‖ keyCommit:b32   (114 bytes, env::commit_slice, NOT serde)
on-chain:  verifier.verify(seal, imageId, sha256(JOURNAL))
planHash    = sha256("PG/plan/v1" ‖ canonicalPlanBytes)        (jobType:u16 ‖ loweringVersion:u16 ‖ thresholds, coefficients, rule parameters)
datasetHash = sha256("PG/data/v1" ‖ canonicalDatasetBytes)     (agreed inputs: workers, costs, availability, items, ...)
```

Guest program: read the private inputs (`plan`, `dataset`, `deliverable`, `key`, `nonce`, `scoreFloor`) and the public context fields. Recompute `planHash` and `datasetHash` itself. Decode strictly and reject any non-canonical encoding. Evaluate the rules with checked arithmetic. Encrypt **the same `deliverable` bytes**. Commit the journal. `verdict = 1` only if every constraint holds **and** `score ≥ scoreFloor ≥ plan.minScore`. The guest must **halt normally** for a failing verdict, writing `verdict = 0` with no panic, because the on-chain verifier only accepts exit code Halted(0). A failing verdict therefore still produces a valid receipt, which the demo uses. Malformed input may panic, and then no receipt exists.

**No exact score in public [changed]:** the plan, dataset and score are all visible to the buyer, so on small instances an exact score lets the buyer solve for the hidden answer. The journal therefore commits only a worker-chosen `scoreFloor`, a lower bound the worker chooses to reveal. Buyers can still rank verified submissions by floor. Score coefficients must be non-negative, so the score is always a `u64`; the lowering rejects anything else. The fixture sizes are toys and the demo says so. Type B uses N ≈ 32 items, so brute force is not instant.

Crate pins: `chacha20poly1305 = { version = "0.11", default-features = false, features = ["alloc"] }` (default features pull in `getrandom`, which breaks on the zkVM target). Use `sha2 = "=0.10.8"` with risc0's `[patch.crates-io]` `sha2-v0.10.8-risczero.0` in the guest workspace root for the SHA-256 accelerator. The evaluator address and jobId are inside `ctxH`, which blocks replay across jobs, contracts and chains. The worker generates a fresh key and nonce from the OS CSPRNG for each attempt and never reuses them.

**Image ID determinism:** `embed_methods` builds *locally* unless `build.rs` opts into Docker, and a local build yields a different ELF and image ID. Therefore:
- `guests/methods/build.rs` sets `GuestOptions.use_docker(DockerOptionsBuilder::default().root_dir("../.."))`, so path dependencies on `crates/pg-core` resolve.
- The guest has a committed `Cargo.lock`, because Docker builds use `--locked`.
- The pinned risc0 crates are version 3.1.0, with the default builder tag `r0.1.97.0`, which is not overridden.
- `pg-host` asserts `compute_image_id(elf) == terms.imageId` before proving. The worker also checks `terms.imageId ∈ guests/image-ids.json` before accepting a job.
- CI rebuilds in Docker and diffs against `image-ids.json`.
- **Wallet `.env` files live outside the repo** (`~/.config/pg/`). The risc0 Docker context copies the repo root, and its ignore list does not exclude `.env*`.

## 5. Rules, compiler and two job types **[changed]**

**Change:** the demo uses two **different job types**, as the brief requires, built with the same compiler and verifier. The earlier plan used two scheduling jobs that differed only in thresholds.

- **Rule IR (`pg-rules`):** a typed `JobSpec`, tagged by job type → strict validation → lowered to a `LinearPlan`. A `LinearPlan` has a Boolean decision vector `x ∈ {0,1}^n` with a canonical index order and constraints `Σ aᵢxᵢ (≤|≥|=) b`. Coefficients and bounds are `i64` with checked `i128` accumulation. An optional linear `score` with non-negative coefficients and a `minScore` is supported. Money is in cents. Dimensions are bounded (n ≤ 256, constraints ≤ 256).
- **One generic checker guest [changed per zk review].** The earlier idea was a template-generated guest per shape. That would force a Docker rebuild (minutes) and a new image ID whenever Grok changes a dimension, would break live authoring, and would save almost nothing, because proving time is dominated by the fixed recursion and Groth16 steps. Instead:
  - The "compiler" is the deterministic, versioned **lowering** `JobSpec → LinearPlan` plus canonical bytes. The same approved rules always give the same `planHash`.
  - The checker is **one audited RISC-V program** that interprets any bounded `LinearPlan`. It is identified by a single pinned image ID.
  - The funded job pins `(imageId, planHash, datasetHash)`, which together are "the compiled checker" in the brief's sense.
  - Pitch line: *one small audited checker, any job type; adding a job type adds a lowering, not a new circuit.*
  - A per-type specialized guest is a post-hackathon optimization.
- **Fidelity to the brief ("compiles rules into a Rust checker") [added, round 2].**
  - `pg-rules` also emits a deterministic, readable **`checker_<planHash>.rs`**: template-generated, with constants folded, `no_std`, `fn check(x) -> Verdict`.
  - A native **differential test** runs it against the interpreter on every fixture.
  - The UI shows it in a "Compiled checker" tab together with its sha256.
  - Framing: *approved rules compile to plan bytecode plus readable Rust; one pinned, audited zkVM checker runs the bytecode, the way Solidity compiles to bytecode for a fixed EVM.*
  - Nov 19 stretch: build one specialized guest from the emitted `.rs` twice in Docker and show the same image ID, which demonstrates "same rules, same checker" literally.
- **The buyer verifies what they pin.** The API returns the canonical plan bytes. The UI hashes them itself (TS sha256) and renders the constraint rows **decoded from those bytes**, so the buyer never relies on our server's `planHash`. The plan bytes carry `jobType` and `loweringVersion`, so changing a lowering cannot silently change what approved rules mean. Post-hackathon: run the lowering inside the guest.
- **Deliverable cap:** at most 4 KB. Executor cycles for 1/4/10 KB are measured at G1. Estimates: 4 KB is about 0.3–0.5M cycles, one segment. Software ChaCha dominates.
- **Type A, shift scheduling** (Anish's fixture, unchanged). There are 3 workers at 4,000/5,000/6,000 ¢ per shift, 2 shifts and at most 1 shift per worker. Job A: cost ≤ 10,000, coverage ≥ [1,1]. Job B: cost ≤ 16,000, coverage ≥ [2,1]. Job B shows the failing submission followed by the passing one.
- **Type B: decision at G1 (Nov 15, 18:00) [changed, round 2].** Two reviewers disagreed:
  - **B-default, GPU/compute procurement** (linear, no new guest code). Buy at least X GPU-hours from N ≈ 32 offers under a budget. Forbid non-compliant data-residency regions, cap how much goes to any one provider, and require a named provider. The score is the GPU-hours bought, published only as `scoreFloor`. This is the old vendor-selection lowering, re-themed as a live AI-infrastructure problem. Cost: about 2 hours.
  - **B-upgrade, ledger reconciliation (ETL)** via a second guest primitive, `TablePlan`, in the **same guest and image ID** (`enum Plan { Linear, Table }`).
    - An **LLM worker** turns about 64 messy, agreed transaction lines into a canonical ledger. The rows are fixed-width integers, with no floats.
    - The proof shows that every input appears exactly once, nothing was invented, amounts are preserved, categories come from an allowed set, and per-category totals equal the agreed control totals.
    - The operations are `FieldRange`, `FieldIn`, `Unique`, `KeysEqual` (a sorted-merge bijection), `FieldEqInput`, `GroupSum == control` and `RowCount`, which mirror dbt's data tests.
    - This answers "both demo types are the same ILP" and puts an AI agent, not a solver, behind the deliverable.
    - Be honest in the pitch: it proves integrity invariants, not that each category is semantically right.
    - Cost: about 1–1.5 days split across L1 and L3.
  - **Rule:** take B-upgrade only if G0 is green **and** the G1 checker proves type A by Nov 15 at 18:00. Otherwise ship B-default. Either way, B-default's fixture is written, since it is the fallback.
- **Pass/fail examples [changed, round 2].** If the checker merely labels examples the LLM suggested, it only shows that the checker agrees with itself. A passing example on the *funded* dataset would also hand the buyer the answer for free. So:
  - Examples run on a **miniature sample instance** (for example 6 of the 32 items), never on the funded dataset.
  - The LLM **predicts** each label with a one-line reason, and the native checker labels it. Every disagreement is shown as "your rules don't say what you meant."
  - `pg-solver` shows the **worst passing deliverable** on the mini instance (lowest score, most concentrated) and, for each rule, a solution that passes only because that rule is missing. This is precomputed if the solver is late.
  - Rules are rendered back to English **deterministically from the plan bytes**, not paraphrased by the LLM, so the buyer approves exactly what the checker enforces.
- The schedule *costs* are job data. The USDC *bounty* is separate and small (for example 1–5 USDC) to suit faucet limits. 1 cent = 10⁴ USDC base units, if the two ever need to match.

## 6. Repository layout

```
UBC-26/
├─ agents/                         planning context for humans + coding agents (this folder)
├─ Cargo.toml                      Rust workspace; rust-toolchain.toml pins stable for host crates
├─ crates/
│  ├─ pg-core/                     no_std+alloc: encodings, ctx/journal/key-commit, linear checker, ChaCha20-Poly1305; shared guest+host
│  ├─ pg-rules/                    JobSpec schema (serde, deny_unknown_fields), validation, versioned lowering → LinearPlan,
│  │                               canonical bytes, planHash; also builds to WASM so the buyer UI recomputes planHash locally
│  ├─ pg-host/                     prover: image-ID check, run guest, Groth16 receipt, seal via risc0-ethereum-contracts 3.1.0; benches
│  ├─ pg-cli/                      `pg rules validate|lower|hash`, `pg prove`, `pg fixtures`
│  ├─ pg-solver/                   reference solvers per job type (backtracking / exhaustive for demo sizes)
│  └─ pg-worker/                   CLI agent: watch chain (alloy), decide, solve, prove, attest, submit, release; signer policy
├─ guests/
│  ├─ checker/                     the one generic LinearPlan checker guest (+ committed Cargo.lock, sha2 patch)
│  ├─ methods/                     risc0-build with use_docker(root_dir = repo root): embeds ELF + image ID
│  └─ image-ids.json               pinned image ID, CI-checked
├─ contracts/                      Foundry
│  ├─ src/ProofGateEvaluator.sol
│  ├─ src/interfaces/IAgenticCommerce.sol   (from verified Circle source)
│  ├─ lib/risc0-ethereum @ v3.1.0 (ff30da77)  (router + Groth16 verifier; selector 0xe71e6620 asserted)
│  ├─ script/Deploy*.s.sol         verifier + evaluator; writes deployments/arc-testnet.json
│  ├─ vendor/AgenticCommerce.sol   verified Circle source (impl 0xa316fd02…) for exact local tests
│  └─ test/                        local: vendored ACP + mock USDC + mock/real verifier; no Arc-fork tests
├─ fixtures/                       golden vectors (JSON + hex): ctx, journal, envelope, keyCommit, receipts (pass/fail) per job
├─ packages/sdk-ts/                viem client + ABIs, ACP impl-slot check, decrypt helper (@noble/ciphers) — no full encoding port
├─ apps/
│  ├─ api/                         TS (Hono): /draft, /clarify, /compile, /jobs/:id, /jobs/:id/submission; shells to `pg` CLI
│  └─ web/                         Vite + React + viem buyer UI: author → review rules/examples → create/fund → watch → decrypt
├─ deployments/arc-testnet.json    addresses, image IDs, verifier selector, block numbers
├─ scripts/                        e2e demo scripts (bash), env setup (WSL), faucet notes
└─ .github/workflows/ci.yml
```

Language boundaries: Rust does everything correctness-critical: the checker, encodings, the prover, the worker. TypeScript is presentation plus orchestration, and it only re-implements the encodings needed for display and decryption, tested against `fixtures/`.

## 7. Authoring (Grok)

`apps/api` calls the xAI API with a structured-output JSON schema generated from `pg-rules`. The model returns either `{clarify: [questions]}` or `{jobSpec}`. The result is validated in Rust (`pg rules validate`), so the model's output is never trusted. The UI shows the normalized rules, units, data, examples (labelled by the checker), budget and expiry. The buyer's wallet signs `createJob`, `registerTerms`, `approve` and `fund`. The model has no keys. The adapter interface (`draft(prompt, context) -> Draft`) lets any LLM or a raw JSON import plug in.

Safeguards **[added, round 2]**:
- **The schema uses only xAI-enforced features:** `oneOf` with a `const` tag for `{clarify}|{jobSpec}`, enums, and non-circular `$defs`. No `format`, `not` or `if/then`, which xAI treats as best-effort only. A test checks the generated schema.
- **Model settings:** pinned model ID, temperature 0, at most 2 clarification rounds. Grok responses are recorded so the demo can replay them if the API is slow.
- **Data provenance:**
  - The dataset comes only from a buyer-uploaded CSV or JSON. The LLM maps columns and writes rules; it never writes rows.
  - Every numeric constant carries a `source_quote`, and the server checks that the quote appears in the buyer's prompt or data.
  - Money arrives as decimal-dollar strings, is converted to cents by the lowerer, and is displayed back as "$100.00".
- **Prompt injection:** data reaches the model as a typed table (columns and stats), not prose. A 20-second demo beat shows a poisoned catalog row ("ignore the budget cap") leaving the approved plan and `planHash` unchanged. For context, Grok was prompt-injected into draining about $150k from a Bankr wallet in May 2026.
- **Agent as requester (stretch):** a signed `Mandate` sets a budget cap, required rule floors, allowlisted dataset hashes and an expiry window. A JobSpec provably within the mandate is auto-approved; anything else goes to a human. This mirrors AP2 intent mandates.

## 8. Worker agent and signer policy

**Agentic design [changed, round 2]: LLM planner, deterministic executor.** A fixed solver script would not read as an agent to an Agentic Payments track.

- **Tools exposed to the model (Grok):**
  - `get_job_terms`: typed, validated plan numbers only. The model **never** sees the raw description or manifest text.
  - `estimate_cost`: measured proving seconds, gas in USDC, deadline slack.
  - Solvers: `solve_backtrack`, `solve_greedy`, `solve_ilp` (good_lp/microlp), and `propose_candidate`, where the model writes its own assignment or, for B-upgrade, the ledger rows.
  - `native_check`: the `pg-core` verdict and exact score.
  - `submit_bid(candidate, scoreFloor)`.
- **What the model decides:** bid or skip (bounty vs. proving cost and deadline), which tool to try and when to stop, and **which `scoreFloor` to reveal**. That last one is a real trade-off: a higher floor wins the RFQ but leaks more about the answer.
- **Hard rails in Rust:**
  - Prove only on a native pass with `scoreFloor ≤ score`.
  - Cap proofs per job and per day, USDC gas per day, and model tokens per job.
  - The model's output is a schema-validated decision object. It never sees keys and never builds transactions.
  - Worst case under prompt injection: wasted compute or a skipped job, never lost funds.
- **Demo:** the decision log streams to the UI. It shows one job declined (bounty too low or deadline too tight) and one job where the agent compares greedy against ILP before bidding.
- **Fallback:** the deterministic loop below.
- Circle Agent Wallet spending policies only apply on mainnet, so our guardrails are enforced in our code and we do not claim Circle enforces them.

Decision loop: poll `JobCreated` / `JobFunded` for jobs where `provider == self` and `evaluator == ProofGate` (allowlisted addresses). Fetch the manifest and verify `planHash` and `datasetHash` against the registered terms. Check that the budget meets the worker's minimum and that the deadline leaves time for the measured proving time plus a margin. Also confirm `job.evaluator == ProofGate`, `job.hook == 0`, `terms.imageId ∈ image-ids.json` and that the ACP implementation slot matches. Then solve, run the native checker, and **prove only if the native verdict passes**; a demo flag forces a failing proof. Preflight `attest` and `submit` with `eth_call`. Preflight `release` locally (§3.2 risk 1). Reconcile chain state before any retry, and make every step idempotent by reading status first. Order: attest → submit → release.

**RPC limits (measured):** the public Arc RPC returns `-32005` rate-limit errors after a few calls per second, and `eth_getLogs` is capped at 10,000 blocks, about 2 hours at 0.7 s per block. So:
- the worker keeps a persisted block cursor and retries with backoff;
- `apps/api` indexes `ProofAccepted`, `KeyReleased` and ACP events by jobId, so the UI never scans logs;
- we use a second or paid RPC endpoint if one is available.

Signer policy, enforced in code before signing: chain ID 5042002 only; `to ∈ {ACP, ProofGate}`; selector ∈ {`setBudget`, `submit`, `attest`, `release`}; `value = 0`; gas ≤ cap; the key never leaves the process except inside `release`. Arc's native gas is USDC, so the worker wallet needs testnet USDC for gas.

## 9. Testing matrix (gate evidence)

| Area | Tests |
| --- | --- |
| pg-core | encoding round-trip, non-canonical rejection, checked overflow, AEAD vectors (RFC 8439), property tests on checker |
| Cross-language | Rust ↔ Solidity byte-equality on `fixtures/`. TS only decrypts (`@noble/ciphers`) and checks `envDigest`, with one fixture. |
| Guest | pass/fail receipts per job; tampered ciphertext/plan/dataset → different journal; executor cycle counts recorded; seal prefix == `0xe71e6620` |
| Contracts (round 2 additions) | a valid `verdict = 0` receipt → `ProofRejected` emitted, no revert, job stays Funded; a garbage seal → revert; RFQ: `attestCandidate` from 2 workers on an Open job with provider 0, `setProvider(best)`, winner `setBudget` → fund → submit → release; a loser cannot release; candidate attestation after `setProvider` is rejected |
| Contracts (local) | **The vendored, verified `AgenticCommerce.sol` behind an ERC1967Proxy with a 6-decimal mock ERC-20**, giving exact deployed semantics. Contracts are tested against it with `RiscZeroMockVerifier` first, then with fixture receipts and the real Groth16 verifier. Cases: wrong image ID, mutated journal fields, cross-job replay, other evaluator, swapped envelope, wrong key, attest after the margin, release after expiry, release at exactly `timestamp == expiredAt`, double release, release before submit, non-provider attest, terms set twice / by non-client / after fund, evaluator or hook mismatch in `registerTerms`, budget mismatch, `setBudget` lowered after terms, fund with budget 0, submit before attest, Open-state submit with budget 0, `inspect` on a `verdict = 0` receipt. |
| Live on Arc (scripted txs, **not fork tests**) | **Arc-fork tests do not work:** Arc USDC calls native system precompiles `0x1800…` that revm/anvil lack. So the lifecycle is run as scripted txs on Circle's ACP with real receipts: the failing-verdict attest emits `ProofRejected` in a successful tx and the job stays Funded; RFQ with two bidders; expiry refund from Funded and from Submitted. Assertions use the **event amounts** (`JobFunded`, `PaymentReleased`, `Refunded`). Balance deltas must add back gas, because gas is paid in the same USDC: `ΔERC20 + ceil(gasFee/1e12)` within ±1. |
| E2E | `scripts/demo.sh` creates fresh jobs A/B (type A) and C (type B) and archives tx hashes to `deployments/demo-runs/` |

## 10. Environment (prover host = WSL2 on Neil's PC)

The machine has an Intel Core Ultra 9 275HX, 31 GB RAM and an RTX 5080 Laptop GPU, with WSL2 Ubuntu installed. Setup:

1. Create `%UserProfile%\.wslconfig` with `[wsl2] memory=24GB swap=16GB processors=16`, then run `wsl --shutdown`.
2. Inside WSL, install rustup, `rzup install r0vm 3.1.0` and `rzup install cargo-risczero 3.1.0` (exact versions: the host rejects a major.minor mismatch), Docker Engine (or Docker Desktop with WSL integration), Foundry and Node 22 LTS. Keep the repo on the Linux filesystem (`~/UBC-26`), not `/mnt/c`.
3. Pre-pull the Docker images: `risczero/risc0-groth16-prover:v2026-10-20.1` (about 2.5 GB) and the guest builder `r0.1.97.0` (about 1.7 GB).
4. **Local Groth16 in 3.1.0 = CPU STARK + the Docker gnark prover, x86 only.** This is confirmed, and there is no native CPU shrink-wrap.
   - Use the **default features** of `risc0-zkvm`.
   - **Do not enable `cuda` before G2.** That feature removes the Docker Groth16 path at compile time, and Blackwell sm_120 support is unverified.
   - Unset `BONSAI_API_URL` and `BONSAI_API_KEY` so proving stays local.
   - Expected: guest about 10⁵ cycles, one segment, roughly 1–3 minutes per proof on CPU. G0 measures the time and peak RAM.
5. **Fallback prover:** a second x86 Docker host (a teammate's machine or a rented VM) with the same pinned images.
   - Bonsai shut down in December 2025.
   - Boundless needs a funded wallet, program upload and auction latency, and it returns aggregated SetVerifier seals rather than our raw `0xe71e6620` seal. It is not used before Nov 20.
6. **Pre-generated receipts are tied to one job,** because `ctxH` binds jobId and provider. Demo jobs are created Nov 17–18 with long expiries and proved ahead of time, and the `attest` calldata is archived unsent. The refund demo uses its own short-expiry job.

Keys: three testnet wallets (deployer, buyer, worker) stored in `~/.config/pg/*.env`, **outside the repo** (see §4). Fund them from the Circle faucet. Repo hygiene: `.gitignore` covers `.env*`, `target/` and `out/`.

## 11a. Positioning and real-world fit (round 2 research; cite in README and pitch)

- **The gap: payment rails verify the agent, not the work.**
  - Google AP2 mandates, Visa's Trusted Agent Protocol, Mastercard Agent Pay and AP4M, and Stripe/OpenAI's ACP all solve identity and authorization.
  - None of them guarantees that the delivered work is correct.
  - Disputes over agent purchases have no clear liability owner and count toward card dispute ratios (Chargeflow; Chargebacks911, Oct 2026).
  - x402 is pay-first, with no delivery guarantee.
- **The evaluator problem is openly discussed.** Writing on Virtuals ACP (Forkast, Jul 2026) and the ERC-8183 Magicians thread asks who evaluates, and whether the evaluator can collude with the provider. BNBAgent uses UMA optimistic votes. Live ERC-8183 evaluators are an ECDSA attestor or LLM consensus. We found **no live ZK evaluator**.
- **Our niche:** instant, cryptographic, pay-on-outcome for **machine-checkable** work: rostering, procurement and allocation baskets, reconciliation/ETL integrity, and compliance checks. It complements LLM and optimistic evaluators for subjective work, and we are honest that it does not judge free-form quality.
- **Why now:**
  - Agent wallets are being prompt-injected (Grok/Bankr, May 2026), and our LLM never touches the signer.
  - Freelance non-payment is widespread: 62% of NY freelancers report it (Freelancers Union). Proof-gated escrow removes the risk for both sides.
  - The OCC finalized its GENIUS Act rule on Oct 21 2026, so regulated USDC escrow is credible for businesses.
  - The EU AI Act's high-risk obligations (which include work allocation) are deferred to Dec 2027, not dropped, so auditable rules with human approval are relevant.
- **Competitor to name:** Horizen Labs' agent registry pairs ZK proofs with x402, but its CodeAuditor relies on an LLM judge and its agents are "In Development". Our difference is deterministic rules, an encrypted deliverable, and escrow gated by the proof.

## 11. Engineering standards

These are trimmed to hackathon weight, per the delivery review. The cut items are listed after Nov 20.
- CI must be green before merging: `cargo fmt --check`, `clippy`, `cargo test`, `forge test`, `tsc --noEmit`, and the Rust ↔ Solidity fixture check. PR review is encouraged but not required. Proving and Docker image-ID checks run manually on the prover host, and results are logged in PLAN.md.
- Commits follow Conventional Commits. Each PR does one thing. Architecture changes go in a dated PLAN.md entry instead of ADRs for now.
- **After Nov 20:** property tests, Docker image-ID CI, ADRs, mandatory reviews, WASM `pg-rules` in the UI, and specialized per-type guests.
- Every deployed address and image ID goes into `deployments/arc-testnet.json`, and only from scripts, never by hand.
- No secrets in the repo, the logs or the UI. The worker logs tx hashes, never keys, until the release succeeds.
