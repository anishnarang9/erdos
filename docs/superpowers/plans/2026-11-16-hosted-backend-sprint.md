# UBC-26 Hosted Backend Sprint Implementation Plan

> **For the future implementation chat:** Use the executing-plans workflow. Execute the checked work packages below. Use at most two Grok 4.7 CLI workers. The coordinator owns integration and verification.
>
> **Current status: PLAN ONLY.** This document does not resume the paused goal in the planning chat. Start execution only when the user asks a separate chat to implement this document.

**Goal:** Ship a publicly hosted open-bounty service that outside agents can use to author, fund, discover, solve, prove, settle, and recover supported work.

**Architecture:** Reuse the merged Rust/RISC Zero engine, TypeScript API/SDK/worker, and deployed Arc Testnet open-claim adapter. Host the API, persistent metadata, and queued checker compilation on a Docker-capable Linux service. Proving and wallet signing remain on the buyer's or solver's machine.

**Tech stack:** Node/Hono, TypeScript, SQLite, Rust, RISC Zero 3.1.0/Groth16, Docker, viem, Arc Testnet, Grok API, and Grok 4.7 CLI development workers. Keep the existing pinned versions unless a verified fix requires a controlled upgrade.

**Source repository:** `/Users/anishnarang/UBC-26`.

**Planning workspace:** `/Users/anishnarang/Documents/ChatGPT/UBC26`.

**Priority:** Finish everything under the hood. UI, demo/video, branding, private delivery, and larger-result protocols are excluded.

---

## 1. Goal Mode handoff

Paste this message into the new implementation chat:

> Implement the plan at `/Users/anishnarang/Documents/ChatGPT/UBC26/docs/superpowers/plans/2026-11-16-hosted-backend-sprint.md`.
>
> Start a new Goal Mode goal for the objective in this document. Use the real repository at `/Users/anishnarang/UBC-26`. Use at most two Grok 4.7 CLI workers and one prover per machine. Reuse the existing engine, commerce code, deployed contracts, and completed evidence. Follow repository guidance and the limits in this plan.
>
> Continue implementation, tests, reviews, fixes, and checkpoints until every required completion gate passes. Do not stop after planning, scaffolding, passing unit tests, or preparing deployment files. A public deployment and fresh end-to-end evidence are required. Complete independent work while external inputs are pending. Report concrete blockers without claiming completion.
>
> Exclude UI, demo/video, branding, private delivery, larger-result/storage protocol changes, and new contract deployments unless a verified defect makes a narrowly scoped change necessary. Do not revive those deferred workstreams from the older plans.

### Objective for the future goal

Complete the UBC-26 backend sprint: ship a publicly hosted, usable open-bounty API with per-user authentication and ownership, fully integrated and cost-bounded Grok authoring, a qualified checker engine, a packaged solver-side runner, developer documentation, operational recovery and monitoring, and verified end-to-end acceptance.

### Completion discipline

- Keep the goal active while required authorized work remains.
- Do not use elapsed time or a work-session boundary as a completion criterion.
- Persist progress in repository status, the shared plan, commits, and evidence reports.
- After a failed check, investigate the cause, add a meaningful regression, repair it, and rerun affected checks.
- Do not convert a required real test into a mock or replay to obtain a green result.
- Do not silently remove failed cases or weaken acceptance rules.
- Follow Goal Mode's actual pause, completion, and repeated-blocker rules.
- A user pause stops execution. This document does not override later user instructions.
- No recurring automation is needed. Supervise the sprint in its active implementation chat.

## 2. Scope and existing evidence

### Required in this sprint

1. Public HTTPS API with per-user credentials and wallet-bound job ownership.
2. Genuine Grok API authoring, clarification, deterministic validation, bounded repair, and approval.
3. Real checker compilation, with a durable queue and retrievable artifacts.
4. Broad engine and authoring qualification with independent expected results.
5. A usable local buyer/solver client and runner.
6. Open-bounty funding, discovery, claim, release, recovery, and refund.
7. Persistent metadata, crash recovery, logs, resource limits, backups, and deployment documentation.
8. A stable API handoff for Neil's later UI work.

### Explicitly deferred

