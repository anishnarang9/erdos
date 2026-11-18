# Product plan and Claude handoff

## 2026-11-17 01:44 -05:00 — Codex — Revision 2: Valery layout with luminous orbital Earth

**Neil's latest direction:** combine [Valery — E Commerce Web Animation by Dhimas Mo / Emura](https://dribbble.com/shots/25099073-Valery-E-Commerce-Web-Animation) for the website composition and reveal rhythm with [3D globe — Website header by Tig Manukyan](https://dribbble.com/shots/26367677-3D-globe-Website-header) for stronger Earth glow and outer rings. This refines the globe revision below; the old proof chamber remains rejected.

**Reference inspection:** public video frames at 1/2/3/4/6/8/10 seconds were inspected across the references. Valery uses a centered brand over a full-width visual hero, large bottom-aligned type, overlapping circular scroll cues, spacious white editorial copy, staggered visual panels, and a wide category banner followed by two smaller tiles. The globe reference uses a luminous cyan edge, violet/pink city lights, surrounding orbital structures and particles. The preview adapts these composition/motion patterns with original product copy and visuals; it does not reuse the fashion imagery or embed either reference video.

**Implemented preview:** [open the revised website](http://127.0.0.1:4178/network.html). The root URL also redirects here. New `editorial.css` composes with the existing local preview files, all under `C:/Users/Neil/reports/proof-chamber/`.

1. **Hero:** centered identity, large lower-left introduction, circular Discover cue, three staggered opening shutters, and a complete luminous Earth toward the upper right. The animation never locks scrolling or gates the controls.
2. **Earth:** stronger cyan atmospheric rim, violet glow, pink/blue city lights, three independently tilted orbital rings, moving ring satellites, surrounding signal beacons, and the existing network trails. The expanded view now recenters explicitly even when entering fullscreen does not change viewport dimensions.
3. **Introduction:** a left headline and right explanatory paragraph state the buyer's workflow: commission a data deliverable, review checks, compare quotes, select a solver, then release escrow under the agreed proof conditions. Public/shareable inputs and the upcoming human adapter remain explicit.
4. **Editorial visuals:** staggered deliverable and acceptance illustrations use a sample JSON file and explicit check list. These are explanatory artifacts, not fake customer logos, photographs or live receipts.
5. **Use-case collection:** one large record-reconciliation banner, then catalog/schema conversion and human-prepared delivery tiles. The first is demo-available; the others retain proposed-pilot / adapter-next labels.
6. **Motion:** short masked hero entrance, staggered opacity/translation reveals as sections enter view, slow globe rotation, independent satellite movement, pause, pointer rotation, and reduced-motion support. No scroll hijacking, autoplay audio or fabricated live solver activity.

**Verified:** isolated Chrome passed the root redirect, two local textures, shader/JavaScript error checks, three orbital rings, centered expanded view, pause/resume, all sample delivery outcomes, scroll reveal visibility, reduced motion, and no horizontal overflow at 1920×1080, 1280×720 and 390×844. Desktop and introduction screenshots were visually reviewed. The measured scene reports 252 network nodes, 38 decorative routes and 60 draw calls; this is not an FPS claim for the proving laptop. Evidence: `network-qa.json`, `network-desktop.png`, `editorial-introduction.png`, and `network-expanded.png` in the preview folder.

**Implementation handoff:** this is the latest visual direction. Use the editorial composition and orbital Earth rather than the previous all-dark page. The underlying D1–D4, exact-check semantics, selected-provider flow, signer boundaries, live/replay distinction and receipt/decryption requirements remain unchanged. No real payment or cryptographic proof occurs in this isolated preview.

---

## 2026-11-17 — Codex — Revision: globe animation replaces the proof chamber

**Neil rejected the proof-chamber preview and supplied a specific motion reference.** The new direction is a cinematic Earth/network scene based on [Storyblocks SBV-348419533](https://www.storyblocks.com/video/stock/abstract-tech-earth-globalization-in-3d-motion-graphic-concept-transmit-ai-networking-on-fiber-optic-transfer-5g-web-communications-signal-348419533). This supersedes the chamber, mechanical gate, colliding spheres, light editorial shell and Rapier recommendation below. Earlier audience research and D1–D4 remain applicable; the rejected visual proposal is retained as history.

**Reference inspected:** the publicly available watermarked preview, including a captured frame at three seconds. Observed ingredients: close-up textured blue Earth, dark space, teal nodes, fine triangular network edges, luminous transfer trails and atmospheric depth. The preview is a WebGL recreation, not the licensed movie embedded or an exact frame-for-frame copy.

**Revised preview:** [global proof network](http://127.0.0.1:4178/network.html), implemented in `C:/Users/Neil/reports/proof-chamber/network.html`, `network.css` and `network.js`. Use **Expand animation** for an unobstructed globe view, **Pause motion** to stop it, or mouse drag to turn the globe. Reduced motion starts paused. The previous directory name is retained so the local server remains usable.

**Layout:** a full-width midnight-blue hero, large cropped Earth on the right, readable headline and CTA on the left, and subtle navigation. On mobile, copy appears above the lower hemisphere. The product steps and acceptance-check experiment sit below the hero, separate from the visual network.

**Implementation:** use the existing Three.js/R3F renderer, sphere textures, shader materials, lines and point sprites. Rapier is unnecessary for this chosen animation. Cap DPR at 1.5, stop updates when hidden/offscreen, and provide reduced-motion/static fallback. The network is illustrative; never label its nodes as actual worker locations, active jobs or real transactions. Live acceptance and financial states remain API/chain-derived.

**Assets and evidence:** Earth day/night maps are locally mirrored from the official Three.js example texture URLs listed in the preview README. No Storyblocks movie is embedded. Browser QA covers texture loading, shader/JavaScript errors, full-screen control, pause, all three sample scenarios, reduced motion and desktop/mobile overflow. Source and screenshots remain outside `commerce/`.

**Claude handoff:** implement this globe direction instead of the earlier gate. Preserve selected-provider quotes, approved checks, separate simulation/live/replay modes, the single release receipt, presenter controls and D1–D4. No `commerce/` file was edited by Codex in this revision.

---

## 2026-11-16 — Codex — Product research and proposed Proof Chamber redesign

**Status:** Design and implementation plan, following Neil's request for an impressive website with real physics and a clearer UI structure. This is a proposed visual replacement for the earlier equal-column presentation, not a change to the reconciled payment protocol or D1–D4. Claude continues to own `ui-intent.md`; no files under `commerce/` were changed for this study. Earlier decisions and implementation handoff are preserved below.

**Review artifact:** [interactive local concept](http://127.0.0.1:4178), with source at `C:/Users/Neil/reports/proof-chamber/`. Start instructions are in its README. It is an original website composition with an interactive physical chamber, scenario controls, visible checks, receipt, use-case taxonomy and reference desk. Every settlement state is explicitly simulated. “Proof Chamber” is the name of the visual metaphor, not a required product rename. The standalone experiment uses Three.js plus an original planar collision solver; the production recommendation is R3F plus Rapier v2.

### A. Product decision: what the website should sell

Lead with **“Define what done means. Pay when the checks pass.”** The buyer commissions a specified data deliverable; the selected solver returns files; a proof establishes that the committed artifact satisfies the approved checker; the payment and delivery key release under the contract conditions. The browser then recovers the files.

The contractor-substitution idea is useful as a starting point, but “replace contractors” is too broad. Hiring includes judgment, ambiguous requirements, evolving scope, confidentiality, and relationship management. Our proposed wedge is **repeatable, machine-checkable work on public or shareable data**. It reduces a particular acceptance/payment problem; it does not eliminate writing a good specification or finding a capable supplier.

Keep humans eligible at the product level. Use “solver” for the provider and “agent” or “human-prepared” as a capability attribute, not two separate marketplaces. The current funded path remains an autonomous solver selected after quotes. The human adapter remains next unless its separate funded acceptance run succeeds. Never show two agents racing for a first-winner payout: that is a different allocation mechanism.

**Evidence boundary:** the existing ledger-copy fixture proves the payment/delivery mechanism, not commercial demand or a difficult outsourced task. The report rule checks nonempty presence, not writing quality. An exact approved reference is not proof that the underlying real-world source is true or current. Public release of the key makes the encrypted delivery public. These limits belong in concise “What is checked” and “Data visibility” disclosures.

### B. Audience and market scope

These are hypotheses to validate, not customer interviews or measured traction.

| Audience | Job to be done | Fit and obstacle | Website treatment |
| --- | --- | --- | --- |
| Small data/software agencies handling repeat exports and migrations | Commission a repeatable transformation with an explicit acceptance checklist | Best discovery target; templates amortize setup. Public/shareable data requirement narrows eligibility | Primary use-case language and example brief |
| Crypto analytics and public-data teams | Obtain a reproducible, bounded result from agreed public inputs | Familiar with wallets and public inputs; freshness, provenance and useful computation still need explicit rules | Early technical pilot audience |
| Independent automation developers / agent operators | See exact requirements and earn payment for accepted work | Supply-side candidate; need predictable compute cost and clear failure behavior | Secondary “Build a solver” documentation |
| Human data contractors | Prepare files against the same acceptance contract | Plausible supply extension; funded upload/proving adapter not yet established | Clearly labeled upcoming capability |
| General business owners commissioning subjective creative work | Buy design, strategy or writing | Weak initial fit; subjective acceptance does not become deterministic by adding ZK | Do not advertise as supported |
| Private finance/health/customer-data workflows | Exchange sensitive files | Current public-key release conflicts with confidentiality | Excluded from current positioning |

**What the market evidence supports.** Upwork reported roughly **$4.03 billion of 2025 gross services volume** and 785,000 active clients at year end. This shows a substantial adjacent market for paid online work; it is **not our TAM**, and Upwork's GSV definition is broader than payments for our eligible job types. Do not put an enormous freelance-market number on the landing page as if it were attainable demand. [Upwork FY2025 results](https://investors.upwork.com/news-releases/news-release-details/upwork-reports-fourth-quarter-and-full-year-2025-financial)

**Competitive reality.** Topcoder already describes automated scoring of code/result submissions. Elgora advertises USDC bounties with Guardian consensus, and make.fun describes sandbox-graded coding competitions with USDC rewards. These are operator descriptions, not independent technical audits. Our defensible demonstration is the approved-checker commitment, proof-bound artifact and settlement/delivery trace—not the existence of bounties or AI workers. [Topcoder](https://help.topcoder.com/hc/en-us/articles/24958207325467-What-Are-Data-Science-Challenges), [Elgora](https://elgora.ai/), [make.fun](https://make.fun/guide/ai-agent-bounties)

| Alternative | Why a buyer might use it | What we must demonstrate |
| --- | --- | --- |
| Contractor marketplace | Discovery, reputation and flexible work | Precise repeatable acceptance and payment behavior for an eligible task; do not claim superior discovery |
| Scored competition | Many entrants, measurable ranking | Selected-provider workflow and proof-linked delivery; do not present it as an open competition |
| Agent bounty platform | Agent discovery and digital payment | The concrete verification mechanism and what remains trusted |
| Ordinary script + invoice | Cheap and familiar for deterministic transformations | Enough coordination/inspection cost saved to justify proving and integration |

**Bottom-up planning example, not a forecast:** 20 pilot agencies × 5 eligible jobs/month × $200/job × 12 = $240,000 annual job value. An illustrative 5% fee yields $12,000 before proving, infrastructure, support, gas and acquisition. This deliberately small scenario shows why repeated valuable jobs matter. None of these inputs is measured, and 5% is not a recommended price.

Measure contribution per delivery as fee revenue minus compute subsidy, paid gas, retries and variable support. Measure buyer benefit as inspection/dispute/coordination time saved minus specification/setup time and waiting cost. If a cheap local script solves and checks the whole task, the platform may add little value.

**Discovery gate:** interview three agency leads and two suppliers; obtain two real repeatable acceptance checklists, one shareable fixture and one buyer willing to try a paid pilot. Ask what was purchased, actual price, review time, disagreements, privacy needs and repeat frequency. Validate whether an independently prepared good artifact passes and a plausible wrong artifact fails. No interviews or outreach were conducted in this task. Begin with curated pilots and two capable providers, not an empty public marketplace.

### C. Reference shortlist: what Neil should open

The recommendation is a small compatible scene toolkit, rather than a full decorative landing-page template. Reuse the existing React/Vite app and Motion; add physical behavior only where it explains the transaction.

| Reference / live example | Take from it | Compatibility / reuse decision |
| --- | --- | --- |
| [Rapier + R3F demos](https://react-three-rapier.pmnd.rs/) · [source](https://github.com/pmndrs/react-three-rapier) | Bodies, collisions, bounded interaction and joints | **First choice.** v2 explicitly supports React 19 and R3F 9, matching this repo. MIT. Pin and test a v2 release; do not install latest blindly |
| [pmndrs scene gallery](https://r3f.docs.pmnd.rs/getting-started/examples) | Material, lighting, annotations and scene composition | Fits the existing renderer. Review each linked example's dependency and asset licenses separately |
| [Bruno Simon](https://bruno-simon.com/) · [source](https://github.com/brunosimon/folio-2025) | Tangible cause and effect, physical affordances, reset/quality controls | Source is offered under MIT. A whole game world is too much for our buyer flow; study interactions rather than transplant the site |
| [Lusion](https://lusion.co/) | Strong art direction, one dominant scene and careful material contrast | Visual inspiration, not a licensed drop-in template. Do not copy branded assets or assume reuse rights |
| [Magic UI Animated Beam](https://magicui.design/docs/components/animated-beam) · [source](https://github.com/magicuidesign/magicui) | One short transfer cue and compact receipt transitions | Open-source repo is MIT; Pro templates are separate. Adapt only needed components to existing CSS/Motion; no full Tailwind migration |
| [Matter.js demos](https://brm.io/matter-js/demo/) · [engine](https://brm.io/matter-js/) | Springs, collision response and physical constraints in 2D | Alternate implementation if 3D fails laptop targets. Do not run two physics engines in the same scene |
| [React Flow examples](https://reactflow.dev/examples) | Inspectable node/edge diagrams | Useful later for complex rule graphs; unnecessary for the initial three-check inspector |
| [Codrops: When Cells Collide](https://tympanus.net/codrops/2025/09/11/when-cells-collide-the-making-of-an-organic-particle-experiment-with-rapier-three-js/) | Optional research lead for collision-driven organic arrangements | Search surfaced this case study, but direct access was blocked; no code/license or visual behavior was verified here |

Your references translated into decisions:
- **Figma:** give the outcome one dominant region, put technical details behind disclosure, and keep input/check/receipt proximity consistent. Keyboard access and readable contrast apply even when WebGL is present. [UI principles](https://www.figma.com/resource-library/ui-design-principles/)
- **Leadde:** its page describes narrated animated explainer videos, not a browser rigid-body engine. Borrow the scene-by-scene teaching approach; use R3F/Rapier for actual interactive physics. [Physics animation](https://leadde.ai/solutions/physics-animation)
- **Awwwards:** useful as a discovery board for motion references. Direct fetching timed out here; no award, ranking, or specific visual inspection is claimed. The shortlist above links the actual studios/examples to inspect. [Animation collection](https://www.awwwards.com/websites/animation/)

Avoid a framework upgrade to WebGPU/R3F 10 for this deadline, a full physics game, fluid simulation, cursor replacement, scroll hijacking, autoplay sound, or a generic “AI agent SaaS” template. None is necessary to explain the mechanism.

### D. Visual direction and hierarchy

**Direction: an editorial verification studio with a physical proof chamber.** Warm off-white page, deep forest scene, pale lime verified state, restrained coral failures, ordinary clear typography and one mechanical object with weight. A large headline explains the promise; the experiment earns the visual spectacle.

The current inspected frontend allocates similar visual weight to buyer, vault and solver. Its dense cards, small labels and fixed minimum width make the result compete with implementation details. Preserve those useful components, but reorganize them around the buyer's current question.

**Design tokens (starting values, not measured accessibility results):**
- Background `#EEEFE8`, main ink `#172D28`, secondary ink `#51665D`, separators `#CBD2C7`.
- Scene `#102D29`, surface `#1B3830`, light text `#E5EBDF`, verified accent `#C6ED91`.
- Rejected coral is for the scene accent; dark error text `#A13923` on light surfaces. Locked/pending uses amber plus a label.
- Body: existing Inter/system sans; identifiers: existing monospace; optional serif italic limited to the marketing headline.
- Public landing: headline 64–112 px responsive, body 16–18, labels 12 minimum in production. The local composition study uses some smaller secondary annotations that should be enlarged for projector mode.
- Demo at 1080p: current outcome 40–48, principal values 32–40, primary instructions and captions 22–28, secondary labels at least 16. Hashes stay collapsed.
- Spacing: 8-px rhythm, 24–32 between related sections, 64–96 between marketing sections. Border radius 8–12 for the chamber, 4–6 for controls. Reserve shadows for physical depth, not every text group.

**Layout 1 — public website, 1440 desktop:**
- 80–100 high header: product identity, Experiment, Use cases, Evidence/docs. One primary CTA, “Try the proof lab.”
- Hero: roughly 36% editorial copy / 64% chamber. Visible simulation badge and concise disclaimer. No wallet or account needed to understand it.
- Under the scene: input comparison, three explicit acceptance checks, outcome receipt. These form one aligned evidence strip, not many unrelated cards.
- Next: why one cent changes the outcome; supported work; how the real proof differs from the local illustration; real evidence/limitations; developer path.
- No fabricated counters, customer logos, “AI thinking” terminal, or unsupported “trustless” headline.
- Mobile: single-column copy → scene/controls → input/check/result. Keep the DOM result usable without WebGL. Do not require dragging.

**Layout 2 — real transaction workspace, 1920×1080:**

```text
72 px    identity | LIVE · ARC TESTNET | job identifier | presenter controls
76 px    current outcome + exact next action                         mode/connection
620 px   brief / approved checks     physical chamber      selected solver / details
         360 px                     flexible ~1000 px     360 px
         contextual; scroll         dominant, quiet      collapsed by default
120 px   event timeline + single release receipt + files when recoverable
72 px    narration / wait label / recoverable error
         remaining height for gutters and padding
```

Use CSS grid with `minmax(0,1fr)`, not a global 1280-px minimum width. On 1280–1535 widths, the inspector becomes a drawer; retain the buyer task and main outcome. On small screens, use stacked HTML summaries. Full mobile wallet/presenter UX remains outside the agreed hackathon scope.

**Layout 3 — proof/evidence inspector:** a normal HTML drawer with tabs **Checks / Files / Transactions**. Checks show the engine's canonical rule and expected versus actual values. Files show names, sizes and recovery status. Transactions show network, status and explorer links. Raw hashes and journal details are a further disclosure. Closing returns focus to its trigger.

### E. Information architecture and classification

Organize by a buyer's intent and progress, not by underlying protocols.

| Location | Purpose | Availability |
| --- | --- | --- |
| `/` | Promise, interactive explanation and eligible work | Proposed public landing |
| `/lab` | Standalone local simulation; same scene and controls | Proposed route; current isolated preview demonstrates it |
| `/app/jobs/new` | Brief → reviewed checks → quotes → selected solver → funding | Existing behavior reorganized, route naming proposed |
| `/app/jobs/:id` | Status, current action, evidence and recovered files | Live data only |
| `/replay/:recordingId` | Recorded real-run playback with persistent label | Signed actions unavailable |
| `/docs` | What is checked, data visibility, solver integration, limitations | Public explanatory content |

**Global navigation:** Experiment, Use cases, Evidence, Docs. “Create a job” becomes the product CTA only when the integrated path works; avoid dead links in the prototype. Do not add an empty Marketplace, Pricing page or dashboard analytics to fill a menu.

**Work templates:** classify by deliverable, then readiness.
1. **Record reconciliation — demo available:** exact IDs/amounts/total plus nonempty report. State the current fixture's simplicity.
2. **Catalog/schema conversion — proposed pilot:** fixed schema, identifiers, required fields, explicit integrity rules. Needs real customer fixture and engine capability check.
3. **Signed evidence bundles — product exploration:** signed input and named-file checks; engine-domain coverage is not proof of a complete buyer template.
4. **Constraint/optimization output — later research:** feasibility checks do not establish optimality. Keep off the primary landing until real.

A template detail always shows input eligibility, output files, exact acceptance rules, unchecked properties, data visibility and provider availability. Future filtering should use **deliverable type**, **readiness**, and **solver capability**, not “blockchain / AI / human” as mutually exclusive job categories.

**Job status taxonomy:** Draft; Awaiting quotes; Ready to fund; Funding; Funded; Producing/proving; Proof ready; Submission pending; Accepted; Release pending; Paid/key released; Delivery recovered. Rejected checks, transport error, expired and refunded are distinct branches, not one red “failed” state.

### F. The signature physical interaction

**The wow moment is causal:** change invoice-b from 2,000¢ to 2,001¢, run the same checks, see the exact amount rule fail, and see the gate remain locked. Reset to the correct file and the same gate opens. Then show the fresh real run with its actual receipts.

The scene is a bounded machine, not a screen-wide swarm. Data glyphs approach a mechanical barrier. They have weight, damping and collision response. The barrier expresses acceptance; the escrow amount remains an ordinary authoritative text value. The glyph count is decorative and never encodes money, rows, proof bytes or progress.

**Production physics specification:**
- Reuse React 19.1.1, R3F 9.3.0, drei 10.7.4, Three 0.179.1 and Motion 12.23.12. Add a tested/pinned Rapier v2 wrapper. Avoid competing tween/physics owners on the same transform.
- 12–24 instanced simple bodies; sphere/cuboid colliders, no runtime triangle-mesh collider generation.
- Rapier fixed simulation step 1/60 s, maximum four catch-up steps; clamp elapsed time after backgrounding. Render interpolation separate from simulation.
- Initial tuning: mass 1, restitution 0.25–0.4, friction around 0.5, linear damping around 1.5. Treat these as tuning inputs, not physical validation.
- Mouse drag applies a damped spring toward a raycast plane; cap force and speed. Pointer release/cancel releases the body. No drag required for any task.
- Gate is a **kinematic collider commanded by semantic state**. Simulation checks may command it in the lab; only the accepted/released state projection may command it in live mode. Collision callbacks have no access to signing, funding or settlement methods.
- Camera remains stable. Optional hover tilt is capped to ~3 degrees, disabled for reduced motion, touch and presenter recording.
- Pause offscreen/hidden, let bodies sleep at rest, and dispose geometry/materials on route exit. Keep a consistent reset seed for the visual arrangement; blockchain outcomes never depend on it.

**Motion choreography:**
- A rule moves from brief to approved-check list only after actual engine validation; 180–240 ms transform/opacity.
- Funding: one 600–900 ms transfer cue after confirmed funding. Never animate money arriving while a wallet request is pending.
- Proving: subtle indeterminate activity with a real elapsed clock. No invented percent, cycle counter, or execute/prove/Groth16 stage.
- Proof finished: a compact chip appears with actual reported cycle count and seal size, 250–400 ms.
- Accepted proof: gate indicator changes on verified state; payout is still pending until release.
- Release receipt: payment and key enter one semantic state transition. A ~900 ms visual sequence may draw attention to each part, while one receipt identifies both.
- Rejection: failed rule and text appear immediately; a small rebound emphasizes a closed gate. No “on-chain rejection transaction” if only preflight rejected.
- Decryption: show recovered files only after the existing hash/commitment and authenticated-decryption checks succeed.
- Refund: separate expiry and refund-confirmation state. Never accelerate a real refund with simulation time.
- Reduced motion: no travel, shaking, orbiting or counter interpolation; show stable state icons, text and receipt. Audio is off by default and never the only signal.

The isolated prototype implements genuine planar contact impulses, boundary constraints, drag springs and damping rendered as 3D spheres. Its 1/120-step solver is a visual study, not a production physics library or cryptographic implementation. It cannot send money.

### G. Live, simulation and replay must remain separate

| Mode | Source of truth | Available action | Permanent label |
| --- | --- | --- | --- |
| Simulation | Local sample fixture and illustrative state machine | Change input, run local checks, reset, pause visuals | “Simulation · no proof or payment” |
| Live | Existing API, engine events and confirmed Arc chain state | Authorized buyer flow; presenter signer only under server capability | “Live · Arc testnet” |
| Replay | Allowlisted versioned recording | Play, pause, seek and reset; no signer methods | “Recorded run · date/job” |

Use separate stores/adapters or a discriminated mode union that makes signing unavailable to simulation/replay. Never switch to a recording invisibly after RPC failure. Offer a clearly labeled replay and keep the last known live status visible.

Do not add a new backend requirement for the chamber: it consumes the already agreed snapshot/event envelope. Useful input events remain draft/validation, quote selection, funded, proof.started, proof.finished, submit/preflight result, accepted, release receipt, delivery recovered, expiry and refund. No continuous engine telemetry is assumed.

Use the existing quote listing endpoint. The signer UI reflects `GET /v1/demo/capabilities`; a client-side presenter toggle grants no authority. Live financial state remains chain-derived. Decryption output stays out of sanitized telemetry.

**Frontend decomposition proposal:** `ExperienceShell`, `ModeBanner`, `OutcomeHeader`, `BriefAndChecks`, `ProofChamber`, `EvidenceInspector`, `SettlementReceipt`, `DeliveryFiles`, `PresenterControls`. Keep the present API/chain/store modules as the business-logic boundary; refactor visual hierarchy before changing business behavior.

### H. Hackathon narrative and implementation order

Protect the agreed 2–3 minute fresh-run video. The simulation is an optional website/booth teaching tool, not a substitute for the real proof or mandatory video footage.

**Suggested 150-second edit:** 0–15 buyer problem and explicit deliverable; 15–40 real English draft and approved checks; 40–60 selected quote and funding; 60–85 real proving time-lapse with elapsed label; 85–110 accepted proof, release receipt and recovered files; 110–135 one-cent rejection plus refund filmed after actual expiry; 135–150 buyer benefit and honest human/public-data scope. Adjust to actual footage rather than inventing timing. If a lab clip is used, label it simulation and remove other exposition to stay within the limit.

| Slice | Result | Gate before moving on |
| --- | --- | --- |
| 1 — composition | New typography, spacing, dominant outcome, contextual panels; existing live data preserved | 1080p readability and no covered controls |
| 2 — chamber | Bounded physics, restrained materials, reduced-motion/static fallback | Controls usable under proving load; no business effects from collisions |
| 3 — state integration | Existing accepted/funded/release/reject/refund states mapped to scene and receipt | No paid-before-release, duplicate funding, invented stages or false rejection |
| 4 — evidence UX | Checks/Files/Transactions drawer, copy/explorer actions, recoverable errors | Keyboard/focus, long filenames/hashes, disconnected API tested |
| 5 — rehearsal | Fresh full path and act-two capture; controls Space/R/D/M/F preserved | Existing D1–D4 and C1–C14 acceptance gates pass |
| 6 — public wrapper | Landing, eligible use cases, lab, docs/evidence links | Every CTA works; planned features visibly marked |

Integrate the four agreed backend additions in their existing order: polled run events, constrained signer, recorded replay, dedicated tampered-solver orchestration. Visual work can progress against fixture adapters but must not claim those additions are complete.

Planning estimate: composition 3–5 focused hours, chamber 4–8, state/inspector wiring 4–8, QA/rehearsal 3–6, public wrapper 3–5. These are rough engineering ranges, not commitments; backend work is separate. With the Nov 20 deadline, prioritize the real transaction view and recording over a multi-page marketing site.

**Cut order:** elaborate materials/refraction → camera tilt → drag interaction → physical particles (retain static gate) → extra landing sections. Preserve mode labels, exact failed check, receipts, file recovery, accessibility and the real-run evidence. A minimal coherent scene is preferable to an unstable complicated one.

### I. Acceptance bar and limitations

**Comprehension:** in a five-person informal test, at least four should identify who pays, what is checked, when payment releases and what the one-cent failure means without explanation. This is a proposed test, not a result.

**Browser/interaction:** check 1920×1080, 1440×900, 1280×720 and a 390-px mobile landing. No horizontal overflow; long filenames and errors wrap; controls stay reachable at 200% zoom. Keyboard works without interacting with canvas. Focus is visible, dialogs restore focus, and live announcements describe important outcomes only. Verify contrast rather than assuming token choices pass.

**Performance targets, pending measurement on the actual proving laptop:** aim for 60 fps; target p95 visible frame interval below 20 ms during the selected workload, under 100 scene draw calls, and initial DPR at most 1.5. Sample before and during proving. If sustained frame intervals exceed 33 ms, reduce quality or switch to static/SVG. Measure with production assets; a local browser screenshot cannot certify the laptop target.

**Correctness:** test separate mode adapters, no signing in simulation/replay, out-of-order/duplicate events, reset during animation, preflight versus transport errors, indexer lag, expiry before refund and release before decryption. Preserve existing transaction tests; add integration tests for new behavior, not tests that merely duplicate animation constants.

**Research limitations:** repository files and Neil's pasted group discussion supplied product context; no new external group-chat history was accessed. Public pages are cited above; some visual sites could not be fetched and are labeled accordingly. No market-size estimate for the eligible niche is established. No customer interview, live funded human delivery, new production transaction, or current-laptop performance benchmark is claimed.

**Preview verification completed:** isolated headless Chrome passed correct delivery, one-cent rejection, missing report, reset during a pending run, pause/resume and reduced-motion checks. Layout checks found no horizontal overflow at 1920×1080, 1280×720 and 390×844; the initial 1440-wide layout was also captured. Screenshots were visually inspected. The scene reported 18 finite-position bodies and 43 draw calls, with no JavaScript page errors. This is prototype QA, not a performance benchmark on the proving laptop or validation of a real payment. Evidence: `C:/Users/Neil/reports/proof-chamber/qa-results.json` and the adjacent PNGs.

### J. Conflicts and handoff to Claude

1. **Visual hierarchy changes:** earlier equal buyer/vault/solver columns become a dominant chamber with contextual panels and evidence drawer. This is the proposed response to Neil's dissatisfaction.
2. **Style changes:** dark terminal styling becomes an editorial light shell with a dark physical stage. Keep semantic success/pending/failure labels and established chain facts.
3. **New teaching surface:** the lab is explicitly simulated and isolated from live/replay; the existing store's two-mode model needs an adapter boundary before integrating it.
4. **Mobile:** responsive public landing is proposed; full mobile presenter/wallet UX remains outside D1–D4 scope.
5. **Dependency:** Rapier v2 is proposed; the current app has R3F but not the physics wrapper. Prototype physics does not imply that package was installed.
6. **Unchanged agreements:** selected provider, public/shareable inputs, human adapter gate, server-authorized signer, one release receipt, truthful telemetry, genuine expiry and fresh video all remain.

**Next owner:** Claude can reconcile these visual proposals against the existing components and record the chosen implementation in its own Decisions section. No additional backend endpoint is required solely for physics. Preserve the original product handoff below; this section supplies the new product/design direction and research, not a parallel protocol.

---


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

