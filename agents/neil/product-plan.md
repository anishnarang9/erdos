# Product plan and Claude handoff

## 2026-11-16 02:31 -05:00 — Codex — Proposed, ready for reconciliation

**Status:** Proposal grounded in the current working tree and focused tests. This is not an agreed scope change. Claude owns [ui-intent.md](ui-intent.md) and its Decisions section; Codex owns this file. No application source was changed. Per Neil's explicit handoff rule, status, shared-plan, and implementation updates stay inside this document until reconciliation.

**Reviewed:** branch `neil/plan-architecture`, HEAD `434dd22`; `ui-intent.md` SHA-256 `52c991ce178862979bb60c9be27f4d94e4e92ace5ab4f81720b159270612ba47`. The working tree already contained UI work and pnpm changes; those belong to the existing work and were left untouched. The local repository's origin is `https://github.com/anishnarang9/UBC-26`. The group-chat evidence reviewed is Neil's pasted discussion, also present in his earlier Codex thread; no additional external chat history was accessed.

**Recommendation:** Keep humans eligible and lead with agent commerce. Sell **payment for a specified, verifiable deliverable**. For this hackathon, demonstrate a buyer commissioning a reconciliation result from an autonomous solver, with the same proof and settlement requirements applicable to a human-prepared file. Preserve the current selected-provider flow. An open competition where anyone can claim the bounty is a later marketplace design.

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
| Presenter funding, replay, act-two orchestration | UI intent and source inspection | Proposed additions, not functioning features established by this review |
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

## 4. Three-minute demo and the wow moment

### Recommended mode: prepared jobs, live settlement, explicit provenance

Two fresh proofs alone took 245.1 seconds in the recorded runs. A full cold start additionally needs Grok, compile, quotes, four funding transactions, submit, release, indexing and decryption. A three-minute guarantee for two entirely fresh jobs is not viable with those measurements.

Keep a longer end-to-end live walkthrough for the booth. For the timed pitch, prepare **real funded jobs and proofs beforehand**, label that preparation, and perform submit/release live. A proof is bound to its funded job/provider/rules/reference context; it cannot be reused for a newly created stage job. The rule-creation walkthrough must not imply it produced the already-prepared proof.

| Time | Screen / action | Narration / evidence |
| --- | --- | --- |
| 0:00–0:20 | Business request and a small invoice table | “This job has a fixed deliverable. The buyer wants correct records; the supplier wants to get paid.” |
| 0:20–0:45 | Approved rule cards, checker examples, quote | “The model helps write the rules. The buyer approves the checks that actually control payment.” Show saved prepared-job inputs if using that run. |
| 0:45–1:00 | Funded vault, chosen provider, encrypted artifact | “This testnet job was funded and proved before the talk.” Show real funding tx and measured proof time. |
| 1:00–1:35 | Submit real prepared proof; vault verifies | Show receipt-confirmed `ProofAccepted`, actual seal length, and ciphertext still unopened. |
| 1:35–1:55 | Release; payout and key receipt; decrypt | Show `PaymentReleased` and `KeyReleased` from the same successful receipt. Verify commitments and authenticated decryption, then reveal the actual artifact. |
| 1:55–2:20 | Switch to a separately prepared failing job | One-cent error, genuine verdict 0, preflight rejection, escrow remains Funded. No invented rejection transaction. |
| 2:20–2:40 | Refund an already expired failing job | Show actual chain time/expiry and refund receipt. If not yet expired, show pending refund or use clearly labeled recorded evidence. |
| 2:40–3:00 | Human eligibility and closing proposition | “The same checks can gate a human-prepared file or an agent's output.” Show a real human run only if its separate acceptance gate passed. |

Allow a presenter dwell between proof acceptance and release in the prepared-run coordinator. The normal agent auto-releases; do not imply it already pauses here. The alternate simplest implementation is to let it run and use animation to explain the two observed receipts without inventing a pause in chain state.

### Why this moment lands

The vault connects three visible things: the buyer's funded amount, the proof of passing checks, and the supplier's deliverable. On a confirmed release, animate the money and key, then open the real file. At the end, leave the result table and receipt visible long enough to read. A tiny JSON scramble by itself does not demonstrate value.

Suggested close: “The same one-cent error that is easy to miss in a contractor handoff cannot collect this payment. The approved checker gates the payout.” This claim is about the demonstrated rule and run, not universal error detection.