- Buyer/solver UI, visual polish, replay UI, video, and pitch.
- Buyer-only result delivery and encrypted key wrapping.
- Larger result bundles, off-chain result storage, chunk registries, and new data-availability integrations.
- New marketplace mechanisms, ranking, global optimality claims, hosted proving, arbitrary checker code, and unrelated integrations.
- Branding, positioning, and commercial pricing presentation.

The current result bundle limit remains 16,384 encoded bytes. The encrypted envelope limit remains 16,412 bytes. Existing reference/evidence bounds remain unless a verified defect requires a separately reviewed correction.

**Privacy disclosure is mandatory:** the current protocol publishes the release key. Results become public. Do not market this sprint's service as private after settlement.

### Reuse and supersession

Reuse these earlier plans for the existing proof, signing, recovery, and settlement invariants:

- [Proof and Agent Exchange](2026-11-16-proof-and-agent-exchange.md)
- [Open-Claim Escrow](2026-11-16-open-claim-escrow.md)

This document supersedes their stale branch bases, three-worker dispatch, old deadlines, incomplete-deployment assumptions, and instructions to rebuild already merged features.

At planning time:

- Main was `6ed9d2d`, merging PR #7.
- The prepared Arc workflow had fresh proof, claim, exact payout, recovery, rejection, and refund evidence.
- Circle Gateway paid compilation and exact replay had separate live evidence.
- Neil's UI was on `neil/plan-architecture` at `9bd6ec7`. It used selected-provider quotes.
- Main's buyer authentication used a shared bearer token.
- The broad historical authoring evaluation used Luna. It does not establish fresh deployed Grok reliability.

Verify current source and remote state at startup. Do not repeat old deployments, freezes, or spending merely because an old checklist is unchecked.

## 3. Execution structure and startup

### Coordinator responsibilities

The coordinator writes the runner/client integration, owns the shared API contract, reviews worker changes, performs integration, and observes final command exits.

Use two Grok workers:

| Worker | Exclusive initial scope | Deliverables |
| --- | --- | --- |
| A: hosted service | `commerce/api/`, deployment assets, backend documentation | Authentication, ownership, Grok pipeline, persistent queue, hosting configuration |
| B: engine qualification | `engine/`, independent qualification fixtures and reports | Challenge corpus, engine tests, measured gaps, targeted fixes, guest/proof evidence |
| Coordinator | `commerce/worker/`, shared SDK changes, integration, final evidence | Outside-agent workflow, runner packaging, deployment, end-to-end acceptance |

Keep shared SDK, catalog copies, and shared route-contract edits under coordinator control. Announce interface changes before another worker consumes them.

Use separate managed worktrees or exclusive write scopes. Do not let workers edit the same files concurrently. Do not spawn additional worker trees.

### Dependency order

1. Establish the baseline and shared API contract.
2. Worker A completes identity, durable tasks, and hosted Grok integration in that order.
3. Worker B builds independent oracles and runs deterministic qualification in parallel.
4. Freeze each engine/catalog revision before measuring Grok against it. Invalidate affected benchmark results after a material change.
5. The coordinator integrates the client and runner after the identity/task contract is stable.
6. Combine reviewed work, run local real-proof acceptance, and deploy the combined source.
7. Run external-client, hosted Grok, restart, and live settlement acceptance against the final deployment.

Worker B and the coordinator share the single prover slot. Never let a restarted task create a second prover implicitly.

### Startup checklist

- [ ] Read applicable `AGENTS.md`, including `agents/AGENTS.md` and `agents/current plan/AGENTS.md`.
- [ ] Read the latest shared plan and relevant owner status from current main and owner branches.
- [ ] Inspect existing attached worktrees, dirty files, running compilation, and prover processes.
- [ ] Use the app's managed worktree tool for new worktrees. Use a `codex/` branch based on current reviewed main.
- [ ] Preserve all unrelated edits, private scratch data, wallets, and existing process ownership.
- [ ] Establish baseline commerce, engine, and contract checks using pinned repository tools.
- [ ] Record baseline failures separately from sprint regressions.
- [ ] Add the active sprint scope and work ownership to the shared plan and Anish's status.
- [ ] Copy this plan into the implementation worktree's documentation and link it from the shared plan.

