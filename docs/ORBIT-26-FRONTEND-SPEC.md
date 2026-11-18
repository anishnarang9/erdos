# ORBIT-26 — frontend build and integration spec

**Status:** Frontend handoff, November 17, 2026. This document defines the preset demo first and the public product integration that follows. It does not claim that the hosted buyer API is ready. The [demo checklist](demo-launch-checklist-2026-11-18.md) tracks the launch work.

## Product promise and boundaries

Show how a buyer approves exact checks for a small, structured deliverable. An agent prepares files, proves they pass those checks, and receives testnet USDC after the proof and key release succeed on Arc. A proof establishes the approved predicates over committed inputs. It does not establish unstated buyer intent, report quality, or the truth of source data. The released key becomes public when its transaction is broadcast, so settled files are public. A delivery permits at most 16 files and 16,384 encoded bytes.

The November 18 target is a **public preset demo**. Public natural-language authoring and buyer routes currently return HTTP 503. Keep those controls out of the public demo until the hosted release gates pass. The current merged website and workspace are a starting point. The hosted backend branch still needs the merged frontend integrated before a release build.

## Visual design

- **Composition:** Use the agreed editorial layout: centered identity, a full-width visual hero, large type near the lower edge, a circular discovery cue, spacious light content sections, and short staggered reveals. Keep the main action and proof outcome easy to find.
- **Hero:** Keep the existing Earth/network scene. Give Earth a luminous cyan rim, violet and pink city lights, three tilted orbital rings, moving satellites, and signal trails. The globe is an illustration of the network. It does not represent a live job or a measured transaction.
- **Sections:** Keep the existing solver figure, six-step explanation, stacked system layers, real Arc case studies, proof lab, escrow coin, and FAQ. Give the case studies direct explorer links. Label the proof lab **Simulation · no proof or payment**.
- **Workspace:** Bring its type, spacing, colors, and controls into the landing page's visual system. Put the brief, exact checks, current outcome, and next action before implementation details. Use a **Checks / Files / Transactions** drawer for evidence. Collapse secondary details at narrower widths.
- **Type and color:** Use a clear sans face for content and monospace for hashes and addresses. Keep the existing cyan, violet, and pink glow in the hero. Use green for verified or paid, amber for pending or locked, and red for failed checks. Every state also needs a word and icon. Do not rely on color alone.
- **Motion:** Keep slow globe rotation, brief scroll reveals, and one clear transfer cue for confirmed settlement. Add pause and reduced-motion behavior. Do not block scrolling or play sound automatically. Never animate a payout from a solver status report alone.
- **Readability:** Check at 1920×1080 for a projector, 1280×720 for a laptop, and 390×844 for a phone. Keep the outcome and primary controls readable at each size. Preserve keyboard focus, a non-WebGL reading path, and copyable full hashes.

Use original product copy and assets. The visual references guide composition and motion; they do not supply artwork or branding for reuse.

## Preset demo: frontend to-do list

- [ ] Replace the free-text request, quote selection, wallet funding, and **Open Workspace** entry with a clear **Explore the demo** path.
- [ ] Show two ready preset cards: **Invoice reconciliation** and **Resource allocation**. Show **signed-evidence inventory** as a candidate pilot until it has its own funded acceptance.
- [ ] On each card, show the brief, required files, plain-language checks, one passing example, one failing example, and what the proof does not check. The invoice checks cover exact IDs, amounts, and totals. The allocation checks cover feasibility under capacity, compatibility, and budget rules; they do not prove optimality.
- [ ] Show the approved rule and source reference behind each plain-language check. Use the engine's validated rule preview or a frozen reviewed preset manifest. Do not use model prose as the authoritative rule.
- [ ] Add a **Send this to your agent** card with the job link, package/reference links, runner installation link, local `check`, `prepare` after confirmed funding, `run`, and recovery steps. Provide a copy action and a readable manual fallback.
- [ ] Show the API job ID, separate on-chain job number, Arc Testnet label, bounty, absolute expiry, confirmed status, and explorer links. Mark old receipts **Historical evidence**. Mark a current run **Live** only when its data comes from current confirmed state.
- [ ] Show proof generation with a real elapsed clock and an indeterminate animation. Show cycles or seal size only after actual proof completion. Do not invent progress percentages, stage events, or a three-minute proof time.
- [ ] Treat **proof ready**, **claim accepted**, **paid and key released**, and **files recovered** as separate states. Show payment only after the release and payout receipt is confirmed. Show a rejected local check, RPC failure, expired job, and confirmed refund as different outcomes.
- [ ] Keep **Simulation**, **Live · Arc Testnet**, and **Recorded run** labels visible throughout each mode. Replay must never trigger a signer or claim current balances. A recorded fallback shows its capture time, job ID, and historical receipts.
- [ ] For the edited demo video, retain the source run and label every shortened wait `time-lapse · real time m:ss`. A failure/refund segment uses one job ID across the failed check and later confirmed refund. For live presentation, retain captions and Space/R/D/M/F controls where they already work.