Keep Claude's three-panel layout, central 3D vault, keyboard controls, muted option, and color/icon semantics. Use a persistent `LIVE · ARC TESTNET`, `PREPARED JOB · LIVE SETTLEMENT`, or `RECORDED RUN` indicator. `Space` changes narration, never payment authorization. The proof animation may be decorative while waiting; it must not fabricate measured stages or cycles.

### Failure fallback

If a network dependency stalls, announce and visibly switch to a recorded run. Show recorded timestamp, run ID and transaction links. The animation can compress elapsed time, but retain the actual prove duration and mark accelerated playback. A replay must not send transactions, poll a signer, or show historical balances as current. Returning to live mode must re-read chain state before enabling actions.

## 5. Reconciliation with Claude's UI intent

| ID | Conflict or dependency | Proposed resolution | Owner / consequence |
| --- | --- | --- | --- |
| C1 | GC's open bounty competition vs selected-provider backend | Keep open quoting, one selected solver, proof-gated payout. Open winner selection is roadmap. | Neil/Claude: product copy; no settlement rewrite |
| C2 | Fresh full flow plus two proofs within 180 seconds | Use prepared jobs/live settlement for timed pitch, extended live run for booth; explicit labels. | Neil decision needed because it changes confirmed demo intent |
| C3 | Approximately 11-minute expiry vs worker start budget | Standard agent requires 600 + 60 + 120 = 780 seconds remaining, plus arrival delay. Use 30–60 minutes for successful jobs; prepare failing job early enough to expire before its refund beat. Do not shrink safety margins to fit narration. | Claude/Neil coordinator; Nick confirms deployed expiry behavior |
| C4 | Live cycles and execute/prove/Groth16 stages | Emit only real known milestones; elapsed timer and indeterminate grid until instrumentation exists. Show final `userCycles` after completion. If using estimates, label them explicitly. | Anish for telemetry; Claude can ship without it |
| C5 | Red proof animation could imply on-chain rejection event | Show “failed checker; submit preflight rejected; no transaction sent.” Distinguish RPC unavailable from a rejecting preflight. | Claude: event mapping/copy |
| C6 | Payout then key shown as separate actions | They come from the same successful release receipt. Narrative animation may sequence them, but state must record one atomic on-chain transition. | Claude |
| C7 | Human solver eligibility vs missing funded entry point | Reuse `filesSolver` through `runFunded` with selected provider; add a small local adapter only after reconciliation. No separate solver product. | Neil/Claude: scope choice and later implementation |
| C8 | Quote listing described as new work | It is already in HEAD with tests. Consume current response shape; do not create a duplicate endpoint. | Claude |
| C9 | Presenter toggle as signer protection | UI toggle selects mode; server startup flag, auth and transaction policy authorize use. Browser cannot enable a disabled signer. | Neil backend owner + Claude UI |
| C10 | “Private result” / generic business data | Current result becomes public when key is exposed; references are obtainable too. Use synthetic/shareable inputs. | Product copy; private delivery is later protocol work |
| C11 | Strong “trustless/frozen” language | Deployment manifest and past status differ on admin renunciation. Recheck live roles before claiming immutable escrow. Proof checking does not eliminate setup, code or specification trust. | Nick; pitch claim gate |
| C12 | Report quality and generic reconciliation claims | Show exactly what the template verifies. Current solver copies reference rows; commercial transformation value remains unvalidated. | Neil: use-case validation |
| C13 | Starting/controlling act two without affecting the automatic worker | Dedicated scenario/run IDs and solver identity or routing; prevent the regular good solver from taking the tamper job. | Coordinator implementation |
| C14 | “Real Grok + proof + Arc” established as one UI flow | Evidence comes from separate recorded authoring and settlement runs; rehearse their integration before claiming an uninterrupted UI path. | End-to-end gate |

## 6. Backend/UI contract proposal

These are suggested contracts for reconciliation, not endpoints claimed to exist. Prefer a small local presenter adapter over turning this into a general workflow service.

### 6.1 Reuse the existing public and authenticated flow

Continue using `POST /v1/drafts`, job creation/approval/compile, `GET /v1/jobs/:id/quotes`, quote selection, funding receipt, job status and submission status. Consume the SDK's chain reads, transaction requests and delivery codec. Quote listing returns `jobId`, `revisionHash`, and quotes with `quoteId`, `provider`, string `price`, `validUntil`, `selectable`, `status`, `createdAt`. Do not infer selection validity from `selectable` alone; the job state and server remain authoritative.

USDC values are integer units in API state; render with the correct six-decimal ERC-20 conversion. Show the actual 0.01 test-USDC payment if that is the run amount. A larger illustrative commercial price must be separately labeled. Wallet balance changes include gas, so receipt event amounts are the source for the payout and refund amount.