### Hosting access discovery

Discover existing authenticated hosting accounts, projects, domains, and approved infrastructure first. Inspect identity and configuration without printing credentials.

Preferred topology: one persistent Docker-capable Linux host for the API and compilation worker. Serve documentation and health endpoints over HTTPS. A later frontend may use Vercel.

Do not force the existing local SQLite and Docker compiler into Vercel Functions. A Vercel frontend plus a persistent backend is compatible with this plan.

If no suitable host is available, prepare and verify the deployment package first. Then request the missing account access, provider/budget choice, and hostname in one concise message. Continue independent implementation while waiting.

Public hosting, model access, and fresh live spending are separate dependencies. No prepared container or localhost tunnel establishes a completed hosted release.

### Grok worker invocation

Verify the installed CLI's supported flags before dispatch. Use task files and collect session IDs, logs, commits, and actual exit codes.

```sh
grok --cwd "$worker_dir" --model grok-4.7 --reasoning-effort high \
  --no-subagents --prompt-file "$task_file" --output-format json
```

Each task file must name its exact write scope, source base, required tests, prohibited actions, and return format. Workers must not access wallet material or deploy/spend without the coordinator's applicable authority.

For research/review, use the CLI's read-only mode and disable write, shell, and subagent tools as appropriate. Do not substitute native Codex worker swarms for the requested Grok workers.

Keep one prover active on each machine. Fast tests and model calls may run concurrently within measured resource limits.

## 4. Ordered work packages

### Package 1 — Public identity and ownership

**Primary areas:** API authentication, database migrations, route context, idempotency, job/revision/approval/funding handlers.

- [ ] Add wallet-signed, expiring, single-use authentication challenges for self-service API-key issuance.
- [ ] Bind challenges to this service, the wallet, action, nonce, and expiry. Reject replay and wrong-domain signatures.
- [ ] Issue high-entropy API keys once. Store only a digest, key identifier, wallet owner, creation time, revocation state, and allowed scopes.
- [ ] Support key inspection and revocation. Never log raw keys.
- [ ] Use the authenticated wallet as the principal for ownership and idempotency.
- [ ] Bind each new job, draft, approval, and expensive task to its owner.
- [ ] Require that funding terms name the authenticated buyer wallet.
- [ ] Enforce ownership on all mutation routes, including compilation, linking, paid compilation, and revision operations.
- [ ] Keep public discovery, committed packages, references, and chain status readable as required by the protocol.
- [ ] Disable the shared legacy buyer token in public deployment mode.
- [ ] Preserve old data without assigning legacy jobs to new users. Legacy ownerless records remain non-mutable through public credentials.
- [ ] Add configurable per-principal/IP limits and a global emergency disable for expensive operations.

**Acceptance:** two independently issued keys can create separate jobs. Neither can alter, approve, compile, fund-link, revoke, or retrieve private account records belonging to the other. A revoked key stops working immediately.

### Package 2 — Durable tasks and hosted runtime

**Primary areas:** API task service, migrations, server configuration, checker subprocess boundary, deployment scripts.

- [ ] Add durable tasks for slow authoring and compilation. New clients start a task and poll its status.
- [ ] Persist task owner, operation, input/revision binding, state, attempt, output reference, and sanitized error.
- [ ] Return task identifiers promptly. Do not keep a request open for an entire cold compilation.
- [ ] Deduplicate expensive work before dispatch. Concurrent identical idempotent requests must not create duplicate model calls or builds.
- [ ] Initially run one compiler task at a time and at most two authoring calls at a time.
- [ ] Preserve completed outputs and distinguish queued, running, succeeded, failed, and uncertain outcomes.
- [ ] Resume queued work after restart. Reconcile interrupted running work without blindly repeating paid requests.
- [ ] Keep engine invocation shell-free with bounded arguments, environment, time, output, memory, and disk use.
- [ ] Keep compiler workers isolated from wallet secrets and API administration credentials.
- [ ] Persist SQLite/WAL state, packages, task state, and compiler cache on durable storage.
- [ ] Create a reproducible Linux deployment with pinned engine/container inputs, HTTPS, restart policy, and backup/restore commands.
- [ ] Add liveness and readiness endpoints. Public mode must fail readiness if the engine, database, required model configuration, or deployment pins are invalid.
- [ ] Reject simulated engine/chain configuration in public production mode.
- [ ] Provide structured request/task logs and basic queue, error, latency, and resource metrics.

