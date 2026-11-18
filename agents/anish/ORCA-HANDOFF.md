# Orca handoff — UBC-26 engine integration

## 2026-11-18 — Anish — Restart handoff

Continue from current remote main, not the old engine-commerce snapshot. Use an isolated checkout for further changes. Engine `adda3a3`, Neil `8584b04`, and Nick `57c387f` are already main ancestors. PR #7 merged the combined settlement work. PR #5 merged Neil's later commerce and web work. PRs #4 and #6 are closed.

The [resume audit](reports/core-sprint-resume-2026-11-18.json) records a clean checkout of main `2e04451`: four commerce typechecks, 2,297 tests, Rust format/Clippy, 51 host tests and wire fixtures passed. Three prepared-guest tests stayed ignored. A fresh read-only Arc replay recovered the published job-7 file with the SDK and confirmed the exact 10,000-unit payout. Historical engine recovery and oracle evidence remain in the [live report](reports/open-claim-arc-live-acceptance-2026-11-16.md).

Do not repeat completed merges, deployment, freeze, funding, claim or release. The prepared open-claim run paid 0.01 USDC. It is not the original plan's exact 1-USDC selected-provider run or fresh user-problem authoring. A further live run needs exact approved inputs, terms and protected signing authority. This restart performed no wallet access or chain writes.

The existing [operator guide](../../docs/overnight/open-claim-live-operator.md) covers the accepted open-claim path. The [core sprint runbook](../../docs/core-sprint.md) retains the selected-provider tooling. Preserve private state, signer guards and one-prover ownership. `commerce/web` exists, but no new browser acceptance is claimed here. PR #8 is a separate hosted-backend workstream.

## Historical snapshot — 2026-11-15 — Anish — Sprint handoff

The remaining handoff text preserves earlier observations. Pending merges, missing live acceptance, and absent UI statements below do not describe the November 18 state.

The user authorized sprint continuation, delegation, tested checkpoint commits/pushes, and normal merge integration into main. The older publication-only limits below are historical. Follow narrower limits in the active task. No live spending authorization or funded exchange exists.

Actual merge ancestry includes Neil `8584b04`, Nick `57c387f`, and engine `adda3a3` at integration checkpoint `fff74ce`. Consolidated [PR #6](https://github.com/anishnarang9/UBC-26/pull/6) is open. This is not a claim that main already contains the sprint.

Nick corrected the all-holder defect and froze the existing core. The historical [read-only verification](reports/core-sprint-deployment-2026-11-15.json) passed 60 checks at block 72478546. A later read-only refresh passed 60 checks at block 72490082 and hash `0x58199c922279c535fcba994ef3e0a248a6f9435aa6e626479d68a3fb5b959093`, with 81 reads paced at 2 seconds and 0 retries. All four runtimes match exact source/build inputs, including metadata and approved immutables. Do not repeat the freeze. Old unfrozen reports remain unchanged as historical evidence. Neither check authorizes spending.

The [operator runbook](../../docs/core-sprint.md#separate-operator-runner) documents seven commands and exact file/authorization shapes. The runner requires clean relevant source, pinned native executable/wrappers, and an explicit environment. It fails closed on WSL without changing existing API WSL support. Keep the general funded CLI read-only. Independent oracle and slow-suite reviews passed. The reviewed suite source is published at `9458a81`. Final rehearsal and final-head CI remain pending.

The [previous local rehearsal](reports/core-sprint-local-2026-11-15.json) is `partial`. On source `9458a81` the lifecycle recorded a 583188 ms proof and the process exited 1. The report retains an earlier 592.4-second attempt. This is not a clean pass, live Arc, live Grok, published-suite validation, or a later Meridian rehearsal. Earlier [commerce CI](https://github.com/anishnarang9/UBC-26/actions/runs/43774141501) and [core-fast CI](https://github.com/anishnarang9/UBC-26/actions/runs/43774141450) were green at `ee64e755ac795eca662bba3f327981ab4af9a920` and do not cover `9458a81`. Final-head CI remains pending. Permanent provider maximum gas reservations receive no finality discount. Stale account locks require manual review, never automatic deletion.

The prior [synthetic workload](../../docs/core-sprint-input/README.md) and [native authoring record](../../docs/core-sprint-input/authoring.json) are the legacy package. Independent checks found no acceptance disagreements across 58 oracle cases and 289 additional engine differential cases. These are finite checks, not a complete correctness proof. The author received no oracle or candidate answers. This is not live Grok evidence. The current local workload is [Meridian](../../docs/fresh-exchange-input/README.md). Its rehearsal, guest report, and indexer note are in the [core sprint runbook](../../docs/core-sprint.md#local-first-meridian-rehearsal). No fresh full pass exists yet.

No real wallet access, spending, or funded live acceptance is authorized yet. The parent owns approval gates, `status.md`, and `PLAN.md` updates. Next: finish the local Meridian checks and record that fresh report and final-head CI, then obtain approved identities, terms, and protected signing access before any live phase. A new funded context requires a fresh proof.

Use the [core sprint runbook](../../docs/core-sprint.md) for exact funding order, decimal units, key-disclosure limits, dependency caveats, and pending commands. Do not claim a web UI exists. Do not claim production security or a completed live exchange.

## Historical snapshot — 2026-11-15 14:00 -05:00 — Anish

Everything below records the earlier checkpoint. Its publication-only limits, imported-source state, and unfrozen blocker no longer describe current sprint authority or deployment state.

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
- Actual local Solidity regression: **18 passed**, covering real verifier, proof/ciphertext/replay rejection, payout, wrong/duplicate release, exact recovery and Funded/Submitted expiry refunds. Command shape: `node engine/tests/verify-settlement.mjs --private-root /private/operator/archived-proofs`. This is a nonsecret path placeholder.
- That test deliberately installs the proxy at the synthetic receipt escrow and impersonates its provider in disposable loopback Anvil with a mock ERC20. It is **not** fresh/live funded-context or full real service/prover/signer evidence. Without `--private-root`, 16 checks run and two key-dependent checks explicitly skip.
- Contract examples: 13 tests and typecheck; four ABI copies match; seven shell scripts pass syntax checks. Foundry suite was not rerun (no forge installed).
- Private-key scan: 12 distinct private keys, zero matches in changed/untracked files. Protected Rust/lock/receipt/package files unchanged. No new inference, proof generation, live transaction or deployment.

The historical replay used private scratch, prover, build-cache, and pinned-verifier paths. Obtain those locations through the protected operator channel. An initial replay typecheck failed because commerce widened manifest metadata to unknown. The evaluation-only `EvaluationManifest` fix passed the complete rerun. Do not confuse the earlier failed scratch with the completed rerun.

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
- Release keys remain only in the protected private proof directory. Never print or copy them to public artifacts. Local tests suppress exception details that might contain release calldata.
