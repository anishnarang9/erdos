# Product plan and Claude handoff

## 2026-11-16 02:52 -05:00 — Codex — Reconciled with Neil's D1–D4 decisions

**Status:** Product and UI planning reconciled against [ui-intent.md — Decisions](ui-intent.md#decisions). Claude recorded Neil's confirmation of D1–D4 and resolutions for C1–C14; this revision applies them throughout the plan. Implementation and recording gates remain future work, not completed features. Claude owns the intent file and its Decisions section; Codex writes only this file. No application source was changed.

**Revision record:** The original proposal was written on 2026-11-16 at 02:31 -05:00. This revision supersedes its prepared-proof/live-settlement recommendation and three-minute live-runtime gate. The approved deliverable is a 2–3 minute submitted video of fresh real execution, with labeled edits of waits. Full presenter controls remain for finals, booth use and replay retakes. Human funded delivery is optional and gated; public/shareable data is the approved positioning.

**Reconciliation source:** HEAD `f38b59e`; intent-file SHA-256 `45cdd29b9625441b331e4010c5257fee838f2bc6c0539b52596bc27f9277fb1e`. The Decisions section supersedes conflicting text in the intent file's earlier sections. The evidence review and tests below remain dated to the original reviewed code; a documentation update does not turn them into fresh implementation tests.

**Original technical review:** branch `neil/plan-architecture`, HEAD `434dd22`; then-current `ui-intent.md` SHA-256 `52c991ce178862979bb60c9be27f4d94e4e92ace5ab4f81720b159270612ba47`. The working tree already contained UI work and pnpm changes; those belong to the existing work and were left untouched. The local repository's origin is `https://github.com/anishnarang9/UBC-26`. The group-chat evidence reviewed is Neil's pasted discussion, also present in his earlier Codex thread; no additional external chat history was accessed.

**Agreed direction:** Keep humans eligible and lead with agent commerce. Sell **payment for a specified, verifiable deliverable on public or shareable inputs**. For this hackathon, demonstrate a buyer commissioning a reconciliation result from an autonomous solver. Say the same checks can gate a human-prepared file and the human adapter is next; show a paid human delivery only if its funded acceptance gate passes before recording. Preserve the current selected-provider flow. An open competition where anyone can claim the bounty is a later marketplace design.

**Proposed pitch:** “Post the rules. Fund the work. A human or agent delivers a result, and payment is gated by a proof that it passes the approved checks.”

**The memorable moment:** A one-cent error receives no payout. A valid result is proven while encrypted, then payment and key release settle together and the actual files open on screen. Judges see a business consequence and the evidence for it.

## 1. Product choice: who needs this and why

Initial customer hypothesis: a small software or data agency commissioning bounded data conversion and validation tasks from external specialists. The buyer already knows the required output format, authoritative reference, and acceptance rules. Their desired outcome is an accepted artifact with less back-and-forth about whether a job is complete.

For the demo, use a synthetic invoice-ledger reconciliation job because this is the workload already exercised by the engine, worker, and Arc settlement. For early discovery, prioritize public or explicitly shareable data. The current delivery design makes results publicly recoverable when the release key is disclosed; the references API also exposes reference files. Confidential accounting data is therefore not a supported pilot assumption.

The human proposal is useful because it broadens who can produce an acceptable artifact. It does not remove the need to specify the work. Replace a narrow contractor workflow—brief, fixed deliverable, acceptance, payment—with a repeatable template. Do not promise to replace consulting, discovery, judgment, or relationships.

The hard question is: **If the buyer can describe the check, why not do the work themselves?** A compelling job has cheap verification but meaningful production effort, specialist knowledge, or an existing artifact the seller wants to sell. The existing reconciliation solver simply copies ledger rows. That is a good protocol fixture and a weak standalone business. We should say so and validate a more valuable transformation before making revenue or time-saving claims.

### Directions evaluated

These rankings are product judgments based on code fit and verification difficulty, not customer research or measured market demand.

| Candidate | Fixed deliverable and acceptance | Current fit | Recommendation |
| --- | --- | --- | --- |
| Reconciliation / migration integrity | JSON records; approved IDs, exact amounts, completeness, totals | Strongest: existing draft, solver, proof and settlement evidence | Demo anchor; turn into a useful transformation only after testing a concrete template |
| Public product-catalog conversion | Import-ready records; schema, source-to-output mapping, preserved values | Plausible with supported JSON rules; actual transformation and fixtures remain to be built | Best early customer-discovery candidate; do not claim arbitrary CSV import exists |
| Signed evidence packaging | Files with signatures and fields checked against pinned keys | Engine plan supports this domain; end-to-end demo readiness unverified here | Optional second-domain exhibit after current team gates pass |
| Constraint-based scheduling | Feasible assignment; coverage, capacity, cost ceiling | Present in older plans, superseded as the main demo | Roadmap; feasibility is not proof of global optimality |
| Small software fixes | Patch plus controlled tests and artifact restrictions | Requires a different execution/verification workload | Attractive later; too much scope this week |
| Design, marketing, research, real-world errands | Usually subjective quality or uncertain external truth | Poor deterministic acceptance fit | Exclude from this product promise |

A marketplace also needs willing solvers. “Everyone works; one person gets paid” puts speculative effort on suppliers. The existing quote-then-assignment flow is a sensible first product: compare offers, select one provider, and require proof before payout. Price discovery and work verification are separate steps.

### Human and agent roles

| Role | Hackathon behavior | Claim boundary |
| --- | --- | --- |
| Buyer | Person drafts, approves rules, chooses quote, authorizes funding | Autonomous buyer procurement is not implemented by this UI |
| Agent solver | Polls jobs, chooses supported jobs within price limits, quotes, executes a solver, proves, submits and releases | Current agent uses deterministic solver tools; do not portray it as an LLM inventing the reconciliation solution |
| Human solver | Prepares exactly the declared files and uses the same proof runner and funded-provider identity | `filesSolver(dir)` exists, but the exposed files CLI is synthetic; a funded human entry point remains work |
| Verifier | Checks the approved program and bound proof commitments | It does not know whether the buyer chose commercially adequate rules or whether source data describes reality |

No new human marketplace, profile system, solver dashboard, or dual settlement model is required for the core demo. Use a small source label, “agent-generated” or “human-prepared,” only when backed by the run manifest. Human authorship is descriptive metadata, not a cryptographically proven fact.

## 2. What is demonstrated, inferred, and missing

| Capability | Evidence inspected | Assessment |
| --- | --- | --- |
| English drafting and engine-checked rules | [Grok recordings](../../commerce/api/test/integration/fixtures/grok/README.md), `summary.json`, authoring code | Recorded real-model/real-engine evidence; buyer approval remains essential |
| Quotes and assignment | [market.ts](../../commerce/api/src/market.ts), [agent.ts](../../commerce/worker/src/agent.ts) | Implemented, including buyer quote listing; one selected provider is bound into funding |
| Correct proof, settlement, file recovery | [Arc evidence](../../commerce/evidence/arc-first-funded-jobs.md) | Prior real run: 126.4-second proof; submit accepted; release paid 0.01 test USDC; recovered bytes matched |
| Incorrect result and refund | Same evidence, [funded.ts](../../commerce/worker/src/funded.ts) | Prior real verdict-0 proof: 118.7 seconds; no broadcast; rejecting `eth_call`; later expiry refund |
| Human-prepared files | [solvers/index.ts](../../commerce/worker/src/solvers/index.ts), [cli.ts](../../commerce/worker/src/cli.ts) | File adapter exists; synthetic CLI is not evidence of human funded settlement |
| Continuous proving telemetry | [engine.ts](../../commerce/worker/src/engine.ts) | Current subprocess wrapper buffers output and returns final cycles/time; live stages and cycle progress are not exposed |
| Presenter funding, replay, act-two orchestration | UI intent and source inspection | Agreed implementation scope; functioning features have not been established by this review |
| Business demand, cost advantage, production privacy | No interviews or commercial runs available | Unvalidated; technical tests cannot establish product-market fit |

The older README and shared plans contain superseded details. Use actual code and the dated Arc evidence for implemented behavior. In particular, do not reintroduce Circle's shared core, sealed-bid competitions, or a successful `ProofRejected` event from historical proposals.

## 3. Business use case and acceptance contract

Demo scenario: an operations lead asks for a verified invoice import bundle. The screen should explain the job before showing cryptography:

> “Deliver the invoice records in the required format. Include every approved invoice exactly once, preserve each amount to the cent, match the ledger total, and include the required report file.”

Use the real template and actual data, not a larger made-up workload. Show 3–4 invoice rows large enough to read if a separately validated fixture is prepared; otherwise retain the existing fixture's actual row count. Keep `result.json` and `report.txt` as the delivered files.

Before funding, show:

- The named files to deliver and source reference used for checking.
- Plain-language acceptance cards rendered from the engine preview.
- A good example and the exact one-cent failing example, evaluated by the checker.
- Actual quote, selected solver, testnet bounty, expiry, and the fact that the delivery becomes public on release.
- A clear approve/redraft choice. A changed revision invalidates prior approval and quote/funding eligibility as applicable.

Suggested rule-card wording, conditional on the actual approved plan: “Every invoice appears once,” “Each amount matches its reference,” “Totals match,” and “Report file is present.” Do not claim the report's prose is correct: the recorded Grok template checks its nonzero size. Also distinguish “rules accepted by the engine” from “business requirements fully captured.”

The one-cent failure is deliberately easy to understand. The viewer should see `expected amount`, `submitted amount`, and `difference: 0.01` in the diagnostic view. That detail must come from the actual local check/fixture; the settlement proof itself carries a verdict, not necessarily a detailed rule trace. Duplicate IDs can currently abort evaluation instead of producing verdict 0; use the proven one-cent case for act two and label engine errors separately.

## 4. Submitted video and the wow moment

### Agreed mode: fresh real execution, edited to 2–3 minutes (D1)

Screen-record one fresh passing run end to end at 1920×1080: English request, real Grok draft, engine validation/compile, buyer approval, quote selection, four real funding transactions, a new proof for that job, payout and decryption. Preserve the uninterrupted source recording and identifiers. The submitted video is 2–3 minutes; the underlying execution has no three-minute deadline.

Cut or time-lapse waits in the edit, always with an on-screen `time-lapse · real time m:ss` label showing the actual elapsed time. Retain the original proof duration, job IDs and transaction links. No prepared-proof shortcut or prove-without-submit runner split is required. Do not splice one job's authoring/funding into another job's proof or payout. A proof remains bound to its funded job/provider/rules/reference context.

Film act two in two parts for the same failing job: first its fresh tampered output, failed check and rejection preflight; later its refund after actual chain expiry. Identify the elapsed interval and retain that job's identity across the edit. Use at least 15 minutes for the failing job, longer if delays demand it, and 30–60 minutes for the passing job. The worker must still have at least 780 seconds remaining when it starts; 15 minutes is not a guarantee if earlier steps consume that margin.

| Edited-video time | Screen / action | Narration / evidence |
| --- | --- | --- |
| 0:00–0:20 | Business request and a small invoice table | “This job has a fixed deliverable. The buyer wants correct records; the supplier wants to get paid.” |
| 0:20–0:45 | Real Grok draft, engine checks, buyer approval and quote | “The model helps write the rules. The buyer approves the checks that actually control payment.” Label any omitted waiting time. |
| 0:45–1:00 | Four funding transactions and funded vault | Show the selected provider, real funding tx and confirmed escrow amount; compress waits with actual elapsed-time labels. |
| 1:00–1:35 | Fresh proof generation and submission | Indeterminate proving grid with real elapsed timer; final cycles and seal size only after completion. Show receipt-confirmed `ProofAccepted`, ciphertext still unopened. |
| 1:35–1:55 | Release; payout and key receipt; decrypt | Show `PaymentReleased` and `KeyReleased` from the same successful receipt. Verify commitments and authenticated decryption, then reveal the actual artifact. |
| 1:55–2:20 | Fresh failing job with dedicated tampered solver | One-cent error, genuine verdict 0, `VerificationFailed` preflight, escrow remains Funded. No transaction was sent for the failed submission. Label compressed waits. |
| 2:20–2:40 | Later capture: that failing job's refund | Show the same job ID, actual expiry, elapsed wait and refund receipt. Film only after real chain expiry. |
| 2:40–3:00 | Human eligibility and closing proposition | “The same checks can gate a human-prepared file; the human adapter is next.” Include a paid human example only if its own funded acceptance run passed before recording. |

The normal agent may submit and auto-release without a presenter pause. Explain the observed receipts through captions and animation; do not invent an intermediate payment state. A runner checkpoint for live narration is optional future booth work and is not on the submitted video's critical path.

### Why this moment lands

The vault connects three visible things: the buyer's funded amount, the proof of passing checks, and the supplier's deliverable. On a confirmed release, animate the money and key, then open the real file. At the end, leave the result table and receipt visible long enough to read. A tiny JSON scramble by itself does not demonstrate value.

Suggested close: “The same one-cent error that is easy to miss in a contractor handoff cannot collect this payment. The approved checker gates the payout.” This claim is about the demonstrated rule and run, not universal error detection.

Keep Claude's three-panel layout, central 3D vault, muted option, captions and full presenter controls: `Space` advances narration, `R` replays, `D` focuses act two, `M` mutes and `F` enters fullscreen (D2). `Space` never authorizes payment. Distinguish `LIVE · ARC TESTNET` during actual execution, `RECORDED RUN` during replay, and the required time-lapse label in the video edit. The proving grid is indeterminate with a real elapsed timer; final cycles and seal size appear only after `proof.finished`. Stage events wait for actual engine telemetry.

### Failure fallback

For live finals/booth use, if a network dependency stalls, announce and visibly switch to a recorded run. Show recorded timestamp, run ID and transaction links. Replay also supports video retakes, but any replay footage remains labeled and does not substitute for the required fresh source run. The animation can compress elapsed time while retaining actual duration. A replay must not send transactions, poll a signer, or show historical balances as current. Returning to live mode must re-read chain state before enabling actions.

## 5. Reconciliation with Claude's UI intent

All C1–C14 resolutions below are reconciled with Claude's Decisions section. They settle planning choices; associated implementation and evidence gates are still pending.

| ID | Conflict or dependency | Agreed resolution | Owner / consequence |
| --- | --- | --- | --- |
| C1 | GC's open bounty competition vs selected-provider backend | Keep open quoting, one selected solver, proof-gated payout. Open winner selection is roadmap. | Neil/Claude: product copy; no settlement rewrite |
| C2 | Fresh full flow plus two proofs within 180 seconds | D1: film fresh real execution, edit to a 2–3 minute video with labeled waits; no three-minute live-runtime requirement. | Resolved by Neil; Claude recording/UI |
| C3 | Approximately 11-minute expiry vs worker start budget | Standard agent requires 600 + 60 + 120 = 780 seconds remaining, plus delays. Use at least 15 minutes for the failing job and 30–60 minutes for the passing job; film the refund after real expiry. Never shrink safety margins. | Claude/Neil coordinator; actual admission check still controls |
| C4 | Live cycles and execute/prove/Groth16 stages | Real elapsed timer and indeterminate grid. Final `userCycles` and seal size only at `proof.finished`; no fabricated or interpolated live cycles/stages. | Anish for future telemetry; Claude can ship without it |
| C5 | Red proof animation could imply on-chain rejection event | Show “failed checker; submit preflight rejected; no transaction sent.” Distinguish RPC unavailable from a rejecting preflight. | Claude: event mapping/copy |
| C6 | Payout then key shown as separate actions | They come from the same successful release receipt. Narrative animation may sequence them, but state must record one atomic on-chain transition. | Claude |
| C7 | Human solver eligibility vs missing funded entry point | D3: describe human compatibility and adapter as next. Show paid human delivery only if its adapter and funded acceptance run pass before recording. | Optional gated slice; no separate solver product |
| C8 | Quote listing described as new work | It is already in HEAD with tests. Consume current response shape; do not create a duplicate endpoint. | Claude |
| C9 | Presenter toggle as signer protection | UI toggle selects mode; server startup flag, auth and transaction policy authorize use. Browser cannot enable a disabled signer. | Neil backend owner + Claude UI |
| C10 | “Private result” / generic business data | Current result becomes public when key is exposed; references are obtainable too. Use synthetic/shareable inputs. | Product copy; private delivery is later protocol work |
| C11 | Strong “trustless/frozen” language | No such escrow claims until Nick renounces admin roles and live reads confirm it; even then proof checking does not eliminate setup, code or specification trust. | Nick; pitch claim gate |
| C12 | Report quality and generic reconciliation claims | Show exactly what the template verifies. Current solver copies reference rows; commercial transformation value remains unvalidated. | Neil: use-case validation |
| C13 | Starting/controlling act two without affecting the automatic worker | Dedicated tampered solver identity with its own key: a third testnet account alongside Poster and honest solver. Explicitly select that provider for the failing job. | Coordinator implementation and testnet account provisioning |
| C14 | “Real Grok + proof + Arc” established as one UI flow | Evidence comes from separate recorded authoring and settlement runs; rehearse their integration before claiming an uninterrupted UI path. | End-to-end gate |

## 6. Agreed backend/UI additions

Claude adopted these additions in order: run events, constrained demo signer, recorded runs, then act-two orchestration. They are agreed work to build, not endpoints claimed to exist. Prefer a small local presenter adapter over a general workflow service. The four additions are required; the human adapter and live-booth runner split remain optional.

### 6.1 Reuse the existing public and authenticated flow

Continue using `POST /v1/drafts`, job creation/approval/compile, `GET /v1/jobs/:id/quotes`, quote selection, funding receipt, job status and submission status. Consume the SDK's chain reads, transaction requests and delivery codec. Quote listing returns `jobId`, `revisionHash`, and quotes with `quoteId`, `provider`, string `price`, `validUntil`, `selectable`, `status`, `createdAt`. Do not infer selection validity from `selectable` alone; the job state and server remain authoritative.

USDC values are integer units in API state; render with the correct six-decimal ERC-20 conversion. Show the actual 0.01 test-USDC payment if that is the run amount. A larger illustrative commercial price must be separately labeled. Wallet balance changes include gas, so receipt event amounts are the source for the payout and refund amount.

### 6.2 Run status and event bridge — minimum viable addition

Build `GET /v1/demo/runs/:runId` for a snapshot and `GET /v1/demo/runs/:runId/events?after=<seq>` for incremental events, polled every 1–2 seconds. The agent writes structured events; the API serves them through a sanitized adapter, not a browser-accessible attempt directory. SSE is later optional work.

Event envelope: `{runId, seq, jobId, chainJobId, source, type, at, data}`. `seq` is monotonically increasing within a run; `source` distinguishes worker, engine, chain, and replay. Include a snapshot version/cursor so reconnect does not duplicate animations. Example events:

- `quote.created`, `solver.started`, `proof.started`, `proof.finished` with final verdict, measured duration, cycles and seal bytes.
- `submission.broadcast`, `submission.confirmed`, `release.broadcast`, `release.confirmed` with transaction hashes and receipt-derived amounts.
- `submission.preflight_rejected`, `proof.failed`, `refund.available`, `refund.confirmed`, `delivery.verified`, `run.failed`.

`quoted` is not funded, `proof.finished` is not accepted, and `release.broadcast` is not paid. Chain events and successful receipts control financial state. Local events control animation and diagnostics. The run-event API never includes keys, plaintext or filesystem paths, including after payout; the existing submission/chain delivery path provides released delivery material. Auth tokens and private keys never enter exported telemetry. Final proof metrics exist today; stage events require real instrumentation.

Acceptance: reconnect reconstructs the same run; a replayed event cannot trigger a second transaction; missing telemetry never shows paid; RPC failure is distinct from rejected proof. No automatic retry may submit a financial operation without first checking its persisted transaction and chain state.

### 6.3 Demo signer — constrained Poster actions

Build `GET /v1/demo/capabilities` returning enabled state, chain ID, Poster address and permitted actions, without secrets, plus authenticated `POST /v1/demo/jobs/:id/fund` and `POST /v1/demo/jobs/:id/refund`. Off by default. Funding reads the approved selected quote server-side, executes/resumes only the four Poster funding calls, and registers its funding receipt. The separately agreed refund action allows only the job-scoped refund after checking actual chain expiry and refundable state. Neither action is a generic signing endpoint.

Both mutation routes require an idempotency key and return an operation ID with pending/confirmed/failed status and known transaction hashes. Persist each transaction before advancing. A failed HTTP response is not evidence that the transaction failed. Funding retries resume the same selected job instead of creating a new escrow.

Constraints: explicit server env flag; Arc testnet allowlist; local binding plus buyer authentication and origin checks; pinned contract targets; configured per-job and session budget; expiry policy; no arbitrary address/calldata/native-transfer signing. Disable the routes in normal mode. Keep the browser wallet path separate, and verify its connected address matches the Poster funding the job. The existing solver signer remains responsible for submit/release; the Poster demo signer must not silently impersonate the solver.

A UI toggle alone is insufficient. `Space` and `D` can reveal the next view; any transaction action needs its own deliberate presenter control. `R` never invokes this adapter.

### 6.4 Recorded-run artifact

Build a versioned JSON recording containing: run ID, capturedAt, source commit, chain ID/contracts, exact approved revision and hashes, non-secret input fixture, selected quote, chain job ID, measured proof metadata, ordered events, relevant receipt/log data, ciphertext/submission data, and the historical released key only after the recorded release event. Include enough data for offline authenticated decryption and byte verification. Delivery material comes from its dedicated chain/submission capture, not the sanitized run-event feed. Retain actual elapsed times and the link to the fresh screen-recorded source run for video retakes.

Recorder must export an explicit allowlist of fields. Do not copy `.env`, bearer tokens, private keys or the entire worker attempt directory. Validate the recording with the SDK and require a complete passing run plus a complete failure/refund run before declaring replay ready. A locally hashed recording is provenance and integrity assistance, not independent proof that all metadata is true.

### 6.5 Act-two coordinator

Create a separate fresh `tampered-reconciliation` job using the real one-cent solver variation and a dedicated solver key. Provision a third testnet account for this solver; the other two are the Poster and honest solver. Persist its job IDs, terms, selected provider, funding tx, proof verdict, preflight outcome and expiry. Explicitly select the tampered provider's quote so the honest agent cannot settle this assignment. Use existing refund script semantics rather than a new settlement mechanism.

`D` switches focus to that run and loads its true state. Use at least a 15-minute failing-job expiry, with enough headroom for 780 seconds remaining at worker admission; increase it if funding/polling delays require. Film rejection first, then film the same job's refund after real chain expiry. The refund action stays disabled until then. A previously completed/refunded job can be replayed, but cannot be refunded live again. Each fresh rehearsal needs a fresh job; retakes using replay must be labeled.

`runFunded` may keep its existing prove → submit → release flow. D1 removes the need for a runner split/checkpoint from the video. A prove-without-auto-submit or presenter-pause capability is optional live-booth work only; it must not delay recording the approved fresh flow.

## 7. Human participation: smallest credible slice

D3 makes the human adapter optional for this submission. The default video says the same checks can gate a human-prepared file and the adapter is next. If the main agent demo is stable and time permits, add a local file path that provides `filesSolver(dir)` to the same funded runner. The human uses the selected solver wallet, produces the declared output files, runs the checker, then proves and settles through the existing constraints. The code does not need to know whether Excel, a script, or an AI assistant produced the files.

Acceptance gate: one human-prepared passing file bundle receives the correct testnet payment and is recovered byte-for-byte; a one-cent edit is rejected; an unselected provider cannot settle it. Record the provenance honestly. Until this is done, present human support as architectural eligibility and planned adapter work, not a completed human marketplace.

The current `prove-synthetic --solver files:<dir>` command is useful for preparation but cannot satisfy this gate. Do not demo it as real paid work.

## 8. Build sequence, dependencies and completion criteria

Owner suggestions refer to the existing team, not newly spawned agents. Planning reconciliation is complete in this document; this update performs no implementation. Required backend additions follow Claude's agreed order: events → signer → recordings → act two. Optional work cannot block the submitted video.

| Slice | Owner / depends on | Deliverable and acceptance | Verification |
| --- | --- | --- | --- |
| 0. Reconcile product and demo mode — complete | Neil + Claude + Codex; none | D1–D4 recorded in UI intent and applied here; C1–C14 reconciled | Source Decisions and this revision's resolution table |
| 1. Freeze one acceptance template | Neil + Anish; 0 | Real good/one-cent-bad outputs, declared checks and approved hashes; one understandable customer story | `engine eval` and compile on actual fixtures; checker-error case distinguished |
| 2. Connect existing buyer flow | Claude; 1 | Request/approval/quote/funding/status/decryption views consume current API; stale revisions cannot fund | Existing API tests plus one end-to-end UI run |
| 3. Expose worker observations | Neil backend owner + Claude; 1 | Snapshot/cursor bridge, real proof completion metrics, receipt-driven status | Disconnect/reconnect, duplicate events, failed preflight and delayed indexer scenarios |
| 4. Constrained demo funding | Neil backend owner; 2–3 | Explicitly enabled Poster funding/refund actions; resume after partial four-tx flow | Disabled mode denied, wrong chain/target/budget denied, duplicate request sends no duplicate operation |
| 5. Recorded-run capture and replay | Claude + Neil; 2–4 | Versioned capture/replay with allowlisted fields, offline delivery verification and no signer calls | Passing-run replay; final failure/refund capture is added after slice 6 |
| 6. Act-two orchestration and fresh capture | Neil + Nick + Claude; 1–5 | Third testnet account and selected tampered solver; fresh failing run; same-job refund filmed after expiry | Provider isolation, admission headroom, rejecting preflight and real refund receipt; complete failure/refund replay |
| 7. Human file adapter | Neil; 1–4, only if time allows | Human passing/rejected runs under same payment rules | Dedicated funded run evidence, not only synthetic CLI |
| 8. Rehearse, record and edit the submission | Claude + Neil; 2–6 | Full presenter controls; readable 1080p UI; fresh uninterrupted passing source run; final 2–3 minute edit with labeled waits and act-two expiry gap | Three successful full-flow rehearsals with actual duration recorded, edited-video duration check, source/receipt traceability and fallback drill |

These slices should be split into small code changes by the implementation owner; keep backend contracts agreed before wiring the UI. Avoid combining a new telemetry transport, new solver UI, and signer changes in one patch.

Suggested schedule from Nov 16: reconcile and freeze the template on Nov 16; integrate the core presentation and recording on Nov 17; run timing/failure rehearsals Nov 18; use Nov 19 for fixes, video and submission preparation. Official submission is **Nov 20 at noon CST / 1 p.m. EST**, with finals Nov 21. The submission asks for a working demo, public repository, README and 2–3 minute video. Product/UX, technical execution, innovation, impact and demo all matter; no weighting was established here. [Official Devpost](https://ubc-hackathon-2026.devpost.com/)

Keep the existing team's two-domain technical acceptance requirement unless the team explicitly revises it. Only one domain needs to occupy the central three-minute product narrative. Do not quietly drop technical gates because the pitch focuses on one use case.

Cut optional scope in this order if behind: extra sound/particles; additional quote actors beyond the required honest/tampered identities; funded human showcase; additional live domain presentation; optional sponsor integrations. Interpolated cycles are excluded by C4, not a feature to build or later cut. Preserve full presenter controls (D2), the four backend additions, fresh execution evidence, labeled video edits and recorded fallback. Use a lightweight 2D vault fallback if 3D fails the laptop performance target; benchmark before changing the confirmed design.

## 9. Viability tests and evidence from this review

### Checks executed by Codex

Existing tests were run without editing application source. Initial sandbox runs failed before execution because Vitest could not write its temporary config. Authorized reruns outside the sandbox passed:

| Command (from the stated package) | Result | What it establishes |
| --- | --- | --- |
| worker: `corepack pnpm exec vitest run test/unit/agent.test.ts test/unit/funded.test.ts test/unit/xval-funded-run.test.ts --no-cache` | **85 passed, 3 files** | Quotes within budget; funded-context checks; verdict-0 no-submit behavior; expiry and crash/resume protections |
| api: `corepack pnpm exec vitest run test/spec/t7-quotes.test.ts test/spec/t7-list-quotes.test.ts test/spec/t8-funding.test.ts test/spec/t11-submission.test.ts test/spec/approve.test.ts --no-cache` | **81 passed, 5 files** | Quote validation/listing, approval, funding linkage and indexed submission response behavior |

**Total: 166 focused tests passed.** These suites use test doubles; they do not newly establish live proving, blockchain settlement, UI performance, human settlement or customer demand. Real chain/proof claims above are attributed to the repository's November 15 evidence, not a fresh live run by Codex.

### Concrete feasibility findings

1. **Fresh execution exceeds three minutes; D1 resolves the presentation limit:** 126.4 + 118.7 = 245.1 seconds of proving alone exceeds 180 seconds by 65.1 seconds. Execute for the real required duration and edit the submitted video to 2–3 minutes with `time-lapse · real time m:ss` labels. Prepared proofs are not required.
2. **Eleven-minute expiry fails the standard worker admission check:** 660 seconds is below the 780-second reserve, even before polling/funding delays. This is derived directly from `scripts/agent.ts` and `funded.ts`.
3. **Human artifact compatibility is plausible, funded UX unproven:** same `Solver` return type accepts local files; current synthetic CLI does not settle real jobs. A funded adapter is small relative to a second marketplace, but still needs its own acceptance run.
4. **A real refund cannot be accelerated by an animation:** expiry is chain state. D1 records rejection and then the same job's refund after real expiry, joining those captures with the actual elapsed wait labeled.
5. **Proof does not imply rich business quality:** the current record-copy fixture is trivial and the report check is shallow. A useful future template must verify the properties the customer actually cares about.

### Rehearsal acceptance checklist — pending implementation

- [ ] Passing path opens the exact named files only after confirmed release and successful commitment/authenticated-decryption checks.
- [ ] Bad amount produces a failed check and no payout; the screen distinguishes a checked failure, engine error, RPC error and expired job.
- [ ] Payout shown equals receipt amount; gas is not confused with bounty value.
- [ ] Presenter signer is unavailable by default and cannot sign arbitrary requests.
- [ ] Replayed events and repeated clicks cannot repeat funding, submit, release or refund.
- [ ] Indexer lag shows “awaiting confirmation/indexing,” never invented success.
- [ ] Three full-flow rehearsals succeed with actual execution durations recorded; no 180-second live-runtime gate applies.
- [ ] Preserve a fresh uninterrupted 1080p passing source recording from English request through Grok, engine, four funding transactions, proof, payout and decrypt.
- [ ] Final submitted video is 2–3 minutes; every cut/time-lapsed wait carries `time-lapse · real time m:ss`, and job/transaction identity stays consistent.
- [ ] Act two uses a third testnet account and dedicated selected tampered solver; rejection and later refund footage refer to the same job and genuine expiry.
- [ ] Space, R, D, M, F and captions remain functional for live use and replay retakes; replay footage is labeled.
- [ ] Proving under load does not make the UI unreadable or prevent controls; measure the 60-fps target on the actual laptop.
- [ ] Offline replay reproduces a complete real recorded run with a persistent replay label.
- [ ] Nick confirms current admin-role/freeze state before any immutability claim.
- [ ] Human-adapter copy says “next” by default; include paid human delivery only if the optional adapter passes its separate funded acceptance run before recording.

## 10. Commercial validation and the defensible product story

Technical feasibility is substantially better established than business viability. The biggest commercial risks are task triviality, writing adequate rules, confidentiality, and proving cost. Do not turn the fixture into invented customer traction.

Proposed discovery work for Neil: speak with three data/software agency operators and two independent contractors. Ask for a recent fixed-deliverable job, the actual acceptance checklist, how long verification took, what was disputed, whether input/output can be shared, and whether the job repeats. Ask permission to use a sanitized real example; do not send messages automatically as part of this plan.

Suggested go/no-go gates, explicitly hypotheses:

- At least two buyers identify a repeated task and can express acceptance without subjective review.
- At least one supplies a shareable fixture and agrees to try a pilot; interest alone is not willingness to pay.
- At least two suppliers find selected-provider proof-gated payment acceptable, including proving time and fees.
- An independently prepared output passes the same template; a superficially plausible but wrong output fails.
- Measure specification/setup time, production time, verification time, prove time/cost, gas, retries and support. Compare against the buyer's existing method.

If checking takes as much work as doing the job, if the buyer needs confidentiality this design cannot provide, or if a normal script solves the entire task cheaply, choose another template/customer. Longer-term privacy needs more than moving a key off the screen: public ciphertext plus a public release key is public delivery.

Start with a curated service and a few repeatable templates, not a cold-start public marketplace. Seed both demand and two capable suppliers for the same template. Monetization hypothesis: a fee per successful delivery plus separately disclosed proving/compute charges, tested against actual cost; avoid choosing a percentage before measuring unit economics. The 0.01 test-USDC payout proves plumbing, not a sustainable price.

Do not claim “first bounty platform” or “first agent bounty platform.” Existing offerings already advertise agent bounties, submission review and on-chain payments; their presence means the differentiation must be demonstrated in the approved-checker/proof/delivery path. [Elgora](https://elgora.ai/) and [make.fun's own guide](https://make.fun/guide/ai-agent-bounties) provide current competitive context, not an independently audited comparison.

Why blockchain here: the funded escrow and release rules are executed on-chain, and the payer's manual approval is not required after the defined proof conditions are satisfied. Why ZK here: show that an encrypted artifact satisfies the approved checker before its contents are revealed. Be precise about limits: source truth and specification adequacy remain outside the proof; contract/verifier correctness and deployment controls matter; the public release transaction exposes the key. Do not promise private delivery or absolute fair exchange under failed/reverted key broadcasts.

Recommended track is **Agentic Payments & AI**, with Arc as the chain award, because the existing solver discovers jobs, signs quotes and executes constrained payment/delivery actions. Humans can remain eligible. This is an inference from the implemented flow and the official track descriptions, not a prize or eligibility guarantee. [Official UBC tracks](https://www.universityblockchain.org/programs/hackathon)

## 11. Reconciled decisions and implementation handoff

Claude's Decisions section records Neil's confirmation. Codex has applied those decisions to the product narrative, video script, C1–C14 resolution table, backend contracts, build sequence and verification gates. No further product-choice response is needed for these four decisions:

| Decision | Agreed scope | Applied here |
| --- | --- | --- |
| D1 | Submitted 2–3 minute video from fresh real execution at 1080p; labeled edits/time-lapses; rejection and refund filmed across actual expiry | §4 video script, §6.5 act two, §8 recording task, §9 gates |
| D2 | Full Space/R/D/M/F presenter controls and captions retained for finals, booth and replay retakes | §4 controls/fallback, §8 protected scope, §9 checklist |
| D3 | Human-compatible checks; adapter described as next; paid human delivery only after its optional funded acceptance run passes before recording | Opening direction, §7 human scope, §9 claim gate |
| D4 | Verified data deliverables on public/shareable inputs; private delivery is future work | Opening direction, §1 target customer, C10, §10 commercial limits |

All fourteen conflict resolutions are accepted as recorded in §5. The prior recommendation to prepare proofs for a timed live pitch is superseded by D1. A runner split is optional live-booth work, and the 11-minute expiry and fabricated/interpolated cycle display are excluded.

**Next implementation order for Claude and the existing backend owners:** structured polled run events → constrained demo signer → versioned recordings/replay → dedicated tampered-solver act two. Integrate those with the existing buyer flow, rehearse the uninterrupted path, then record and edit the submission. Provision a third testnet account for act two; use at least 15 minutes with admission headroom for its expiry and 30–60 minutes for the passing job. This plan update does not create accounts, move funds or edit application code.

**Remaining gates are implementation/evidence work, not unresolved product choices:** fresh integrated UI run, telemetry and signer/replay tests, actual expiry refund, laptop performance, edited-video/source audit, and Nick's live admin-role confirmation before stronger escrow claims. The human funded run applies only if the optional showcase is included. Customer demand and commercial economics remain unvalidated, as §10 explains.

**Handoff state:** Product-plan reconciliation complete. Claude can use this updated plan alongside the Decisions section as the implementation handoff. Only `agents/neil/product-plan.md` was edited by Codex; ownership of `ui-intent.md` and application source remains unchanged. The earlier 166-test result is preserved as prior evidence, not a claim that the planned additions have passed tests.