### 6.2 Run status and event bridge — minimum viable addition

Propose `GET /v1/demo/runs/:runId` for a snapshot and `GET /v1/demo/runs/:runId/events?after=<seq>` for incremental events. Authenticated polling every 1–2 seconds is enough initially; SSE is optional once the same event model works. Read structured worker state through a sanitized adapter, not a browser-accessible attempt directory.

Event envelope: `{runId, seq, jobId, chainJobId, source, type, at, data}`. `seq` is monotonically increasing within a run; `source` distinguishes worker, engine, chain, and replay. Include a snapshot version/cursor so reconnect does not duplicate animations. Example events:

- `quote.created`, `solver.started`, `proof.started`, `proof.finished` with final verdict, measured duration, cycles and seal bytes.
- `submission.broadcast`, `submission.confirmed`, `release.broadcast`, `release.confirmed` with transaction hashes and receipt-derived amounts.
- `submission.preflight_rejected`, `proof.failed`, `refund.available`, `refund.confirmed`, `delivery.verified`, `run.failed`.

`quoted` is not funded, `proof.finished` is not accepted, and `release.broadcast` is not paid. Chain events and successful receipts control financial state. Local events control animation and diagnostics. Do not leak a release key, plaintext result, auth token, private path or private key before its intended disclosure. Final proof metrics exist today; stage events require real instrumentation.

Acceptance: reconnect reconstructs the same run; a replayed event cannot trigger a second transaction; missing telemetry never shows paid; RPC failure is distinct from rejected proof. No automatic retry may submit a financial operation without first checking its persisted transaction and chain state.

### 6.3 Demo signer — constrained Poster actions

Propose `GET /v1/demo/capabilities` returning enabled state, chain ID, Poster address and permitted actions, without secrets. Propose authenticated `POST /v1/demo/jobs/:id/fund` and `POST /v1/demo/jobs/:id/refund`. Funding reads the approved selected quote server-side, executes/resumes the existing four-transaction sequence, and registers its funding receipt. Refund first checks actual chain expiry and refundable state.

Both mutation routes require an idempotency key and return an operation ID with pending/confirmed/failed status and known transaction hashes. Persist each transaction before advancing. A failed HTTP response is not evidence that the transaction failed. Funding retries resume the same selected job instead of creating a new escrow.

Constraints: explicit server env flag; Arc testnet allowlist; local binding plus buyer authentication and origin checks; pinned contract targets; configured per-job and session budget; expiry policy; no arbitrary address/calldata/native-transfer signing. Disable the routes in normal mode. Keep the browser wallet path separate, and verify its connected address matches the Poster funding the job. The existing solver signer remains responsible for submit/release; the Poster demo signer must not silently impersonate the solver.

A UI toggle alone is insufficient. `Space` and `D` can reveal the next view; any transaction action needs its own deliberate presenter control. `R` never invokes this adapter.

### 6.4 Recorded-run artifact

Propose a versioned JSON recording containing: run ID, capturedAt, source commit, chain ID/contracts, exact approved revision and hashes, non-secret input fixture, selected quote, chain job ID, measured proof metadata, ordered events, relevant receipt/log data, ciphertext/submission data, and the historical released key only after the recorded release event. Include enough data for offline authenticated decryption and byte verification.

Recorder must export an explicit allowlist of fields. Do not copy `.env`, bearer tokens, private keys or the entire worker attempt directory. Validate the recording with the SDK and require a complete passing run plus a complete failure/refund run before declaring replay ready. A locally hashed recording is provenance and integrity assistance, not independent proof that all metadata is true.

### 6.5 Act-two coordinator

Prepare a separate `tampered-reconciliation` job using the real one-cent solver variation. Persist its job IDs, terms, funding tx, proof verdict, preflight outcome and expiry. Coordinate it so the normal auto-solver cannot replace its intended actor. Use existing refund script semantics rather than a new settlement mechanism.

`D` switches focus to that run and loads its true state. A dedicated refund action is enabled only after chain expiry. Record a backup refund run. A previously completed/refunded job can be replayed, but it cannot be refunded live again. Rehearsal must prepare a fresh job or choose replay explicitly each time.

Preparing proofs without auto-submitting them needs a small runner split/checkpoint; `runFunded` currently combines prove, submit and release. This is a real implementation dependency, not an existing presenter feature. If it costs too much, show the recorded proof phase and let a standard full run execute during the longer booth demonstration.

