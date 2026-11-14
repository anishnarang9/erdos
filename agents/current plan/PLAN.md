# Current plan

Follow the [shared planning rules](AGENTS.md). Add dated entries newest first.

## 2026-11-14 18:56 -05:00 — Anish — Funded submit preflight

- The [reconciliation proof pair](../../engine/fixtures/reconciliation) now uses the reviewed checker. The local Solidity test accepted both original journals and rejected a failing receipt against a passing journal.
- A [read-only submit preflight](../../engine/tests/verify-funded-arc.mjs) uses the documented `submit` ABI. It simulates the exact passing proof from the funded provider, checks that a changed seal reverts, and requests a gas estimate at the same block.
- Run the preflight after verifying the deployed core, evaluator, and job terms. The November 16 settlement test still requires a funded job for the chosen engine package.

## 2026-11-14 18:49 -05:00 — Anish — Engine release handoff

- The engine now builds typed Rust checkers for record and signed-evidence workloads. The [catalog](../../engine/capabilities-v1.json), [plan schema](../../engine/plan-v1.schema.json), and [CLI guide](../../engine/README.md) are ready for commerce integration.
- Published [reconciliation](../../engine/fixtures/reconciliation) and [signed-text](../../engine/fixtures/signed-text) fixtures. Verifier and journal tests run on a local EVM. [Arc RPC reports](../../engine/fixtures/arc-rpc) record temporary verifier simulations at specific testnet blocks.
- Nick supplies the deployed core, evaluator, verifier, ABI, delivery cap, and confirmed funded terms. The engine consumes the exact funded provider and job ID with matching package commitments. Use the job JSON helper to prepare the input after confirming those terms.

## 2026-11-14 16:07 -05:00 — Anish — Scalar proof fixtures for settlement

