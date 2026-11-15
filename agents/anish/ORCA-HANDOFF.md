# Orca handoff — UBC-26 engine integration

Continue in `/Users/anishnarang/.codex/worktrees/engine-commerce/UBC-26-engine`, branch `codex/engine-commerce`.

## Current state, 2026-11-15 14:00 -05:00

The local integration is implemented and verified, **not live-settlement or production-security approved**. The user subsequently authorized committing all integration work and pushing `codex/engine-commerce`. This handoff is included in that publication checkpoint, based on prior HEAD `4fc21457b5161f27dde0053851aef08344d8f581`; use Git history for its final commit ID and remote status. The [verification evidence](reports/arc-integration-verification.json) records the pre-commit test snapshot; its uncommitted/staged counts are historical. See also [dependency triage](reports/integration-dependency-triage.json).

Imported source into the working tree, not merge commits:
- Neil commerce `8584b045f18996667419b8c6d7f965717b099f5e`.
- Nick contracts `80c8a4af68f0cf00e4177c98e9c435d869716edd`.
- Verifier remains `ff30da77ba4afdd496290ebebedb205348b15d83`, RISC Zero/r0vm 3.1.0, selector `0xe71e6620`.

## Completed integration

- CI `setAAD` fix; normal SDK tests now execute its Node fixture.
- Real Arc reader/ABIs, coherent block-pinned snapshots and receipt-block API funding linkage. Indexer checks actual RPC chain before cursor advancement.
- Explicit chain modes and real-engine guards before database/listening. Durable genuine CLI compile provenance rejects old simulated/unidentified manifests, including cache/idempotency replays after switching modes. Migration `006_compile_provenance.sql` leaves legacy entries untrusted; revise, approve, and recompile through the real CLI.
- Selection uses chain time and a minimum 1,200-second budget or deployed margin plus 120 seconds, whichever is larger. Workers enforce separate proving/submit/release reserves. These floors are not latency guarantees.
- Concrete Arc settlement port and capability-gated signer policy; CLI is read-only for funded work. Hash-only broadcasts and separate receipts; no automatic resend for pending/uncertain outcomes. Private attempt lock/state, full resume artifact/context/revision checks, exact engine/SDK recovery, durable key-disclosure and payout-confirmation state.
- Broadcast requires externally approved runtime/implementation/verifier pins, complete initialization/role history with no surviving privileged holders, zero fees, and whitelist checks. Fresh job/deadline checks occur after lengthy verification and signer awaits. Real keys never enter simulation or gas estimation. Bounded RPC checks cannot be atomic with signing/inclusion.
- Root pinned ignore rules prevent local dependencies, `.env`, contract outputs/cache/broadcasts and settings from entering Git. Current guides and `.env.example` match implemented exports and environment names.

## Verification

- Commerce: **1,357 passed** (13 Node fixture, 315 SDK, 755 API, 274 worker); all three typechecks passed. Eight tests run the funded lifecycle through the concrete port with mocked RPC/engine; they are not cryptographic proof evidence.
- Actual Rust-engine API integration: **15 passed**, including real compile provenance, restart/cache reuse and selection. Saved Grok replies only; no model calls.
- Full engine replay: **51 Rust, 38 Node, 11 TypeScript tests**, typecheck, 10,000 seeded cases, 341 host candidates, 180 recorded outcomes and 1,023 authoring candidate checks. All **12 real receipts**, 12 actual archived guest executions and six fresh recoveries (nine exact files) passed. Known 39 non-draft fidelity and 13 source-quote defects remain explicit.
- Actual local Solidity regression: **18 passed**, covering real verifier, proof/ciphertext/replay rejection, payout, wrong/duplicate release, exact recovery and Funded/Submitted expiry refunds. Command: `node engine/tests/verify-settlement.mjs --private-root /tmp/ubc26-integration-new-proofs`.
- That test deliberately installs the proxy at the synthetic receipt escrow and impersonates its provider in disposable loopback Anvil with a mock ERC20. It is **not** fresh/live funded-context or full real service/prover/signer evidence. Without `--private-root`, 16 checks run and two key-dependent checks explicitly skip.
- Contract examples: 13 tests and typecheck; four ABI copies match; seven shell scripts pass syntax checks. Foundry suite was not rerun (no forge installed).
- Private-key scan: 12 distinct private keys, zero matches in changed/untracked files. Protected Rust/lock/receipt/package files unchanged. No new inference, proof generation, live transaction or deployment.

Fresh replay scratch: `/tmp/ubc26-arc-integration-replay-2`. Prover: `/tmp/ubc26-rz/bin/r0vm`; engine/target cache: `/tmp/ubc26-rz/target`; pinned verifier checkout: `/tmp/ubc26-risc0-ethereum-v310`. An initial replay typecheck failed because commerce widened manifest metadata to unknown; the evaluation-only `EvaluationManifest` fix passed the complete rerun. Do not confuse the earlier failed scratch with the completed rerun.

## Next gates

1. Review this integration checkpoint on `codex/engine-commerce`. Commit/push is authorized for this checkpoint only; no merge to main, PR creation or live-chain action is implied.
2. **Nick:** fix the existing broadcaster-only `_checkFrozen` script. A manifest `frozen:true` cannot prove all administrators are gone. Supply complete initialization/role/upgrade history, approved runtime/implementation pins and independent zero-fee freeze evidence. Current recorded core is whitelisted and **unfrozen**, so the worker correctly blocks broadcasts.
3. **Buyer/provider:** approve the actual reconciliation revision and choose a real provider; authorize funding with a measured deadline. Existing synthetic receipts cannot settle a new real job. Obtain actual funded terms and generate a fresh proof bound to that context.
4. **Neil:** review/adopt the integrated SDK/API/worker changes, apply migration 006, and configure the real engine, persistent private packages/attempts, actual chain settings and deployment policy. Wire and test an externally managed safe signer capability; there is intentionally no ready-to-use funded CLI broadcaster. Verify buyer-facing approval, funding linkage, accepted-envelope retrieval and exact recovery against one actual funded job. Use the Linux/WSL prover host to measure realistic proving/deadline budgets. These are service/demo readiness requirements, not reasons to block unrelated local development.
5. **Joint gate (Nick, Neil, Anish and buyer):** separately authorize and verify live submit/release/payment/refund and buyer recovery. Anish generates a fresh proof only after actual funded terms and provider are confirmed. CLI broadcast remains disabled. A real key can become public even if release fails.
6. **Anish:** resolve controlled dependency remediation before production-security claims. Do not blindly update the pinned proof stack or change eager lookup semantics. Seven advisory findings remain triaged, not remediated; model fidelity/quote limitations still require buyer review.

## Operating rules and agents

- No live-chain transaction, deployment, irreversible freeze, commit or push without user authorization. Do not edit Nick's or Neil's status files. Preserve every proof/toolchain pin and private key boundary.
- Use `agents/anish/status.md` and the shared plan for dated checkpoints; keep older entries as history.
- Five Orca GPT-6 Sol workers were attempted, but the active ChatGPT account rejected that model before execution. All are stopped/released in Run `run_7343f1da3516`. Available native subagents completed parallel implementation/reviews; their model selector was not exposed. Do not claim those workers ran Sol.
- Do not change or copy credentials. Prior authentication prose is historical: this session's provider explicitly reported a ChatGPT account. Recheck account availability without exposing secrets if another model is needed.
- Release keys remain only in private `/tmp/ubc26-integration-new-proofs`; never print/copy them to public artifacts. Local tests suppress exception details that might contain release calldata.
