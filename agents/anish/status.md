# anish status

Follow the [shared status rules](../AGENTS.md#status-and-handoffs). Add a heading with date, time, and UTC offset for each new entry. Keep the newest entry first.

## 2026-11-14 18:15 -05:00 — Anish

- Branch codex/anish-engine. Added a machine-readable capability catalog and normalized approval preview. Revalidating the preview reproduces both plan commitments.
- Added exact file hash and byte size rules for opaque, text, JSON, and authenticated evidence payloads. All 40 workspace tests and Clippy passed. The CLI catalog matches the published JSON.
- The signed-text proof and independent clean build continue. Actual funded Arc terms become necessary for the November 16 integration gate. The user can provide them on November 15.

## 2026-11-14 18:11 -05:00 — Anish

- Branch codex/anish-engine. The compiler now emits allowlisted Rust nodes from normalized operations and indices. The guest checks emitted nodes against the approved structure. The package exports its source tree and lockfile.
- All six evidence profiles passed actual RISC Zero guest execution. A direct guest test rejected an invalid signature for each profile. The suite also checks valid recovery bytes with a high-S EIP-712 signature.
- Cache checks showed source and threshold cache hits, stable image IDs, changed rules hashes, and recovery from a damaged cache entry. Default workspace tests and Clippy passed.
- A clean isolated rebuild and the signed-text Groth16 proof are running. A concurrent Docker build exhausted memory during the earlier failing reconciliation proof. Its retry will run sequentially.

## 2026-11-14 18:02 -05:00 — Anish

- Branch codex/anish-engine. Added signed evidence declarations, committed signer slots, artifact and context bindings, and evidence projection into rules. The CLI passes evidence to the guest and supports guest execution without proving.
- All 35 workspace tests and Clippy passed. Independent Node signatures check Ed25519, EIP-712, and compact JWS Ed25519, legacy EdDSA, ES256, and RS256. Host tests reject changed signers, artifacts, headers, and contexts.
- Pinned guest validation for all six evidence profiles is running. The record guest produced a passing proof. Its failing receipt is still running. Input version metadata preserves proving compatibility for earlier checker packages.

## 2026-11-14 17:55 -05:00 — Anish

- Branch codex/anish-engine. Added bounded record collections, sum, count, all, any, uniqueness, and exact lookup. Published a multi-file reconciliation fixture.
- Workspace tests and Clippy passed. Host evaluation returns 1 for the valid ledger reconciliation and 0 for the changed amount. Record tests cover duplicate and missing matches, 257-record rejection, empty quantifiers, repeated parameters, and checked overflow.
- Two subagents stopped at the account usage limit before edits. Root continued implementation. Real collection guest proofs and signed evidence remain in progress.

## 2026-11-14 16:07 -05:00 — Anish

- Branch `codex/anish-engine`. Published the real [verdict-0 receipt](../../engine/fixtures/scalar-proof-fail-v1.json). It shares the passing receipt's context and image ID.
- The verdict-0 proof took 134.142 seconds and 252,816 user cycles. The released Solidity verifier accepted its original journal on a local EVM and rejected the journal after the verdict changed to 1. The Node checker reconstructed both journal byte strings from the submission fields.
- Nick can use the fixture pair for local settlement tests. The next engine work extends the checker to record collections and signed evidence. Arc verification still needs a deployed evaluator and a receipt for the actual funded job context.

## 2026-11-14 16:05 -05:00 — Anish

- Branch `codex/anish-engine`. The expense report checker produced a real [passing Groth16 receipt](../../engine/fixtures/scalar-proof-pass-v1.json) with a 234-byte journal for a synthetic job context.
- The proof took 138.264 seconds and 252,709 user cycles. The low-memory Docker retry succeeded. The released verifier accepted the receipt on a local EVM and rejected changes to the image ID, journal, seal, and verdict. The direct call estimated 257,760 gas. Decryption recovered the original file byte for byte.
- Nick can test the full journal layout with this receipt. Its synthetic context cannot match an independently funded Arc job. The verdict-0 receipt is in progress.

## 2026-11-14 16:04 -05:00 — Anish

- Branch `codex/anish-engine`. Added `engine eval` for Neil's buyer preview. It uses the same scalar evaluator as the guest and returns a numeric verdict without a receipt.
- All 27 workspace tests and Clippy passed. The low-memory proof retry reached Groth16 compression.

## 2026-11-14 16:03 -05:00 — Anish

- Branch `codex/anish-engine`. Added a scalar checker guest and the compile, prove, and decrypt commands. Published the authoring schema and CLI input and output formats for Neil.
- All 26 workspace tests passed. Clippy and schema validation passed. Two compiled packages with different thresholds produced the same image ID and guest digest, with distinct rules hashes.
- The funded-job test reached Groth16 compression. Docker reported an out-of-memory kill at its current RAM limit. A retry with fewer prover threads is running. Arc, collection rules, and signed evidence remain pending.

## 2026-11-14 15:47 -05:00 — Anish

- Branch `codex/anish-engine`. Published a fresh [Groth16 smoke receipt](../../engine/fixtures/groth16-smoke-v1.json) for the digest-pinned Docker guest.
- Proving took 106.922 seconds on an arm64 Mac with the amd64 CPU prover in Docker. The guest ran for 2,792 user cycles. Rust and the released Solidity verifier accepted the receipt. The local EVM rejected changes to the image ID, journal, and seal. It estimated 257,760 gas for the direct verifier call.
- The next engine step is to evaluate validated rules in the guest and commit the full job journal. The settlement owner can use the smoke receipt for Arc verifier checks.

## 2026-11-14 15:46 -05:00 — Anish

- Branch `codex/anish-engine`. Added the [RISC Zero proof smoke check](../../engine/proof-smoke/README.md) with locked dependencies and pinned Docker images.
- The host-built guest produced a real Groth16 receipt in 104.678 seconds and ran for 2,792 user cycles. The released verifier accepted the receipt on a local EVM and rejected changes to the journal, image ID, and seal. The direct verifier call estimated 257,772 gas on the local EVM.
- The pinned Docker guest passed execution and produced a different image ID. Proving for that image is in progress. Arc verification belongs to the settlement workstream.

## 2026-11-14 15:42 -05:00 — Anish

- Branch `codex/anish-engine`. Added the Rust wire protocol, shared synthetic fixture, and first scalar plan validator. The validator emits canonical JSON and commitment hashes.
- All 15 Rust tests passed. Clippy passed. The protocol built for generic RISC-V, and Node reproduced the fixture and rejected decryption with a different job ID.
- The generated checker and funded-job CLI still need guest integration. The separate RISC Zero proof smoke test is in progress.

## 2026-11-14 15:25 -05:00 — Anish

- Branch `main`. Added shared rules for checkpoint commits, pushes, and status entries. Updated all three status file instructions.
- Checked the diff for whitespace errors and checked that the status links resolve.
- Next action is the existing Groth16 proof build gate. Settlement and commerce owner assignments are pending.

## 2026-11-14 — Anish workstream

- Prepared the [RISC Zero implementation plan](../current%20plan/ZKVM-IMPLEMENTATION.md) and [three-way work split](../current%20plan/WORK-SPLIT.md).
- Next build gate is a real RISC Zero 3.1.0 Groth16 receipt. Arc deployment and the settlement and commerce owner assignments are pending.
