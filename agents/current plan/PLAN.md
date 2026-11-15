# Current plan

Follow the [shared planning rules](AGENTS.md). Add dated entries newest first.

## 2026-11-14 22:46 -05:00 — Anish — Isolated engine and commerce evaluation

- `codex/engine-commerce` combines engine `adda3a3` with commerce `3013d736` for evaluation. Engine PR #3 remains separate. Engine fixes will use separate commits.
- The [execution plan](../anish/execution-plan.md) covers 60 challenges, 10,000 independent generated cases, failure-driven hardening, Luna authoring trials, and 12 new local proof receipts. These are targets, not completed results.
- Commerce's current `Engine` and `DraftModel` files are interface declarations. Their simulated output assumptions differ from the published CLI. The evaluation adapter will preserve normalized approvals, packages, typed errors, and model provenance. The production API and worker remain Neil's scope.
- Nick's deployed manifest, final envelope cap, and funded terms remain external integration dependencies. This run performs no live transactions.

## 2026-11-14 21:18 -05:00 — Anish — Commerce codec replay

- The [SDK replay check](../../engine/tests/check-commerce-sdk.mjs) passed against Neil's revision 3013d736. All six real engine receipts produced matching context, journal, digest, and submit calldata bytes. It covers the full 16 KiB encoded delivery and both verdicts.
- The SDK's captured calls preserve the real seals. Its mock verifier and local envelope cap still need the settlement workstream's final configuration. Confirm live acceptance through the deployed evaluator for the actual funded terms.

## 2026-11-14 20:48 -05:00 — Anish — Settlement and commerce integration