Preserve existing library interfaces or explicit compatibility adapters where useful. Publish the new asynchronous client contract. Avoid a broad rewrite of working modules.

**Acceptance:** a cold real compilation completes through the hosted task interface. A service restart preserves accounts, jobs, queued work, and compiled packages. An interrupted task never falsely reports success.

### Package 3 — Complete Grok authoring

**Primary areas:** `commerce/api/src/grok.ts`, `authoring.ts`, engine-contract copies, qualification records.

- [ ] Use the configured Grok API from the hosted service. Development CLI access is not a substitute for deployed API access.
- [ ] Supply the current engine schema/catalog, full permitted reference contents, requested outputs, and clarification answers.
- [ ] Do not silently truncate material used to draft paid requirements. Reject or request clarification when the model cannot inspect necessary input.
- [ ] Return a draft, focused clarification, or specific unsupported-capability explanation.
- [ ] Add a request-wide timeout, supported output-token limit, output-size bound, and finish-reason checks.
- [ ] Validate every generated plan with the real engine.
- [ ] Allow one automatic repair using exact validation/counterexample feedback. Keep initial and repaired attempts separate.
- [ ] Require usable positive and negative examples. Evaluate them with the engine and preserve invalid-input versus verdict-0 distinctions.
- [ ] Check source quotes against the supplied request/reference text.
- [ ] Preserve requirement-to-rule coverage metadata and show omissions or unresolved assumptions before approval.
- [ ] Keep approval explicit and bound to the current rules, structure, references, outputs, expiry policy, and budget.
- [ ] Any material revision voids approval. Compilation must reproduce the approved commitments.
- [ ] Give the model no wallet, spending, arbitrary shell, or contract-changing authority.
- [ ] Record model ID, prompt/catalog version, latency, billable usage, retries, and cost.
- [ ] Reserve spend before calls. Apply a request-wide ceiling across repairs and a configurable global daily limit.
- [ ] Unknown pricing/usage or uncertain billing must not silently count as zero cost or trigger unlimited retries.
- [ ] Keep API service charges separate from escrow bounties. Preserve x402's existing pending-payment and exact-replay protections.

**Cost gate:** target mean authoring cost below $0.10, including failed attempts and repairs, across the frozen qualification corpus. Report first-pass and repaired costs separately. Proposed caps are configuration, not permission to incur charges without applicable account authority.

**Acceptance:** a fresh hosted request reaches a real Grok draft, real engine validation, explicit approval, and real compilation. Replay performs no additional paid inference or charge.

### Package 4 — Engine and authoring qualification

**Primary areas:** existing engine evaluation harness, independent oracles, compiler/runtime tests, real Grok harness.

- [ ] Reuse the existing 10,000-case seeded suite, archived guest/proof checks, commitment mutations, and semantic controls.
- [ ] Create a new frozen set of 60 realistic requests: 40 supported, 10 ambiguous, and 10 unsupported.
- [ ] Spread supported requests across at least 10 task families or distinct constraint combinations.
- [ ] Include reconciliation, inventory, budgets, policy checks, scheduling, allocation, bounded routing feasibility, quantitative calculations, signed evidence, and file requirements.
- [ ] Use new schemas/data/conditions. Do not merely rename historical fixtures.
- [ ] Include tasks with multiple valid solutions. Do not reduce acceptance to a supplied expected-answer hash.
- [ ] Write deterministic expected-result oracles independently from generated plans.
- [ ] Give supported tasks valid outputs, isolated requirement violations, and malformed inputs.
- [ ] Run three fresh Grok API trials per request through the actual authoring path. Do not share hidden answers or batch scratchpads.
- [ ] Score semantic agreement, missing requirements, invented conditions, clarification facets, unsupported explanations, quote fidelity, repair count, cost, and latency.
- [ ] Keep benchmark budget separate from public-service budget. Stop expensive dispatch if its authorized cap is exhausted.
- [ ] Add meaningful regressions before fixing confirmed failures.
- [ ] Exercise integer boundaries, duplicate/missing keys, malformed encodings, nesting/visit bounds, resource limits, source injection, reference changes, and commitment substitution.
- [ ] Compare independent oracles, host evaluation, generated guest execution, and proof-backed outcomes.
- [ ] Any new capability must update catalog/schema, compiler, guest, API contract copies, client behavior, and qualification together.
- [ ] Add only small general capabilities needed by concrete workloads. Separate larger parser/runtime/verifier projects from this sprint.
- [ ] Never weaken a request or call an unverified solver summary equivalent to checking its source document, image, or model.
- [ ] Keep unsupported tasks explicit if they require arbitrary code, network truth, subjective quality, or a separate verifier backend.