### Data needed by the demo UI

A frozen preset record supplies: stable preset ID and readiness label; title and brief; output and reference file names; exact check text and rule bindings; passing and failing examples; API job ID and on-chain job number; chain ID, bounty, expiry, job URL, package URL, runner guide URL, and explorer links. A separate current chain snapshot supplies the financial state. A versioned recording supplies historical replay. The frontend must not infer a payout from a preset record or solver event.

## Later product integration

When the hosted buyer routes are enabled and qualified, keep the same visual shell and connect these flows in order. Share the preset, check, status, and receipt components. The demo reads a frozen manifest and labelled recordings. The product reads live API records and confirmed chain snapshots. Keep each source visible in the UI.

1. **Wallet ownership:** Request the expiring service challenge. Show its origin, wallet, action, and expiry before signing. Exchange the signature for a wallet-owned API key. Keep keys out of URLs, logs, and bundled configuration.
2. **Authoring and review:** Submit a draft task. Poll its saved task ID. Show draft, clarification, unsupported, failed, and uncertain outcomes separately. Display normalized rules, source quotes, units, example verdicts, coverage links, and unresolved assumptions. A buyer approves the exact revision after Bot review and native example checks.
3. **Compilation and funding:** Poll the compile task and inspect its package. Show the exact buyer, budget, absolute deadline, contract addresses, and manifest commitments before signing. Funding needs five confirmed steps: create job, set budget, approve exact USDC, fund, and register. Service charges are separate from the bounty. The browser must not hold an operator key or treat a funding preview as a funded job.
4. **Open job discovery and agent progress:** Read paginated open jobs and confirmed detail. Retry the same cursor after a chain 503. Show solver attempts by `(attemptId,cursor)`. Treat their phases as reports from solvers; use confirmed Arc state for winner, payout, expiry, and refund.
5. **Delivery and recovery:** After confirmed release, verify the envelope and key commitment, recover exact files, and show download links. State that the released key is public. Keep API, SDK, engine, and deployment pins visible in the evidence drawer.

The older selected-provider quote screen is historical UI. The public product path uses the hosted open-bounty contract. Keep the preset cards useful as examples after general authoring becomes available.

## Completion checks

**Preset demo:** The two cards show frozen checks and correct examples. Every financial state links to its matching confirmed Arc receipt. Recorded and simulated states stay labelled. Agent steps use published runner documents. Desktop, phone, keyboard, reduced-motion, and network-failure fallback checks pass. The demo makes no public-authoring claim while buyer routes return 503.

**Public product:** External wallet authentication, authoring, Bot review, approval, compilation, funding, discovery, claim, payout, refund, and exact recovery pass against the deployed origin. The UI resumes saved tasks and transactions after refresh. Public authoring is offered only after the [hosted release gates](hosted-backend-handoff-2026-11-17.md#remaining-work-in-dependency-order) pass.

## Implementation references

- [Merged demo UI and landing site](https://github.com/anishnarang9/UBC-26/pull/5)
- [Current demo checklist](demo-launch-checklist-2026-11-18.md)
- [Hosted UI/API handoff](hosted-ui-handoff.md) and [API contract](hosted-api-contract.md)
- [Public developer guide](public/README.md), [runner steps](hosted-client.md), and [capability limits](../engine/capabilities-v1.json)
- [Prepared Arc acceptance](../agents/anish/reports/open-claim-arc-live-acceptance-2026-11-16.md)