## 7. Human participation: smallest credible slice

After the main agent demo is stable, add a local “human-prepared files” path that provides `filesSolver(dir)` to the same funded runner. The human uses the selected solver wallet, produces the declared output files, runs the checker, then proves and settles through the existing constraints. The code does not need to know whether Excel, a script, or an AI assistant produced the files.

Acceptance gate: one human-prepared passing file bundle receives the correct testnet payment and is recovered byte-for-byte; a one-cent edit is rejected; an unselected provider cannot settle it. Record the provenance honestly. Until this is done, present human support as architectural eligibility and planned adapter work, not a completed human marketplace.

The current `prove-synthetic --solver files:<dir>` command is useful for preparation but cannot satisfy this gate. Do not demo it as real paid work.

## 8. Build sequence, dependencies and completion criteria

Owner suggestions refer to the existing team, not newly spawned agents. No task below authorizes code changes before the two planning files are reconciled.

| Slice | Owner / depends on | Deliverable and acceptance | Verification |
| --- | --- | --- | --- |
| 0. Reconcile product and demo mode | Neil + Claude; none | Decisions recorded in UI intent; selected-provider model and accurate claims agreed | Compare each C-item and mark accepted/deferred in this document on follow-up |
| 1. Freeze one acceptance template | Neil + Anish; 0 | Real good/one-cent-bad outputs, declared checks and approved hashes; one understandable customer story | `engine eval` and compile on actual fixtures; checker-error case distinguished |
| 2. Connect existing buyer flow | Claude; 1 | Request/approval/quote/funding/status/decryption views consume current API; stale revisions cannot fund | Existing API tests plus one end-to-end UI run |
| 3. Expose worker observations | Neil backend owner + Claude; 1 | Snapshot/cursor bridge, real proof completion metrics, receipt-driven status | Disconnect/reconnect, duplicate events, failed preflight and delayed indexer scenarios |
| 4. Constrained demo funding | Neil backend owner; 2 | Explicitly enabled Poster funding/refund actions; resume after partial four-tx flow | Disabled mode denied, wrong chain/target/budget denied, duplicate request sends no duplicate operation |
| 5. Record and replay evidence | Claude + Neil; 2–3 | Offline passing run and failing/refund run; clear recorded label; no signer calls | Network off; replay completes with identical artifact hashes and no writes to chain |
| 6. Prepare timed demo jobs | Neil + Nick; 1–5 | Successful job/proof ready with ample expiry; failing job ready for refund; pause behavior explicit | Stopwatch rehearsal and actual chain checks; no reused proof on a new job |
| 7. Human file adapter | Neil; 1–4, only if time allows | Human passing/rejected runs under same payment rules | Dedicated funded run evidence, not only synthetic CLI |
| 8. Visual polish and presentation | Claude + Neil; 2–6 | Readable 1080p layout, measured animation performance, narration and one-page pitch | Three consecutive timed rehearsals; laptop running prover; fallback drill |

These slices should be split into small code changes by the implementation owner; keep backend contracts agreed before wiring the UI. Avoid combining a new telemetry transport, new solver UI, and signer changes in one patch.

