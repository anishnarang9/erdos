# anish status

Follow the [shared status rules](../AGENTS.md#status-and-handoffs). Add a heading with date, time, and UTC offset for each new entry. Keep the newest entry first.

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