- Nick's [settlement plan](SETTLEMENT-IMPLEMENTATION.md) uses Circle's verified core with the Poster-only budget patch. Use the caller-first callback layouts from that plan for `fund` and `submit`. The external submit ABI and engine wire format stay the same. The released verifier pin is `ff30da77ba4afdd496290ebebedb205348b15d83`.
- Publish the encoded delivery and encrypted envelope limits in the deployment manifest. The engine accepts 16,384 encoded bytes, which produces a 16,412-byte envelope. A 16,384-byte envelope limit would allow at most 16,356 encoded bytes. Nick sets the final cap after measuring Arc submit gas.
- Before proving a funded job, use the manifest's core proxy as the escrow address. Read the core job and evaluator terms at one block. Confirm the job is funded and unexpired. Match the provider, image ID, rules hash, and reference hash to the proof inputs. Use the [job helper and funded preflight](../../engine/README.md#prepare-job-json-from-funded-terms) after those checks.
- Neil can wire the engine through the [commerce interface](../../engine/README.md#connect-commerce). It answers the engine questions in the commerce plan and identifies the fields the adapter needs to retain.

## 2026-11-14 — Nick workstream — Settlement plan: Poster naming and push rules

- Decision: the settlement plan calls the buyer role the **Poster** (posts the problem and locks the bounty). The Solver term is unchanged.
- Decision: settlement subagents push after each checkpoint and open detailed PRs without asking Nick. They record progress in `status.md` and team-affecting decisions here. Nick pushes `SETTLEMENT-IMPLEMENTATION.md` himself. It reached `main` in the `264fa5d` merge, and subagents still do not push changes to it. Affects settlement subagents.
- Terminology: the **Poster** in the settlement plan is the **buyer** in the commerce, architecture, and marketplace documents. The **Solver** is the worker or provider.

## 2026-11-14 20:00 -05:00 — Anish — Engine release measurements

- The [release measurements](../../engine/fixtures/release-report.json) use real receipts for reconciliation, signed text, and the 16 KiB delivery limit. The local verifier and Arc state override accepted the original receipts. The engine recovered each passing delivery byte for byte.
- The full-size envelope used 16,996 bytes of calldata under the documented submit ABI. The deployed evaluator still needs to confirm the cap and report settlement gas. The funded submit preflight is ready for the November 16 gate.

## 2026-11-14 — Nick workstream — Settlement implementation plan

- The [settlement implementation plan](SETTLEMENT-IMPLEMENTATION.md) specifies the Arc escrow, verifier, hook and evaluator, tests, and subagent tracks. It is proposed until the build gates pass.
- Decision: deploy our own copy of Circle's verified `AgenticCommerce` source with one patch (`setBudget` is Poster-only), then renounce admin roles. Reason: Circle's deployment is admin-controlled, so our proof-checking hook cannot be whitelisted there. Affects Anish and Neil.
- Decision: pin hook data to the deployed layout, which starts with the caller address. [WORK-SPLIT.md](WORK-SPLIT.md) sections 2.4 and 2.6 decode a different layout and need correcting. Section 10 of the new plan lists this and six other corrections: the core source to use (Circle's verified source plus the patch, not draft revision `a078cab5`), the four Poster funding transactions, the 5-minute minimum expiry, the 20 Gwei fee floor and 10,000-block log range, the stale verifier pin in Anish's context, and that our core is frozen by role renunciation while Circle's stays upgradeable.
- Answers to Neil's open questions for Nick (Q-N), from the settlement plan: the core is Circle's verified source with one patch, and our hook is whitelisted once before the admin roles are renounced (Q-N1, Q-N13). Only the Poster calls `setBudget` (Q-N2). Expiry must be more than 5 minutes ahead, and submit and release need `block.timestamp < expiry` (Q-N5). Only the funded Solver calls `release` (Q-N11). `claimRefund` works from Funded or Submitted once expired (Q-N12). The event names, selectors, and ABI stub (Q-N4, Q-N6, Q-N9, Q-N10) arrive with the Nov 15 manifest. The commerce plan's `setBudget` wording (provider-only, "if the pinned core has it") needs updating to match.
- Subagents work locally and read-only against Arc. Nick runs every live deployment. Real proof verification and the full settlement path on Arc are pending.

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

## 2026-11-14 15:45 -05:00 — Neil — Proposed: workstream 3 commerce plan, aligned with main

- **Owner:** Neil owns workstream 3, agent-to-agent commerce, as [WORK-SPLIT.md](WORK-SPLIT.md) proposes. The full plan is in [COMMERCE-IMPLEMENTATION.md](COMMERCE-IMPLEMENTATION.md). It covers the scope, the interfaces taken from the engine and settlement docs, the API (11 `/v1` endpoints), the data and state model, Grok authoring, the solver agent with its signer policy, delivery, the demo script, security, tests, tasks T1–T16 with checkpoints, risks, handoffs and the open questions for Anish (Q-A) and Nick (Q-N).
- **Neil's earlier proposals that are now superseded** (decisions 1–4, 7, 10, 11, 15 in the entry below). Commerce now follows main:
  - an isolated ERC-8183 core with one hook/evaluator contract, instead of Circle's shared ACP;
  - proof verified inside `submit`, where a bad proof reverts and the job stays Funded, instead of `attest` and `ProofRejected`;
  - the 234-byte `UBC26/*` journal, instead of the 114-byte `PG/*` journal;
  - off-chain quotes, instead of the on-chain sealed-bid RFQ;
  - two unrelated job types (record reconciliation and signed text), instead of scheduling plus procurement;
  - the `engine/` layout, instead of `crates/pg-*`.
  [ARCHITECTURE.md](ARCHITECTURE.md) and [MARKETPLACES.md](MARKETPLACES.md) now open with banners that say which parts still apply.
- **Still in force from Neil's entry:**
  - the verifier pin correction, which main now agrees with;
  - the Arc and RPC facts (gas paid in USDC, `-32005` rate limits, the 10k-block `getLogs` cap, no fork tests);
  - the Grok safeguards;
  - the signer policy;
  - the marketplace research;
  - **the Grok Bot bounty, kept**.
- **Proposed gate dates** for the WORK-SPLIT gates:
  - Interface: Nov 15 12:00
  - First proof: Nov 15, end of day
  - First funded job: Nov 16, end of day
  - Demo: feature freeze Nov 17, rehearsal Nov 18
- **Pending:** Anish and Nick review this. The Q-A and Q-N questions are unanswered. No commerce code exists yet. Next is T1–T3: workspace, SDK codec against the engine fixture, and a chain adapter on Nick's ABI stub.

## 2026-11-14 15:42 -05:00 — Anish — Engine interface checkpoint

- Engine branch `codex/anish-engine` publishes the [wire fixture](../../engine/fixtures/wire-v1.json) and the [first plan validator](../../engine/README.md). Solidity and TypeScript can use the fixture to check the context, journal, and encryption bytes.
- The validator accepts scalar rules and returns typed capability requests for operations and evidence beyond its current support. The generated checker, real funded-job proofs, and Arc verification remain pending.

## 2026-11-14 — Anish workstream — RISC Zero plan and team handoff

- The [RISC Zero implementation plan](ZKVM-IMPLEMENTATION.md) specifies a domain-independent compiler, local solver CLI, named file bundles, signed evidence, and byte fixtures.
- The [three-way work split](WORK-SPLIT.md) assigns the engine to Anish and defines separate Arc settlement and agent commerce roles. The other owner assignments are pending.
- Use released `risc0-ethereum` v3.1.0 for selector `0xe71e6620`. This corrects the verifier source pin in the earlier entry. The prior scheduling example is one possible workload. The new acceptance plan exercises two unrelated domains.
- The detailed documents mark proposed defaults and define build gates. Real proof generation, Arc deployment, and the full commerce flow remain pending.

## 2026-11-14 — Neil — Proposed: repo layout, settlement on Circle ACP, two job types, work breakdown

> **Superseded in part (Neil, 2026-11-14 15:45 -05:00).** Main's [WORK-SPLIT.md](WORK-SPLIT.md) and [ZKVM-IMPLEMENTATION.md](ZKVM-IMPLEMENTATION.md) replace the following parts of this entry:
> - decisions 1–4, 7, 10, 11, 15
> - the lane table
> - the gate table
>
> See the newest entry above. The rest is kept as history and research.

Status: **proposed**. It needs team agreement. Details are in [ARCHITECTURE.md](ARCHITECTURE.md) and the marketplace options are in [MARKETPLACES.md](MARKETPLACES.md). This entry keeps Anish's proof design (RISC Zero 3.1.0 Groth16, ChaCha20-Poly1305 bound to the job context, key released in the payout transaction) and proposes the changes below.

### Proposed decisions

1. **Settle on Circle's live ERC-8183 contract on Arc, not an isolated deployment.** A read-only check of `0x0747EEf0…4583` (verified `AgenticCommerce`) found zero fees, about 193k jobs and `whitelistedHooks(0) = true`. Custom hooks need Circle's admin. We instead write a `ProofGateEvaluator` contract and set it as the job's **evaluator**: `attest` (verify proof, job stays Funded) → `submit` → `release` (check key, `complete`, emit key). Reason: no whitelist is needed, and "plugs into an existing marketplace" becomes literally true. Fallback: self-deploy the same verified source.
2. **Adjust to the deployed ABI:** `setBudget` is provider-only, so the worker quotes on-chain and the signer allowlist includes `setBudget`. `fund` takes no `expectedBudget`, so the buyer approves the exact amount and the evaluator rechecks `budget == terms.budget`. `complete` has no expiry check, so `release` enforces it. The job struct does not store the deliverable, so the evaluator's attested envelope is the source of truth.
3. **Two job types, one generic checker guest:** type A is shift scheduling (Anish's jobs A and B). Type B is budget/vendor selection (N ≈ 32 items). Both lower deterministically to a bounded `LinearPlan`, which one audited RISC-V checker interprets (one image ID). Per-shape code generation is dropped: it forced a Docker rebuild and a new image ID whenever a dimension changed, and saved nothing in proving time.
4. **Journal is raw bytes** (`commit_slice`, 114 bytes) with fixed-width fields and domain tags. The context includes the evaluator address. The journal commits only a worker-chosen `scoreFloor`, not the exact score, because an exact score lets the buyer solve for the hidden answer on small instances. Golden fixtures are checked between Rust and Solidity. TS only decrypts.
5. **Verifier pin corrected:** use risc0-ethereum tag `v3.1.0` (`ff30da77`, selector `0xe71e6620`), deployed behind our own `RiscZeroVerifierRouter`. The earlier pin `f6d9398a` is a pre-release (selector `0x8b38038c`) that would reject every real 3.1.0 proof while its bundled test receipt still passes. This supersedes the commit hash in the entry below and in `anish/AGENTS.md`.
6. **Prover host is WSL2 on Neil's PC** (Ultra 9 275HX, 31 GB RAM, RTX 5080). It runs CPU STARK plus the Docker gnark Groth16 prover, with r0vm and cargo-risczero pinned to exactly 3.1.0. **No `cuda` feature before G2**: it removes the Docker fallback and Blackwell support is unverified.
7. **Monorepo layout:** `crates/` (core, rules, host, cli, solver, worker), `guests/checker`, `contracts/` (Foundry and the vendored Circle ACP), `packages/sdk-ts`, `apps/{api,web}`, `fixtures/`, `deployments/`.
8. **Testing reality on Arc:** fork tests cannot move Arc USDC, because it uses native precompiles that revm lacks. Local tests use the vendored, verified ACP with a mock USDC. Live evidence comes from scripted Arc transactions, with assertions on event amounts, because gas is paid in the same USDC.
9. **Run lanes in parallel from day 1.** L2 builds against `RiscZeroMockVerifier` and L3 builds against the ABI, so neither waits for G0. **Features freeze at the end of Nov 17.**

**Round 2 additions (brief step reviews):**

10. **Rejected work is recorded, not reverted.** A valid failing proof emits `ProofRejected` in a *successful* transaction, the job stays Funded and the escrow is untouched. Garbage proofs still revert.
11. **Sealed-bid RFQ** (`attestCandidate`, `provider = 0`, then `setProvider(best)`). Buyers rank encrypted, verified bids by `scoreFloor`. This meets the brief's "compare verified submissions" requirement and works on the deployed ACP unchanged. Demo: type-A Job A with two workers.
12. **Agentic worker:** a Grok planner chooses among solver tools, decides whether to bid or skip, and picks the `scoreFloor` to reveal. Rust rails decide what gets proved and signed. The decision log streams to the UI.
13. **Honest compiler:** the emitted `checker_<planHash>.rs` (readable audit artifact) is differential-tested against the interpreter. The UI recomputes `planHash` from the canonical bytes and renders the rules from those bytes. `jobType` and `loweringVersion` are part of the plan bytes.
14. **Authoring safeguards:** examples run on a mini instance (so they never leak the answer). The LLM predicts labels and the checker's disagreements are shown. The worst passing deliverable is shown. Rules render to English deterministically. Data comes only from buyer uploads, with `source_quote` on every constant. Demo beat: a prompt injection that fails.
15. **Type B is decided at G1 (Nov 15, 18:00).** Default: **GPU/compute procurement** (linear; about 2 hours). Upgrade, only if G0 and G1 are green: **ledger reconciliation** via a `TablePlan` primitive in the same guest, with an LLM worker producing the ledger. This answers the critique that "both types are the same ILP".
16. **Sponsor fit:** move the x402-paid `/compile` endpoint (Circle facilitator) and ERC-8004 worker registration from stretch into G3, owned by L2 after G2. Apply for a Circle Agent Marketplace listing. Attend Circle office hours on Nov 16. **Keep the Grok Bot bounty (Neil, 2026-11-14).** It requires core work done by Grok Bot on X, a chat export, and a short README on its role. It has to start **now**, because the chat must show real core work: drafting JobSpec schemas and rules, the type-B fixture, and reviewing the evaluator design. Export the chats daily into `docs/grok-bot/`. Owner: L3. Cost is mostly process, about 1 hour a day.
17. **Messaging:** "hidden until paid" (the result is public after payout), ZKCP-style fair exchange, and honesty that we handle machine-checkable work only. Positioning is in ARCHITECTURE §11a.
18. **The final is in person on Nov 21** (5-minute pitch plus 2 minutes of Q&A; prizes require attendance) and the video is 2–3 minutes. Both run on pre-proved jobs with archived calldata.

### Work breakdown (lanes TBD; proposed split for 3 people)

| Lane | Scope | Suggested owner |
| --- | --- | --- |
| **L1 zk core** | prover host (G0), `pg-core`, `pg-rules` (lowerings, emitted `checker.rs`, English renderer), checker guest, `pg-host`, `pg-cli`, `pg-solver` (incl. worst-passing witness), fixtures, image ID, `TablePlan` if taken | TBD |
| **L2 settlement + sponsor** | `ProofGateEvaluator` (attest with accept/reject/revert, `attestCandidate`, release), router and verifier deploy, Foundry tests on the vendored ACP, live Arc scripts, `deployments/`; after G2: x402 `/compile`, ERC-8004 registration, evaluator-gap measurement, Circle office hours | TBD |
| **L3 product** | Grok authoring with safeguards, event indexer, buyer UI (rules from bytes, examples, RFQ ranking, decrypt), agentic `pg-worker` (planner + rails + decision log), demo scripts, video, pitch | TBD |

### Build gates (revised)

| Date | Gate | Exit evidence | Lane |
| --- | --- | --- | --- |
| Nov 14–15 12:00 | **G0 Toolchain and proof path** (L1) | `r0vm` and `cargo risczero` report 3.1.0. A fresh tiny-guest Groth16 receipt has seal prefix `0xe71e6620`, verifies on our Arc router, and a mutated journal or image ID fails. Proving time, peak RAM and verify gas recorded. Meanwhile L2 has PG compiling against the mock verifier and vendored ACP, and L3 has the UI shell and Grok draft endpoint. | L1 (L2 and L3 in parallel) |
| Nov 15 | **G1 Encoding and checker guest** | Rust ↔ Solidity fixtures pass. The generic checker proves type-A pass and fail with an authenticated envelope. Jobs A and B share the image ID. | L1, L2 |
| Nov 15 18:00 | **Type-B decision** | Whether G0 and G1 are green decides B-upgrade (TablePlan ledger) vs. B-default (GPU procurement). The x402 facilitator's Arc-testnet coverage is checked. | all |
| Nov 16 | **G2 Settlement on Circle ACP** | The Foundry matrix passes on the vendored ACP, including round-2 cases. Live Arc run: a valid failing proof emits `ProofRejected` in a successful tx and the job stays Funded; attest → submit → release pays the worker and emits the key; the buyer decrypts. RFQ with 2 bids works. Expiry refund works from Funded and from Submitted. Circle office hours. | L2 |
| Nov 17 | **G3 Product loop, type B and sponsor** | Grok draft (safeguards, mini-instance examples) → buyer approval → create/register/fund. The agentic worker bids, proves, attests, submits and releases, with its decision log visible. A type-B job proves with the same image and pays out. x402 `/compile` and ERC-8004 registration are live. **Feature freeze at the end of the day.** | all |
| Nov 18 | **G4 Rehearsal** | Fresh jobs end to end from a clean checkout. Tx links archived. Video recorded. README covers setup, decision loop, signer limits and trust assumptions (single-party Groth16 setup, upgradeable ACP, key visible in calldata). Pre-generated receipts are ready as a fallback. | all |
| Nov 19 | Buffer, then stretch only if G4 is green | Circle developer-controlled wallets for the buyer, the agent-requester `Mandate`, a reproducible specialized-guest build, QuickNode Streams if it is live on Arc testnet | all |
| Nov 20 12:00 CT | Submission | Devpost (video 2–3 min) | all |
| Nov 21 | In-person final | 5-minute pitch plus Q&A on pre-proved jobs | attendees |

The critical path is G0 → G2. If G0 is not green by Nov 15 at 12:00, stop new scope and pair on it. **Scope cuts, in order:**
1. B-upgrade → B-default
2. Agent-requester mandate and Circle wallets
3. Worst-passing witness (precompute it instead)
4. Agent-marketplace listing application
5. ERC-8004
6. x402
7. LLM planner → deterministic worker loop
8. RFQ mode → single-provider jobs only

**Never cut:** proof gating, the on-chain rejection record, escrow and expiry refund, two job types, and buyer approval of the rules.

### Open questions for the team

- Lane owners.
- Bounty size per job. The faucet limits it, so 1–5 USDC is proposed.
- Whether to also self-deploy the kernel as a hot standby.
- Grok Bot bounty: **kept** (Neil, 2026-11-14). Log core work with Grok Bot on X from day 1 (see decision 16).

### Review log

**Round 1 (2026-11-14): two independent reviews. Both returned "VIABLE WITH FIXES". All fixes are applied above and in ARCHITECTURE.md.**

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| Z-B1 | The verifier pin `f6d9398a` is a pre-release (selector `0x8b38038c`) and would reject every real 3.1.0 proof. Confirmed from the upstream commit messages. | Blocker | Re-pinned to tag v3.1.0 `ff30da77`; the selector is asserted in deploy and CI |
| D-B1 | The scope does not fit 5.5 days with zero code and no toolchains | Blocker | Generic guest, TS limited to decryption, lighter CI, ArcBounty dropped, lanes run in parallel, feature freeze on Nov 17 |
| Z-M1 | Per-shape code generation breaks live authoring and saves nothing | Major | One generic `LinearPlan` checker guest |
| Z-M2/M3 | Local builds drift from the image ID; the Docker context copies `.env` keys | Major | `use_docker(root_dir)`, committed lock file, image-ID asserts; keys kept in `~/.config/pg/` |
| Z-M4 | An exact score in the public journal leaks the answer on small instances | Major | `scoreFloor` only; type B uses N ≈ 32 |
| Z-M5 | The `cuda` feature removes the Docker Groth16 path; sm_120 support is unverified | Major | CPU and Docker only until after G2; Bonsai env vars unset |
| S-M1 | ArcBounty takes all three ACP roles itself, so it cannot use our evaluator | Major | Dropped; kept as competitive context |
| S-M2 | Arc-fork tests cannot move USDC (native system precompiles) | Major | Vendored ACP with mock USDC locally; scripted live transactions |
| S-M3 | Gas is paid in the same USDC, which skews balance deltas | Major | Assert on event amounts, or on gas-adjusted deltas |
| S-M4 | The public RPC is rate-limited and caps `getLogs` at 10k blocks | Major | Worker keeps a block cursor with backoff; the API indexes events |
| S-M6 | Deployed ACP quirks: `fund` allows budget 0; `submit` works from Open with budget 0; a lower `setBudget` can front-run `fund` | Major | UI checks `getJob` before `fund`; exact approval then reset to 0; `attest` accepts Funded or Submitted; tests added |
| minor | Check evaluator and hook in `registerTerms`; 120 s margin on block time; never `eth_call` with the real key; `cancel` only when Funded and unattested; check the ACP implementation slot; head-only `getJob` decode; `try/catch` in `inspect`; pin crates (chacha20poly1305 0.11 without default features, sha2 0.10.8 patch) | Minor | Applied |

Confirmed by the reviewers: the lifecycle works against the deployed ACP source (no reentrancy issue, no double payout, release and refund are mutually exclusive). Arc has the sha256 and BN254 precompiles (pairing about 140k gas). Arc finality is instant, with about 0.7 s blocks. A non-admin can `createJob` with `hook = 0`. `commit_slice` gives `sha256(journal)` on-chain exactly. Encoding v1 binding is sound. A 24 GB WSL2 allocation is enough for local Groth16.

**Round 2 (2026-11-14): four reviewers, one per brief step, covering feasibility and real-world fit.** All judged the design feasible. Their gaps were mostly about fidelity to the brief and product fit:

| Step | Main findings | Resolution (decision #) |
| --- | --- | --- |
| 1 Describe | LLM-suggested examples are circular and can leak the answer; spec gaming (people judge LLM-written assertions correctly only 49% of the time, arXiv 2607.08885); invented data and unit mix-ups; injection through data; agents as requesters not handled; xAI schema limits | 14; mandate as stretch; recommended renaming type B as GPU procurement (15) |
| 2 Compile | An interpreter alone looks like "no compiler"; the buyer can't verify `planHash`; plan bytes not versioned; both types are the same ILP; no AI behind the deliverable | 13; 15 (TablePlan ledger upgrade); 4 KB deliverable cap |
| 3 Solve and prove | Worker not agentic; "compare submissions" missing; pre-generated receipts are tied to a job; Bonsai is shut down; key public after payout | 11, 12, 17; prover fallback is a second x86 host; demo jobs pre-proved |
| 4 Verify and settle | A reverted tx is poor rejection evidence; little Circle tooling for the Arc prize; "marketplace" is overstated; in-person final not planned | 10, 16, 18; office hours; evaluator-gap measurement |

Rejected or deferred: buyer-only key via ECDH (roadmap); a reject window for attested-but-unreleased jobs (roadmap); Boundless proving (not before Nov 20); Circle wallets (Nov 19 stretch).

### Marketplace integration risks (2026-11-14, Neil)

There are six ranked issues, each with an owner and deadline, in [MARKETPLACES.md § Current integration issues](MARKETPLACES.md#current-integration-issues-neil-2026-11-14). In short, Circle's ACP integration works now. Job discovery, x402 and Agent Marketplace coverage on testnet, and Circle's ability to upgrade the ACP get settled by the Nov 15 checks and the Nov 16 office hours.

### Open questions for the team (round 2)

- Who attends the in-person final on Nov 21? Prizes require attendance.
- Do we accept the G1 rule for type B (upgrade to the ledger only if G0 and G1 are green by Nov 15, 18:00)?
- Lane owners (still TBD).

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