Suggested schedule from Nov 16: reconcile and freeze the template on Nov 16; integrate the core presentation and recording on Nov 17; run timing/failure rehearsals Nov 18; use Nov 19 for fixes, video and submission preparation. Official submission is **Nov 20 at noon CST / 1 p.m. EST**, with finals Nov 21. The submission asks for a working demo, public repository, README and 2–3 minute video. Product/UX, technical execution, innovation, impact and demo all matter; no weighting was established here. [Official Devpost](https://ubc-hackathon-2026.devpost.com/)

Keep the existing team's two-domain technical acceptance requirement unless the team explicitly revises it. Only one domain needs to occupy the central three-minute product narrative. Do not quietly drop technical gates because the pitch focuses on one use case.

Cut scope in this order if behind: interpolated cycles; elaborate sound/particles; second quote actor; funded human showcase; additional live domain; optional sponsor integrations. Preserve a truthful, readable proof/payment/delivery path and recorded fallback. Use a lightweight 2D vault fallback if 3D fails the laptop performance target; benchmark before changing the confirmed design.

## 9. Viability tests and evidence from this review

### Checks executed by Codex

Existing tests were run without editing application source. Initial sandbox runs failed before execution because Vitest could not write its temporary config. Authorized reruns outside the sandbox passed:

| Command (from the stated package) | Result | What it establishes |
| --- | --- | --- |
| worker: `corepack pnpm exec vitest run test/unit/agent.test.ts test/unit/funded.test.ts test/unit/xval-funded-run.test.ts --no-cache` | **85 passed, 3 files** | Quotes within budget; funded-context checks; verdict-0 no-submit behavior; expiry and crash/resume protections |
| api: `corepack pnpm exec vitest run test/spec/t7-quotes.test.ts test/spec/t7-list-quotes.test.ts test/spec/t8-funding.test.ts test/spec/t11-submission.test.ts test/spec/approve.test.ts --no-cache` | **81 passed, 5 files** | Quote validation/listing, approval, funding linkage and indexed submission response behavior |

**Total: 166 focused tests passed.** These suites use test doubles; they do not newly establish live proving, blockchain settlement, UI performance, human settlement or customer demand. Real chain/proof claims above are attributed to the repository's November 15 evidence, not a fresh live run by Codex.

### Concrete feasibility findings

1. **Timed cold-start demo fails the current budget:** 126.4 + 118.7 = 245.1 seconds of proving alone exceeds 180 seconds by 65.1 seconds. Prepared/live-settlement mode or recorded segments are necessary for a reliable three-minute pitch.
2. **Eleven-minute expiry fails the standard worker admission check:** 660 seconds is below the 780-second reserve, even before polling/funding delays. This is derived directly from `scripts/agent.ts` and `funded.ts`.
3. **Human artifact compatibility is plausible, funded UX unproven:** same `Solver` return type accepts local files; current synthetic CLI does not settle real jobs. A funded adapter is small relative to a second marketplace, but still needs its own acceptance run.
4. **A real refund cannot be accelerated by an animation:** expiry is chain state. Prepare early or label a recorded refund.
5. **Proof does not imply rich business quality:** the current record-copy fixture is trivial and the report check is shallow. A useful future template must verify the properties the customer actually cares about.

### Rehearsal acceptance checklist — pending implementation

- [ ] Passing path opens the exact named files only after confirmed release and successful commitment/authenticated-decryption checks.
- [ ] Bad amount produces a failed check and no payout; the screen distinguishes a checked failure, engine error, RPC error and expired job.
- [ ] Payout shown equals receipt amount; gas is not confused with bounty value.
- [ ] Presenter signer is unavailable by default and cannot sign arbitrary requests.
- [ ] Replayed events and repeated clicks cannot repeat funding, submit, release or refund.
- [ ] Indexer lag shows “awaiting confirmation/indexing,” never invented success.
- [ ] Three consecutive timed rehearsals finish within 180 seconds using the declared mode.
- [ ] Proving under load does not make the UI unreadable or prevent controls; measure the 60-fps target on the actual laptop.
- [ ] Offline replay reproduces a complete real recorded run with a persistent replay label.
- [ ] Nick confirms current admin-role/freeze state before any immutability claim.
- [ ] A separate funded human run passes before claiming shipped human participation.

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

## 11. Proposed decisions for Claude to reconcile

Claude: please read this plan, compare with your intent file, and record agreed points in **your** Decisions section. Do not implement from this proposal until the handoff is reconciled. Codex will update this file after reading your decisions.

Proposed defaults that fit existing architecture:

1. Human-eligible product; agent solver is the main demonstration.
2. Selected provider after quotes; no open winner race this week.
3. Synthetic/shareable reconciliation fixture; exact, limited quality claims.
4. Preserve the three-panel design and hero reveal, driven by real receipts.
5. Use polled structured run events first; final measured cycles, no fabricated live progress.
6. Constrain the demo signer on the server; browser toggle never grants authority.
7. Record genuine passing and rejected/refunded runs; replay is explicit and incapable of signing.
8. Treat human funded file submission as a separate gated slice, not a second product UI.

Bring these product choices to Neil if your reconciliation cannot resolve them:

- **Demo mode:** accept prepared jobs/live settlement for the three-minute pitch, or allow a longer fully fresh live run? Recommended: timed prepared mode plus full booth walkthrough.
- **Human scope:** require a real funded human-file showcase this week, or keep it as demonstrated artifact compatibility and the next adapter? Recommended: include only after the primary demo and fallback are reliable.
- **Buyer positioning:** accept public/shareable data validation as the initial customer hypothesis? Private accounting work would require a delivery redesign beyond this week's UI.

**Handoff state:** Ready for Claude's review. No entries in `ui-intent.md` were edited by Codex. No agreed Decisions have been invented. The next work is reconciliation, then the scoped implementation and live rehearsal gates above.