**Qualification gates:**

- Zero observed false accepts or host/guest disagreements in the qualification corpus.
- At least 95% of supported trials produce a semantically correct, engine-valid draft after at most one repair.
- No failed or incomplete draft can reach funding approval unnoticed.
- Ambiguous cases must not silently invent missing policy.
- Unsupported cases must not become weaker payable jobs.
- Every accepted source quote is verbatim.
- The authoring mean meets the $0.10 target, with actual API usage recorded.
- Produce fresh real passing proofs for three materially different supported workloads.
- Produce a fresh real verdict-0 proof for a structurally valid failing workload.
- Verify receipts with the pinned real Solidity verifier and recover passing files byte for byte.
- Reuse archived evidence for unchanged components, but do not label it a fresh run.

If a gate fails, repair and rerun. Do not lower the threshold to declare success. Publish finite evidence, not universal correctness claims.

### Package 5 — Outside-agent client and local runner

**Primary areas:** `commerce/worker/`, shared SDK, versioned API client, developer guide.

- [ ] Add an installed-package workflow that does not depend on the coordinator's personal paths or private operator JSON.
- [ ] Support authentication/key setup, job authoring/import, approval, compilation-task polling, funding preview, and confirmed funding linkage.
- [ ] Support open-job discovery, pagination, exact job inspection, package download, and package/reference integrity checks.
- [ ] Exclude expired-but-unrefunded jobs from the open feed using confirmed chain time.
- [ ] Let a solver provide a local deliverable directory or its own solver command/adapter.
- [ ] Keep arbitrary solver execution outside the hosted API/compiler service.
- [ ] Provide check-only and prepare-only commands before signing.
- [ ] Run evaluation and proving locally against the actual funded context and solver identity.
- [ ] Preview exact contract destinations, calls, gas limits, bounty, deadlines, and allowed spending.
- [ ] Reuse protected signing, durable send journals, nonce reservations, deployment pins, and receipt reconciliation.
- [ ] Do not remove the current operator's protections to make a packaged runner work.
- [ ] Replace checkout-only assumptions with verified release/binary/artifact provenance in the packaged path.
- [ ] Observe the winner before release. Losing workers release no key.
- [ ] Support recovery, refund, interruption, pending sends, and uncertain receipts without duplicate funding or payout.
- [ ] Keep real release keys out of RPC simulation and gas estimation.
- [ ] Publish checksums and supported platform/tool requirements. Validate native Linux first.
- [ ] Supply a TypeScript example and language-independent HTTP examples.
- [ ] Document honest hardware, timing, file-size, public-result, and unsupported-capability limits.

The runner proves and settles files. It does not claim to solve arbitrary work automatically. Both humans and agents may produce the files.

**Acceptance:** a clean independent installation can complete the documented workflow without editing repository source or using the coordinator's private configuration.

### Package 6 — Stable UI handoff without UI implementation

**Primary areas:** OpenAPI/route contract, typed client, sanitized task/attempt status.

