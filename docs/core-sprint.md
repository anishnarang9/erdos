# Core engine and funded-settlement sprint

## 2026-11-15 — Anish — Scope and authority

This runbook describes the integrated prototype, not a completed live exchange or production-security approval.

The user authorized sprint continuation, delegation, checkpoint commits/pushes, and normal merge integration into main. Active task limits still apply. No real wallet access, spending, or funded live acceptance is authorized yet.

Branch `codex/engine-commerce` contains actual merge ancestry for engine `adda3a3`, Neil `8584b04`, and Nick `57c387f`. Integration checkpoint `fff74ce` includes both commerce and settlement histories. [PR #6](https://github.com/anishnarang9/UBC-26/pull/6) is open. Do not infer that main already contains this work.

## Product and proof boundary

The [Rust engine](../engine/README.md) compiles buyer-approved typed plans into checker guests. The [catalog](../engine/capabilities-v1.json) supports:

- Typed JSON, text, and opaque files.
- Bounded record collections, aggregates, unique-key joins, and quantified predicates.
- Checked i64 arithmetic and Boolean rules.
- Approved Ed25519, EIP-712, and JWS evidence profiles.

The TypeScript [API, SDK, and worker](../commerce/README.md) connect approval, compilation, quotes, chain reads, and proof preparation. A buyer web UI remains planned. No `commerce/web` implementation exists.

A passing receipt proves satisfaction of the approved predicates for the bound bytes and context. It does not prove unexpressed intent, optimality, or external truth. A signature authenticates an issuer's claim, not its truth.

The design is not `LinearPlan` or scheduling-only. It does not use Circle's shared escrow, separate `attest`, on-chain RFQ, or score-based admission. File-hash predicates remain available when explicitly approved. A hardcoded known answer is not a required admission rule.

## Deployment evidence, not spending permission

The isolated core is frozen. Nick corrected the scripts to check every discovered role holder, not only the broadcaster. Do not repeat the completed freeze.

The independent [deployment report](../agents/anish/reports/core-sprint-deployment-2026-11-15.json) remains the historical detailed record at block **72478546**. A later sanitized [refresh summary](../agents/anish/reports/core-sprint-deployment-refresh-2026-11-15.json) passed the same **60 checks** at block **72490082**, block hash `0x58199c922279c535fcba994ef3e0a248a6f9435aa6e626479d68a3fb5b959093`, using 81 reads paced at 2 seconds and 0 retries. That summary records source `ee64e755ac795eca662bba3f327981ab4af9a920` and does not authorize spending. Both checks found:

- Arc Testnet chain ID 5042002.
- Zero fees, the intended whitelist, and complete role/initialization/upgrade history.
- No remaining privileged holders.
- Exact source/build matches for all four deployed runtimes, including metadata and approved immutable values.
- Read-only RPC methods only. No funded-job, proof, payout, or refund acceptance. Neither check authorizes spending.

Use the [deployment manifest](../contracts/deployments/arc-testnet.json) and [contract handoff](../contracts/HANDOFF.md) for addresses and ABI details.

[`parseDeploymentPolicy`](../commerce/worker/src/deployment-policy.ts) performs no I/O. It returns a candidate with `authorization: "not-authorized"`. Manifest parsing, a frozen flag, and a successful read-only preflight grant no signing authority.

History starts at proxy creation block **72393888**, not the freeze block. Before any authorized broadcast, recheck approved pins, chain state, complete history, job identity, and remaining time. RPC/archive truth remains a trust assumption. Checks cannot be atomic with signing or inclusion.

## Implemented modules and review limits

| Component | Current boundary |
| --- | --- |
| [Sprint state](../commerce/worker/src/sprint-state.ts) | Strict schemas, private atomic state, owned locks, immutable selected terms, phase/approval guards. State validation is not receipt authentication. |
| [Provider broadcaster](../commerce/worker/src/local-broadcaster.ts) | Local signing for exact authorized submit/release calls, zero value, capped gas/fees and durable budget reservations. No blind resend. |
| [Operator keystore](../commerce/worker/src/operator-keystore.ts) | Encrypted V3 keystore loading with expected-address and private-path checks. Password input uses a protected descriptor or secure-input boundary. |
| [Poster funding](../commerce/worker/src/poster-funding.ts) | Separate buyer boundary restricted to four funding calls and a 1-USDC sprint bounty. Exact selected terms and private durable journal. |
| [Funded lifecycle](../commerce/worker/src/funded.ts) | `runFunded` supports `stopAfterProof` and a bounded proving timeout. Proof preparation does not enable CLI broadcast. |
| [Buyer recovery](../commerce/worker/src/buyer-recovery.ts) | Chain-authenticated SDK and engine recovery, with exact-file comparison and a separate semantic oracle. The recorded lifecycle assertions passed, then the suite process exited 1. Live acceptance remains pending. |
| [Separate operator runner](../commerce/worker/src/sprint-runner.ts) | Seven commands, exact approval bindings, source checks, pinned native engine, and separate Poster/provider authorization. Independent review passed. The suite source is published at `9458a81`. Live spending remains unauthorized. |

These are module boundaries, not evidence of a completed service/prover/signer exchange. Do not use an arbitrary unlocked RPC account as a signer.

Keep private keys, release keys, signed transaction bytes, passwords, and plaintext outside public logs, prompts, reports, and source control. Pending or uncertain writes require reconciliation. Do not delete locks or restore journals to enable a retry.

Provider maximum gas reservations remain permanently charged, even after receipt reconciliation. There is no finality discount. Stale account locks require manual review, not automatic deletion.

## Exact funding and time rules

The Poster is the buyer. The Solver is the provider. Their signing authorities are separate.

1. The Poster calls `core.createJob(provider, hook, expiredAt, description, hook)`.
2. The Poster calls `core.setBudget(jobId, amount, "0x")`.
3. The Poster calls `USDC.approve(core, amount)` for the exact budget.
4. The Poster calls `core.fund(jobId, abi.encode(imageId, rulesHash, referenceHash))`.

Only the client (Poster) can call `setBudget` in the patched core. Derive the actual job ID from authenticated creation evidence. The `fund` payload is exactly 96 bytes.

The [API selection](../commerce/api/src/market.ts) calculates an absolute `expiredAt` from pinned chain time. Preserve that exact value throughout funding, linking, proving, and recovery. Never silently replace it with a fresh relative deadline.

- ERC-20 bounty and allowance amounts use **six decimals**. `1000000` units equal 1 test USDC.
- Native gas amounts use **18 decimals**. Never mix these with bounty units.
- `createJob` requires expiry strictly more than 300 seconds ahead.
- `fund` requires at least the deployed 600-second margin.
- API selection requires at least 1,200 seconds, or the deployed margin plus 120 seconds, whichever is larger.
- Submit and release require `block.timestamp < expiry`.
- Refund from Funded or Submitted requires `block.timestamp >= expiry`.

These floors do not guarantee enough proving time. Measure compilation/proving, funding, submission, release, and operational overhead. Resource limits are hard bounds, not a universal cost or latency model.

## Proposed new workload and independent oracle

The public [synthetic input package](core-sprint-input/README.md) allocates tasks and chooses dispatches. It tests semantic feasibility, not equality to one answer. Buyer approval remains pending.

The separate author received only the request, declared outputs, and reference data. Candidate answers, oracle code, and expected verdicts stayed outside its inputs. The [authoring record](core-sprint-input/authoring.json) identifies native OpenCode authoring. It is not Grok or autonomous app-authoring evidence.

Parent verification recorded two feasible solutions, 14 normalized rules, and 77 expression nodes. Independent checks found no acceptance disagreements across 58 oracle cases and 289 additional engine differential cases. Finite agreement is not a correctness proof or buyer approval. Rejecting malformed input and returning verdict 0 are distinct outcomes.

The buyer must approve the exact request, reference bytes, output declarations, and normalized predicates before funding. Obtain actual public buyer/provider identities and exact terms separately. Existing synthetic-context receipts cannot settle a newly funded context.

## Checked read-only commands

From `commerce/worker`, the existing CLI supports these commands:

```sh
pnpm exec tsx src/cli.ts funded inspect --chain-job <id> --rpc <url> --core <address> --hook <address> --usdc <address> --provider <address>
pnpm exec tsx src/cli.ts funded preflight --chain-job <id> --rpc <url> --core <address> --hook <address> --usdc <address> --provider <address> --proof /private/attempt/proof.json
```

`funded prepare --proof` is also read-only and does not run a prover. `src/cli.ts funded` rejects submit, release, run, and broadcast actions. Keep that boundary intact. A successful preflight does not approve a deployment or wallet use.

### Separate operator runner

The [parser](../commerce/worker/src/sprint-cli.ts) accepts exactly `inspect`, `prepare`, `check-deployment`, `fund`, `run`, `recover`, and `verify`. Every command requires `--input`, `--config`, and `--run-dir`. This is operator tooling, not buyer UI or live spending approval.

`inspect` reads local state. `check-deployment` performs read-only RPC checks. `prepare` creates API records but never funds. `run` first prepares a fresh context-bound proof without a wallet. It then requests proof-bound authorization before signing. `recover` and `verify` both authenticate chain evidence, decrypt through SDK and engine, compare exact files, and run the oracle. Neither uses a wallet.

Run from `commerce/worker`. These paths are nonsecret placeholders, not installed tools or approved identities:

```sh
pnpm exec tsx src/sprint-cli.ts inspect --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run
pnpm exec tsx src/sprint-cli.ts check-deployment --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run
pnpm exec tsx src/sprint-cli.ts prepare --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run --plan /private/operator/plan.json --buyer-token-fd 3 3</private/operator/buyer-token
```

First review `preview.json`, the normalized revision, and the returned `approvalRequired` object. Save that exact object as the rules approval only after buyer review. Repeat `prepare` with the same `--plan`, plus `--approval /private/operator/rules-approval.json` and a fresh token descriptor. This approves and compiles without funding. Omit `--plan` only to request API authoring. Its label is `api-draft-provenance-unverified`, not proof of live Grok. Typed imports use `typed-import`.

An external provider creates the quote through the supported API. Repeat the approved `prepare` command with `--quote <quote-id>` to select it. There is no `--create-quote` flag. Selection preserves the exact absolute expiry.

```sh
pnpm exec tsx src/sprint-cli.ts prepare --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run --plan /private/operator/plan.json --approval /private/operator/rules-approval.json --buyer-token-fd 3 3</private/operator/buyer-token
pnpm exec tsx src/sprint-cli.ts prepare --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run --plan /private/operator/plan.json --approval /private/operator/rules-approval.json --quote approved-quote-id --buyer-token-fd 3 3</private/operator/buyer-token
```

A fresh local Meridian run must record proof acceptance, exact payout, dual recovery, oracle agreement, and process exit 0 before any new live workload. These write commands still need a later approval that names the exact public accounts, protected keystores, and spending caps. Local synthetic accounts and a local exit 0 do not create that approval.

Only after separate explicit approval may an operator use these write commands:

```sh
pnpm exec tsx src/sprint-cli.ts fund --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run --authorization /private/operator/fund-authorization.json --keystore /private/operator/buyer.json --password-fd 3 --buyer-token-fd 4 3</private/operator/buyer-password 4</private/operator/buyer-token
pnpm exec tsx src/sprint-cli.ts run --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run
pnpm exec tsx src/sprint-cli.ts run --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run --authorization /private/operator/run-authorization.json --keystore /private/operator/provider.json --password-fd 3 3</private/operator/provider-password
pnpm exec tsx src/sprint-cli.ts recover --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run
pnpm exec tsx src/sprint-cli.ts verify --input /private/operator/input.json --config /private/operator/config.json --run-dir /private/operator/run
```

Passwords and tokens enter through distinct protected descriptors, never argv. Use operator-owned private files and directories. Directories require mode `0700`. Secret files require mode `0600`. Avoid symlinks and writable ancestors. Reopen descriptors for each invocation.

### Operator file shapes

These JSON templates contain deliberately invalid public placeholders. Replace each placeholder with independently reviewed values. Do not treat example addresses, hashes, budgets, or paths as approval.

`input.json` paths resolve relative to that file. Keep candidate and oracle data outside authoring inputs:

```json
{
  "version": 1,
  "requestFile": "request.md",
  "referenceDir": "reference",
  "outputs": [{"name": "allocations.json", "format": "json"}, {"name": "dispatch.json", "format": "json"}],
  "candidateDir": "candidate",
  "oracle": {"kind": "operator-script", "scriptFile": "oracle.py"},
  "expirySeconds": 7200,
  "budgetUnits": "1000000",
  "buyer": "<approved-public-buyer-address>",
  "provider": "<approved-public-provider-address>"
}
```

Alternatively, the oracle shape is `{"kind":"exact-files","expectedDir":"expected"}`. A reviewed Python oracle runs trusted code, not sandboxed code.

`config.json` requires all fields below. Deployment and journal paths resolve relative to the config file:

```json
{
  "version": 1,
  "api": "http://127.0.0.1:3000",
  "rpc": "https://rpc.example.invalid",
  "sourceCommit": "<reviewed-40-hex-HEAD>",
  "deploymentManifest": "deployment.json",
  "approvedDeploymentFile": "approved-deployment.json",
  "journalRoot": "journals",
  "proveBudgetSec": 1800,
  "submitBudgetSec": 120,
  "releaseMarginSec": 120,
  "oracleTimeoutMs": 30000,
  "engine": {
    "mode": "native",
    "executable": "/opt/reviewed-tools/engine",
    "executableSha256": "<reviewed-64-hex-binary-digest>",
    "wrapperSha256": "<reviewed-64-hex-wrapper-digest>",
    "environment": {"PATH": "/usr/bin:/bin", "RISC0_SERVER_PATH": "/opt/reviewed-tools/r0vm"}
  }
}
```

The template `expirySeconds` of `7200` and `proveBudgetSec` of `1800` are the parent-approved Meridian local-fixture allowances. They follow guest size and earlier measurements. Legacy local fixtures stay at a 900-second prove budget and a 3600-second expiry. Neither pair is an SLA, and neither changes production signing or expiry guards.

The runner requires the exact HEAD and clean relevant tracked and untracked source. Documentation outside those source roots does not bypass that check. No environment or CLI bypass exists.

The native executable digest and wrapper digest require independent review. `sprintEngineWrapperDigest()` returns a candidate, not approval. The wrapper digest binds both engine wrappers and `/usr/bin/env`. The engine receives only the explicit clean environment. Configure any required allowed Docker/RISC0 settings there.

The operator runner supports native POSIX only. WSL fails closed. This restriction does not remove the existing API/worker WSL engine support.

The approved deployment file has exactly `version`, `chainId`, `core`, `hook`, `usdc`, and `policy`. Policy contains `deploymentBlock` as a decimal string, `implementation`, `verifier`, `verifierVersion`, `verifierSelector`, and `runtimeHashes`. Runtime hashes contain `core`, `hook`, `implementation`, and `verifier`. Review these against the manifest and independent deployment evidence.

Rules approval has exactly `version`, `runId`, `inputDigest`, `sourceCommit`, `revisionHash`, `rulesHash`, and `referenceHash`. Use the returned `approvalRequired` values unchanged.

Both authorization files use the exact [authorization schema](../commerce/worker/src/sprint-authorization.ts). Copy the returned `fundingApprovalBindings` or `authorizationBindings`, then explicitly approve these additional fields:

- `allowedCalls`: `["createJob","setBudget","approve","fund"]` for `fund`, or `["submit","release"]` for `run`.
- `maxGas`, `maxFeePerGas`, `maxPriorityFeePerGas`: decimal strings with reviewed gas/fee caps.
- `nativeGasBudgetWei`: exactly `"1000000000000000000"`, split equally between buyer and provider.
- `validUntil`: an approved decimal timestamp, no later than the selected expiry.
- `dataSafeForPublication` and `keyDisclosureAcknowledged`: both explicitly `true`.

Bindings include exact revision/input/source/deployment/selection digests, identities, contracts, expiry, image, rules, references, and the 1-USDC budget. `fund` requires `proofDigest: null`. `run` requires the exact generated proof-file digest. One authorization cannot authorize the other action.

### Recorded local rehearsal

The [local report](../agents/anish/reports/core-sprint-local-2026-11-15.json) is forkless Arc Anvil only. Its `status` is `partial`, its `lifecycleStatus` is `passed`, and `processResult.exitCode` is 1. On source `9458a81` the lifecycle recorded a 583188 ms Groth16 proof, 3313169 cycles, an exact `1000000`-unit payment, dual exact recovery, the independent oracle, nine reverting negative calls, and a separate Funded-job refund. After those assertions, a preflight fake child's synchronous kill left a timer armed. The later callback was an unhandled error, so the suite did not exit 0. `proofRerunAfterFix` is false.

The report preserves earlier attempts, including a 592426 ms proof (about 592.4 seconds) and a blocked attempt. That earlier proof is not the canonical lifecycle result. The report does not claim a fresh failing-verdict proof, a Submitted-state refund, or an actually pending mempool interruption. The restart check suppressed one observation of an already-mined submit.

Commit `2d9f2fd` disposes that owned cleanup timer when signaling fails. The status checkpoint records 26 preflight cases, 844 default worker tests, and a worker typecheck for that correction. Those are focused checks, not a fresh full funded pass. Published CI at `9458a81` precedes the timer correction. Do not describe the partial report or `2d9f2fd` as a clean pass.

Unset `UBC26_FUNDED_WORKLOAD` still selects this legacy package. Run the full suite from `commerce/worker` only when a proof run is intended. `UBC26_ARC_ANVIL` must be an absolute executable that reports Arc Foundry commit `3e95efaeaaaca64d6ac9c1ee988968683dbd0d22`. When set, `UBC26_SPRINT_SCRATCH` must be an existing operator-owned directory with mode `0700`. The suite deploys the real RISC Zero Groth16 verifier with the actual core and hook, and uses Arc Anvil's native local USDC predeploy. It starts forkless loopback Anvil and does not take a live RPC URL, fork URL, or wallet from the environment. Angle-bracket values are placeholders, not installed paths or approved identities:

```sh
cd commerce/worker
UBC26_ARC_ANVIL=<pinned-arc-anvil> \
  UBC26_SPRINT_SCRATCH=<private-0700-directory> \
  pnpm exec vitest run --config vitest.funded.config.ts
```

`UBC26_ENGINE_BIN` defaults to `engine/target/debug/engine`. `UBC26_R0VM_BIN` or `RISC0_SERVER_PATH` must resolve to `risc0-r0vm 3.1.0`. `ENGINE_DOCKER` and `UBC26_PYTHON_BIN` override `docker` and `python3` on `PATH`. Append `-t 'portable funded preflight'` for configuration checks only. That filter does not generate a proof. Do not run the full suite as a documentation check.

At `e1aa646`, the stamped fast default stack passed 1,935 commerce tests and the parent API real-engine suite passed 15. Those stamps predate indexer publication `e8b9273` and the unfinished Meridian suite. They are not a Meridian proof. Final-head CI remains pending until the actual report exists. Earlier [commerce CI](https://github.com/anishnarang9/UBC-26/actions/runs/43774141501) and [core-fast CI](https://github.com/anishnarang9/UBC-26/actions/runs/43774141450) were green at `ee64e755ac795eca662bba3f327981ab4af9a920` and do not cover this tree.

### Local-first Meridian rehearsal

The [Meridian package](fresh-exchange-input/README.md) is the current local workload. The suite selects it with `UBC26_FUNDED_WORKLOAD=meridian`. The command is the same as the legacy suite, plus that name:

```sh
cd commerce/worker
UBC26_FUNDED_WORKLOAD=meridian \
  UBC26_ARC_ANVIL=<pinned-arc-anvil> \
  UBC26_SPRINT_SCRATCH=<private-0700-directory> \
  pnpm exec vitest run --config vitest.funded.config.ts
```

`meridian` is the only accepted new value. The suite replays `candidates/valid`. It does not call Grok, the HTTP `DraftModel` API, or an autonomous solver. The named report path is `agents/anish/reports/fresh-exchange-local-2026-11-15.json`. That file is not present. Do not treat this section as a pass.

A suite worker is finishing the full local actual checks: a pending interruption, verdict 0, a Submitted-state refund snapshot, and indexed API reads. No fresh full pass exists yet.

The [guest report](../agents/anish/reports/localnet-meridian-guest-2026-11-15.json), published at `1c0b32e`, records a real 16-second compile, guest verdicts 1, 1, and 0, and about 7.05 million cycles. It includes no Groth16 proof. Local fixture timing is the parent-approved pair in the operator templates above.

The [semantic report](fresh-exchange-input/verification/REPORT.md) records 34 oracle tests, 39 differential cases, and 2 follow-up kiln mutations. The [independent review](../agents/anish/reports/localnet-semantic-review-2026-11-15.json) passed those 34 oracle tests, 53 paired engine/oracle checks, and a full enumeration of 3,200 accepted schedules. That review is not a Groth16 proof, payout, or recovery.

A new live Meridian workload waits on a fresh local run that records proof acceptance, exact payout, dual SDK/engine recovery, independent oracle agreement, and process exit 0. Final-head CI stays pending until that report arrives.

## Live acceptance still required

No live spending authorization or funded exchange exists. The remaining gates are:

1. Record a fresh Meridian local run with proof acceptance, exact payout, dual recovery, oracle agreement, and process exit 0. The partial legacy report, the `2d9f2fd` focused checks, the guest executions, and the semantic enumeration are not that result. No Meridian Groth16 proof exists yet. The pending, verdict 0, Submitted refund, and indexed API checks are still finishing.
2. Obtain green final-head CI for that source after the report exists. The 1,935-test fast stack and 15-test API real-engine check at `e1aa646` predate indexer publication `e8b9273` and do not cover this tree.
3. Obtain buyer approval, actual public identities, protected signing access, and explicit spending caps. Local synthetic accounts are not those identities.
4. Approve the exact deployment pins, selected terms, and separately authorized live phases.
5. Confirm actual funding and generate a fresh proof bound to that context.
6. Confirm accepted submit, authorized release/payment, and independent exact buyer recovery.
7. Record separately authorized rejection/refund evidence.

The release key becomes public in transaction calldata before payment confirmation. A failed release can still expose it. Never simulate or estimate with the real key. Payout and key publication in one successful transaction do not provide pre-inclusion confidentiality.

### Indexer confirmation lag

Optional confirmations are published at `e8b9273`, with the [implementer report](../agents/anish/reports/localnet-indexer-fix-2026-11-15.json) and the [spec review](../agents/anish/reports/localnet-indexer-spec-review-2026-11-15.json). The [API indexer](../commerce/api/src/indexer.ts) accepts `confirmations` and passes it to `LogCursor`. [Server startup](../commerce/api/src/server.ts) passes `3n` when `chain.mode` is `arc` and `0n` for simulation. An embedded caller that omits the option stays at the SDK default of `0n` and must pass a value explicitly.

Three blocks withhold only the newest three blocks from a new Arc cursor. That is a bounded lag allowance. It does not protect against an RPC that omits arbitrary logs. Indexed job status and delivery appear after the delay, not at the latest head. Turning the delay on does not recover logs the cursor already skipped. A clean local run uses a fresh database. An existing deployment needs a deliberate, approved reindex. Do not reset or delete `index_cursor` automatically.

## Dependency and historical evidence notes

Known `ws` advisories remain open. The controlled local keystore path uses no WebSocket connection. This narrows that path's exposure but does not remediate `ws` or prove whole-program unreachability.

The earlier [Rust dependency triage](../agents/anish/reports/integration-dependency-triage.json) remains a point-in-time report. Do not blindly upgrade the pinned proof stack. Any relevant guest change requires build/proof compatibility checks.

The [midday readiness report](../agents/anish/2026-11-15-readiness.md), [midday chain report](../agents/anish/reports/arc-readiness-2026-11-15-midday.json), and [integration verification](../agents/anish/reports/arc-integration-verification.json) predate the completed freeze and actual owner-history merges. Their unfrozen/publication-only observations are historical, not current blockers. Preserve their raw bytes and measured results.

Local Solidity checks use a synthetic receipt context, impersonated provider, and mock ERC-20. Earlier real receipts and exact recoveries remain valid evidence for those contexts. Neither establishes this sprint's fresh funded acceptance.