- The engine produced real [passing](../../engine/fixtures/scalar-proof-pass-v1.json) and [failing](../../engine/fixtures/scalar-proof-fail-v1.json) Groth16 receipts with the full 234-byte journal. Both use the same checker image and synthetic funded context. The local Solidity verifier accepted each original journal. It rejected the failing receipt when tested against a passing journal.
- The local script proved both cases and recovered the passing delivery byte for byte. Neil can use the [host preview command](../../engine/README.md#evaluate-an-example) to label authoring examples. Nick can use the pair for local Solidity tests before supplying the live funded context.

## 2026-11-14 16:03 -05:00 — Anish — Scalar engine and commerce interface

- The [scalar plan schema](../../engine/plan-v1.schema.json) and [CLI contract](../../engine/README.md) answer the current authoring, compiler, proof, and recovery format questions. The CLI builds a checker package from approved structure and reference data.
- A threshold-only edit changed the rules hash and preserved the guest image ID. Real funded-job receipt generation is in progress. The current guest evaluates scalar fields and whole text files. Record collections and signed evidence remain pending.

## 2026-11-14 15:47 -05:00 — Anish — First real proof

- The digest-pinned Docker guest produced a [real Groth16 smoke receipt](../../engine/fixtures/groth16-smoke-v1.json). The released v3.1.0 Solidity verifier accepted it and rejected altered inputs on a local EVM.
- The receipt uses the fixed smoke journal. Settlement can use it to check the verifier on Arc. A funded payout requires an engine-generated receipt with the 234-byte job journal.

## 2026-11-14 15:42 -05:00 — Anish — Engine interface checkpoint

- Engine branch `codex/anish-engine` publishes the [wire fixture](../../engine/fixtures/wire-v1.json) and the [first plan validator](../../engine/README.md). Solidity and TypeScript can use the fixture to check the context, journal, and encryption bytes.
- The validator accepts scalar rules and returns typed capability requests for operations and evidence beyond its current support. The generated checker, real funded-job proofs, and Arc verification remain pending.

## 2026-11-14 — Anish workstream — RISC Zero plan and team handoff

- The [RISC Zero implementation plan](ZKVM-IMPLEMENTATION.md) specifies a domain-independent compiler, local solver CLI, named file bundles, signed evidence, and byte fixtures.
- The [three-way work split](WORK-SPLIT.md) assigns the engine to Anish and defines separate Arc settlement and agent commerce roles. The other owner assignments are pending.
- Use released `risc0-ethereum` v3.1.0 for selector `0xe71e6620`. This corrects the verifier source pin in the earlier entry. The prior scheduling example is one possible workload. The new acceptance plan exercises two unrelated domains.
- The detailed documents mark proposed defaults and define build gates. Real proof generation, Arc deployment, and the full commerce flow remain pending.

## 2026-11-14 — Architecture and five-day delivery plan

This entry consolidates the current architecture and build sequence. Implementation owners are pending team assignment. Wednesday, November 18 is the internal demo target. The [official submission deadline](https://ubc-hackathon-2026.devpost.com/rules) is Friday, November 20 at noon Central.

### Product and scope

A buyer writes a job, approves deterministic rules and funds a USDC bounty. A worker agent submits a zero-knowledge proof that the exact encrypted result meets those rules. The buyer can verify it while the result is hidden. The worker releases the matching key in the transaction that triggers payment. The API serves existing marketplaces. The demo is two scheduling jobs with the same verification stack and one selected worker per job.

### Authoring and compiler

Grok drafts a typed job or requests clarification about missing constraints and units. A model adapter and typed JSON import provide the same path for other clients. The deterministic lowerer turns the approved schedule into Boolean worker–shift assignments with bounded linear integer rules for cost, coverage, availability, and per-worker shift count. Use cents, checked arithmetic, strict schema validation, and canonical bytes for commitments. Show the resolved rules and input data for buyer approval before funding.

Generate Rust from fixed templates and compile to a RISC-V guest with pinned toolchain and dependencies. Compile by rule shape. Supply thresholds and coefficients as runtime parameters so changes in thresholds alter the plan commitment while the two demo jobs share the image ID. Workers choose their solver offchain. A small backtracking solver is sufficient for the fixture.

### Proof and delivery

Use RISC Zero 3.1.0 Groth16 and the matching upstream Solidity verifier from commit `f6d9398acad07f633819465fecbd85fb72c413dd`, selector `0xe71e6620`. Start on Linux x86-64 with Docker and measure proving time before relying on live proof generation.

The guest checks the exact canonical assignment bytes, then encrypts them with ChaCha20-Poly1305 using a fresh key and nonce per attempt. Bind the encryption to the job context as associated data. The public journal binds chain ID, escrow address, job ID, provider, plan hash, dataset hash, verdict, encrypted envelope digest, and a domain-separated key commitment. The evaluator reconstructs the expected journal with a passing verdict and checks the seal against the funded image ID. Share encoding fixtures between Rust and Solidity. A passing receipt proves feasibility under the approved rules.

### Settlement and interfaces

Use Arc Testnet (chain ID 5042002), test USDC through its six-decimal ERC-20 interface, and an isolated ERC-8183 deployment with zero fees, a policy hook, and a contract evaluator. Select one provider before funding. Funding pins the approved budget, expiry, guest image and input commitments. The provider submits the ciphertext envelope and proof onchain so the buyer can retrieve the exact bytes. Invalid submissions revert and preserve the funded state. After acceptance, the evaluator verifies the matching key and completes payout and key release in one transaction. At expiry, allow a permissionless refund on unsettled jobs. Close settlement at expiry and prevent duplicate payouts or refunds.

Use synthetic fixture data. The release key is visible in public calldata before confirmation and can be exposed by a failed release. Preflight the release and leave a deadline margin. Buyer-only key delivery and multi-solver funded competitions are follow-on work.

Provide endpoints for draft/clarification, compile/manifest, job state, and accepted submission retrieval. Build a thin TypeScript buyer UI with viem and a Rust worker/prover CLI. The worker polls assigned jobs, checks chain and contract allowlists, payout and deadline, solves, proves, submits and releases. Restrict signing to submit and release with zero native value and capped gas. Reconcile chain state before a retry. The buyer authorizes funding.

Circle’s Arc Testnet facilitator advertises x402 `exact`. If the core flow is stable, add a real paid compilation or authoring request. Direct USDC funds the bounty. The optional Grok Bot bounty requires core work by Grok Bot on X, a chat export, and a short README describing its role.

### Demo and verification

Use two shifts and three available workers at 4,000, 5,000 and 6,000 cents per shift, each with a one-shift maximum.

- **Job A** caps cost at 10,000 cents and requires coverage of [1, 1]. The 9,000-cent two-worker schedule passes.
- **Job B** caps cost at 16,000 cents and requires coverage of [2, 1]. Submit a real failing-verdict proof for the two-worker schedule and show that escrow stays funded. Then submit a passing proof for the 15,000-cent three-worker schedule. Show the accepted proof while the result is hidden, then the payout and decrypted schedule.
- Exercise changed journal and image ID, replay across jobs, swapped ciphertext, wrong key, repeated payout, and expiry refunds before and after a valid submission. Use transaction receipts and token movements as evidence.

### Build gates

| Date | Gate | Evidence |
| --- | --- | --- |
| Nov 14 | Proof path | Deploy the pinned verifier on Arc. Verify an upstream test receipt and a fresh Rust guest receipt. Confirm modified journal or image ID fails. Record proving time and gas. |
| Nov 15 | Compiler and encryption | Validate the compiler and canonical encoding. Show both threshold sets use the same image and prove an authenticated envelope. |
| Nov 16 | Settlement | Show that rejected proofs and wrong keys preserve funds, valid release triggers payout and decryption, and expiry refunds. |
| Nov 17 | Authoring and worker | Run Grok draft through approval and funding. Have the worker prove and submit, and show the buyer the chain-backed result. |
| Nov 18 | Rehearsal | Re-run fresh jobs, record transaction links and demo video, and document setup, decision loop and signer limits. Use pre-generated real receipts if proving exceeds the live demo window. |

Read-only Arc RPC checks confirmed the chain ID, USDC ERC-20 decimals, and bytecode at Circle’s published ERC-8183 address. Real proof generation, Arc proof verification, and the complete settlement path are pending build gates.

## 2026-11-14 — Anish’s project context

The [architecture context](../anish/AGENTS.md) records the initial technical decisions. The first technical checkpoint is to verify an upstream RISC Zero receipt and a fresh Rust guest receipt on Arc Testnet. Record ownership and progress here as the team agrees on them.