- [ ] Publish authentication, ownership, tasks, authoring, approval, compilation, open-bounty funding, discovery, and recovery contracts.
- [ ] Publish representative success, pending, rejected, unsupported, expired, and error responses.
- [ ] Expose per-job and per-solver attempt identifiers. A failed attempt does not mark the whole bounty rejected.
- [ ] Reuse sanitized telemetry where useful. Prevent secret, plaintext, password, and filesystem-path disclosure.
- [ ] Use one authoritative event order or explicit per-attempt cursors. Do not collide independent solver sequence numbers.
- [ ] Define confirmed chain state as authoritative for winner, payment, expiry, and refund.
- [ ] Document the five funding steps: create, set budget, approve, fund, register.
- [ ] Keep demo signers and presenter-only routes disabled on the public service.
- [ ] Do not edit or merge Neil's UI wholesale. It still needs separate open-bounty adaptation.
- [ ] Publish a concise UI handoff for Neil with final endpoints, examples, backend limitations, and the exact integration SHA.

**Acceptance:** Neil can implement the UI against the documented backend without another backend redesign. No UI completion is needed to close this sprint.

### Package 7 — Security, operations, and deployment

- [ ] Run independent review of auth/ownership, paid inference replay, task recovery, signer boundaries, and package handling.
- [ ] Check dependency advisories for actual reachable exposure. Fix relevant issues without uncontrolled toolchain upgrades.
- [ ] Test concurrent identical requests and different users requesting the same expensive operation.
- [ ] Test global/per-user quotas, malformed bodies, path traversal, symlinks, oversize artifacts, and unavailable dependencies.
- [ ] Bind public CORS and proxy settings to the deployed hostname. Do not depend on localhost development proxies.
- [ ] Make database migrations repeatable. Back up before migration. Never automatically delete indexes or historical records to repair a deployment.
- [ ] Restore a backup into a separate instance and verify job/owner/artifact consistency.
- [ ] Expose public health and sanitized readiness. Keep diagnostics, admin controls, and secrets protected.
- [ ] Verify that restart policies, disk limits, cache cleanup, and log rotation work.
- [ ] Deploy a reviewed source SHA over HTTPS. Record runtime/toolchain/container identities and configuration names without secret values.
- [ ] Test from an external client. A laptop-only process, temporary tunnel, or localhost URL is not the hosted release.
- [ ] Stop the development laptop's API and prove the hosted health, auth, authoring, compilation, and artifact routes still work.
- [ ] Record deployment rollback and recovery instructions.

No hosted prover is required. The local proving machine may remain active only for proof generation and chain signing during acceptance.

### Package 8 — Final acceptance and publication

- [ ] Run a fresh hosted buyer-to-solver open-bounty flow from independent identities.
- [ ] Use a newly authored supported problem with an independent oracle.
- [ ] Approve exact rules, compile, fund, and register the correct deployed job.
- [ ] Generate a fresh proof from that funded context.
- [ ] Confirm claim, winning identity, matching key release, exact bounty payment, and public byte-exact recovery.
- [ ] Recover through both SDK and engine. Run the independent oracle.
- [ ] Check a separate invalid claim/rejection and a separate expiry refund.
- [ ] Test a second solver's attempt handling. Distinguish abstention from a real valid-proof race.
- [ ] Exercise service restart and client resume without duplicate model charges, funding, claims, releases, or refunds.
- [ ] Preserve and exercise genuine Circle paid compilation through the deployed service, including its 402 challenge, payment, real compilation, and exact replay. Preserve payment/bounty separation.
- [ ] Run every final CI group at the actual release SHA.
- [ ] Publish versioned client/runner artifacts, source, setup, API contract, supported-capability matrix, reports, operational runbook, and Neil's handoff.
- [ ] Commit and push coherent checkpoints under repository shipping rules. Preserve unrelated work.
- [ ] Report exact tests, failures, skips, proof timings, costs, receipts, recovery hashes, deployment URL, and release SHA.

Old wallet/spending approvals may be scoped to completed runs. Prepare a concrete preview for any new live action. Use only current applicable authority. Do not expose wallets or authorization material to workers.

## 5. Verification commands and evidence

Use the repository's pinned tools. Refresh exact commands from current CI/runbooks before execution.

Known baseline commands:

```sh
pnpm --dir commerce check
pnpm --dir commerce --filter @ubc26/api test:engine
cargo +1.98.1 fmt --all -- --check
cargo +1.98.1 clippy --locked --workspace --all-targets -- -D warnings
cargo +1.98.1 test --locked --workspace
node engine/fixtures/check-wire-v1.mjs
```

Run Cargo commands from `engine/`. Run wire checks from the repository root. The real-engine API suite requires explicit `ENGINE_MODE=native`, `ENGINE_PATH`, and the configured cache/work directories.

The existing open-claim real-proof and recovery suites use:

- `commerce/worker/vitest.open-claim-real.config.ts`
- `commerce/worker/vitest.open-claim-recovery.config.ts`

Follow their environment setup in `docs/overnight/open-claim-local-runbook.md` and `docs/overnight/open-claim-live-operator.md`. Do not invent a new synthetic context and call it funded acceptance.

Run contract tests with the pinned Arc Foundry binary and `--network arc`. Run ABI parity and existing contract examples. Never substitute ordinary Ethereum execution for the required Arc configuration.

### Required release evidence

Publish one release report under `agents/anish/reports/` that links:

- Source SHA and deployment URL.
- Auth/ownership/security and concurrency results.
- Grok prompt/catalog/model versions, 180 trial records, repairs, costs, and semantic scores.
- Independent oracle and seeded regression results.
- Host/guest/proof parity and recovered-file hashes.
- Clean-install runner verification.
- Hosted restart, backup restore, and laptop-independence checks.
- Live acceptance receipts and exact amounts.
- Final CI results.
- Remaining limitations and Neil's handoff.

Keep private keys, passwords, raw authorization headers, unpublished release keys, raw signed transactions, and private operator files outside Git and public reports.

## 6. External dependencies and blocker handling

Discover these early and track each separately:

| Dependency | Needed for | Work that can continue without it |
| --- | --- | --- |
| Hosted account and approved resource budget | Public deployment | Runtime packaging, migrations, auth, queues, tests, documentation |
| Grok API credential and approved inference budget | Real deployed authoring and qualification | CLI-assisted development, recorded replay, deterministic tests |
| Public hostname/TLS access | Stable HTTPS endpoint | Provider URL deployment and external API checks |
| Funded wallets and current testnet spending authority | Fresh live settlement | Local real-verifier acceptance and unsigned live previews |
| Local prover dependencies/resources | Fresh proof evidence | API, compiler, guest execution, archived verifier regression |

Ask only for missing access or a material decision that cannot be discovered. Consolidate external-input requests. Finish concrete preparation first and continue independent work.

Do not read arbitrary credential stores or private wallets to avoid an input request. Use relevant supported authentication and secret-management paths.

If a dependency remains unavailable, report the exact gate it blocks. A successful local run does not close the public-hosting gate.

## 7. Final completion checklist

The future goal is complete only when every required item below has evidence:

- [ ] Public HTTPS service runs independently of the development laptop.
- [ ] Outside users can obtain and revoke their own credentials.
- [ ] Job ownership and wallet binding prevent cross-user mutation.
- [ ] Real hosted Grok authoring, clarification, repair, approval, and compilation work.
- [ ] Expensive work is deduplicated, queued, bounded, and recoverable.
- [ ] The 60-request, three-trial Grok qualification meets its stated gates.
- [ ] Engine regression, independent oracle, guest, and real-proof checks pass.
- [ ] The packaged local runner works from an independent installation.
- [ ] Fresh hosted-to-local-prover-to-Arc settlement and exact recovery pass.
- [ ] Rejection, refund, restart, replay, and uncertain-send cases pass.
- [ ] The deployed paid-compile path preserves the real Circle charge and exact-replay behavior without double charging.
- [ ] Backup restore and deployment rollback are documented and checked.
- [ ] Final source checks and CI pass at the published release SHA.
- [ ] API documentation, operational runbook, capability limits, and Neil's backend handoff are published.
- [ ] No required implementation or deployment gate remains disguised as future work.

The final report must distinguish completed work, historical evidence, fresh evidence, and actual blockers. Do not mark this goal complete because the code was written, the tests started, or the time window ended.

## 8. Reference sources

- [Vercel: SQLite and persistent storage](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Grok structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
- [Grok prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works)
- [Grok API models and pricing](https://docs.x.ai/developers/models)

Refresh provider limits and prices before implementation. These references do not replace the repository's pinned protocol/toolchain or current account authorization.
