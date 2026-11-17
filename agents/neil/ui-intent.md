# Buyer demo UI: statement of intent

**Status:** CONFIRMED by Neil on 2026-11-16, from the interview answers. Build work under `commerce/web` waits until this file is reconciled with Codex's `product-plan.md`.

**Owners:** Claude Code writes this file. Codex writes only `agents/neil/product-plan.md`. Neither agent edits code under `commerce/` until the two files are reconciled. Agreed decisions go in **Decisions** at the bottom of this file.

## Intent

| Item | Decision |
| --- | --- |
| Outcome | A 3-minute live demo app that makes the trust story visible. A plain-English request becomes engine-checked rules, USDC is locked in escrow, a real zero-knowledge proof unlocks the payout, and the buyer's files decrypt on screen. |
| Audience | Hackathon judges watching a 1920×1080 projector. Type must be readable from the back of the room. |
| Success | Judges see both outcomes, paid and rejected-then-refunded, happen for real on Arc within 3 minutes. The hero beat lands even if the network fails, because a replay of a recorded run takes over. |
| Constraint | A steady 60 fps on the demo laptop. 3D is limited to the centre vault. The ~2-minute prove is covered by the proving-grid animation and narration. |
| Out of scope | Mobile layout; multi-buyer accounts and login; production wallet UX beyond the toggle; hand-editing rules in the UI (the buyer approves or redrafts); the solver console as a separate product. |

## Layout (split screen, 1080p)

```
┌──── BUYER (2D) ────┬─── 3D VAULT (R3F) ───┬──── SOLVER (2D) ────┐
│ request → rules →  │  USDC particles in   │ quote → proving grid│
│ quotes → fund      │  proof chip flies in │ (cycle counter) →   │
│ ← key, decrypt     │  pulse on accept,    │ π chip → submit →   │
│                    │  coins stream out    │ release             │
├────────────────────┴──────────────────────┴─────────────────────┤
│ ARC timeline ●Created ●Funded ●Submitted ●Paid ●Decrypted (tx links) │
└──────────────────────────────────────────────────────────────────────┘
```

## Motion

- **Rules (buyer).** Key phrases in the request highlight, detach, and fly into rule cards. Each card types out the engine's canonical rule, rendered from `engine validate` preview and never from model prose. Each card is stamped "checked by engine" and shows its example verdicts, flagging where Grok's prediction differed from the checker.
- **Proving (solver).** A circuit grid fills while the zkVM runs, and a cycle counter ticks toward the real `userCycles`. The stages read execute → prove → groth16. The grid then collapses into a "π · 260 bytes · 0xe71e6620…" chip.
- **Flows.** Glowing animated beams link the panels: USDC moves buyer → vault on fund and vault → solver on payout, the proof moves solver → vault, and the key moves vault → buyer. Balances tick with a number ticker.
- **Hero.** The verifier accepts the proof (the vault pulses green). Next, the USDC streams to the solver. Finally the key beams to the buyer and the ciphertext hex scramble-decodes into the real `result.json` and `report.txt`. The text decodes only after both hash checks pass on screen (envelope hash, key commitment).
- **Act two (~20 s).** A tampered delivery proves verdict 0. The proof chip cracks red at the vault, the vault stays locked (amber), and after expiry a refund beam returns USDC to the buyer.
- **Style.** Dark terminal-crypto. Green means verified or paid, USDC blue means money in flight, amber means locked or pending, red means rejected. Every state also carries an icon and a word. Hashes use a monospace font, are truncated, and can be copied.
- **Sound.** Subtle and mutable: a tick per rule, a hum while proving, a chime on ProofAccepted, a clink on payout, a buzz on rejection.

## Presenter mode

- The run is live (real Grok, proof and Arc transactions).
- Keys: **Space** advances the narration and highlights the next element, **R** replays a recorded run, **D** runs act two, **M** mutes, **F** goes fullscreen.
- One-line captions narrate each step.
- **Signing toggle.** MetaMask is the real browser wallet, with four popups. The **demo signer** is the testnet Poster key held by the local API from the gitignored `.env`. The key never reaches the browser, and the UI labels this mode "demo signer · testnet".

## Stack

- **3D:** React Three Fiber and drei, for the vault only.
- **2D:** Motion (Framer Motion) for the panels and beams.
- **Patterns:** adapted from open-source Magic UI and Aceternity UI (animated beam, number ticker, text scramble) and the pmndrs examples. We take inspiration only; no branding is copied.
- **App:** Vite and React in `commerce/web`. The API and Arc RPC are reached through same-origin dev proxies (`/v1`, `/rpc`).
- **Delivery:** the browser recovers the delivery from public chain data with `@ubc26/sdk`, using the submit calldata, the released key and `hook.contextOf`.

## What already exists

All of this is on branch `neil/plan-architecture` and verified live on Arc (jobs 1 and 2: `commerce/evidence/arc-first-funded-jobs.md`).

| Need | Endpoint or module |
| --- | --- |
| Draft from English (Grok and the engine) | `POST /v1/drafts` returns `draft` (revision, engine hashes, preview rules, examples with checker verdicts, source quotes), `clarification`, or `unsupported` (the engine's capability error) |
| Create, approve, compile | `POST /v1/jobs`, `POST /v1/jobs/:id/approve` (binds rulesHash), `POST /v1/jobs/:id/compile` |
| Quotes | `GET /v1/jobs/:id/quotes` (buyer). The solver agent (`commerce/worker` `pnpm agent`) quotes and proves on its own. |
| Funding | `POST /v1/jobs/:id/select-quote` returns `fundingTerms`, `txRequests`, `afterCreate`; the four transactions are created with `@ubc26/sdk` `arc.posterTxRequests`; then `POST /v1/jobs/:id/funding-receipt` |
| Tracking | `GET /v1/jobs/:id` (app state, chain status) and `GET /v1/jobs/:id/submission` (submit tx, hashes, release tx, key) |
| Delivery | `@ubc26/sdk` `arc.contextOf`, `decryptEnvelope`, `decodeBundle` |

## Gaps the UI work must add

1. **Live solver events for the right panel.** The agent needs to publish progress (quoted, proving with stage and cycles, proof chip, submit, release) through a local event stream (SSE) or a polled status file. Live cycle counts during proving need either engine support or interpolation toward an estimated total. Ask Anish whether `engine prove` can report progress.
2. **Demo-signer endpoint.** Presenter mode only. It must be gated by an explicit env flag and must not run in normal mode.
3. **Recorded-run replay.** A JSON timeline of a real run (transactions, timings, payloads) that the presenter can replay with R.
4. **Act two orchestration.** Start a second job with the tampered solver, then trigger the refund after expiry. A short expiry, around 11 minutes, has to be pre-arranged before the talk.

## Decisions

Reconciled 2026-11-16 by Claude Code against Codex's `product-plan.md` (02:31 entry). Neil confirmed D1–D4. These supersede the Intent sections above where they differ.

### Neil's decisions

| # | Decision |
| --- | --- |
| D1 | **The demo is a submitted 2–3 min video** (Devpost; due Nov 20, 1 p.m. EST). We screen-record one **real, fresh** run end to end at 1080p: English request, Grok, engine, four funding transactions, real proof, payout, decrypt. Waits are cut or time-lapsed in the edit, always with an on-screen "time-lapse · real time m:ss" label. Act two is filmed in two parts: the rejection, then the refund after real expiry. No prepared-proof shortcut is needed. |
| D2 | **The full presenter mode stays** (Space, R, D, M, F and captions), so the same UI works for the finals or a live booth on Nov 21. Replay also serves video retakes. |
| D3 | **Human solvers.** The video says the same checks can gate a human-prepared file, and that the human adapter is next. A real paid human delivery appears only if the adapter is built and passes its own funded acceptance run before recording. |
| D4 | **Positioning:** verified data deliverables on public or shareable inputs. Private delivery is stated as future work, because a released key makes the delivery public. |

### Codex conflicts C1–C14

| ID | Resolution |
| --- | --- |
| C1 | Accepted. Selected provider after quotes; open winner races are roadmap. |
| C2 | Resolved by D1. A video removes the 3-minute live limit; the waits are edited with labels. |
| C3 | Accepted. Correction to Intent: act two's job needs at least 780 s plus delays at funding (worker admission). Use 15 min or more for the failing job and 30–60 min for the passing job. Film the refund after real expiry. Never shrink the worker's margins. |
| C4 | Accepted. Correction to Intent: no fabricated live cycles or stages. The proving grid is an indeterminate animation with a real elapsed timer, and the real `userCycles` and seal size appear only when `proof.finished` arrives. Stage events wait on Anish's engine telemetry. |
| C5 | Accepted. The rejection reads "failed check → submit preflight rejected (VerificationFailed) → no transaction sent". An RPC failure is shown differently. |
| C6 | Accepted. Payout and key come from one release receipt and are recorded as one state transition. The animation may sequence them visually. |
| C7 | Accepted, gated per D3. |
| C8 | Accepted. `GET /v1/jobs/:id/quotes` already exists (`434dd22`); the UI uses it as is. |
| C9 | Accepted. The demo signer is authorized server-side only: an env flag, Arc testnet only, buyer auth, the four Poster calls only, and a per-job and session budget. The UI toggle selects a mode but grants nothing. |
| C10 | Accepted (D4). |
| C11 | Accepted. No "frozen" or "trustless" escrow claims until Nick renounces admin roles and live reads confirm it. |
| C12 | Accepted. The rule cards show exactly what the engine checks; the report check is "report present (size > 0)", not report quality. |
| C13 | Accepted. Act two uses a dedicated tampered solver identity (its own key), so the honest agent cannot take that job. This needs a third testnet account. |
| C14 | Accepted. Before recording, rehearse one uninterrupted UI path through Grok, engine, Arc and decrypt. |

### Backend additions to build (in order)

1. **Run events:** `GET /v1/demo/runs/:runId` (snapshot) and `GET /v1/demo/runs/:runId/events?after=<seq>` (polled every 1–2 s), using Codex's envelope (§6.2). The agent writes structured events, and the API serves them through a sanitized adapter. Keys, plaintext and paths are never included.
2. **Demo signer:** `GET /v1/demo/capabilities`, `POST /v1/demo/jobs/:id/fund`, `POST /v1/demo/jobs/:id/refund`, following Codex §6.3. Off by default.
3. **Recorded runs:** a versioned JSON per §6.4, with allowlisted fields. Replay never touches a signer.
4. **Act two:** a tampered-solver agent with its own key, and a refund action enabled only after chain expiry.

A runner split (prove without auto-submit, §6.5) is **not** needed for the video. It becomes optional for a live booth.

## 2026-11-16 23:30 -05:00 — Claude — Proof Chamber implemented (reconciles Codex §A–J)

- **Adopted:** editorial light shell + one dark physical stage; `#/` landing with the simulated lab, `#/app` live workspace, `#/job/<id>` linked job; Checks/Files/Transactions evidence drawer; solver column collapses into a drawer below 1536 px.
- **Physics:** `@react-three/rapier@2.2.0` (pinned; peers React 19 / R3F 9). 18 damped bodies, fixed 1/60 s step, persistent forces (frame-rate independent), capped drag spring, kinematic gate driven only by the semantic gate prop. Pauses offscreen/hidden; drops shadows and DPR when frame rate declines; SVG fallback for reduced motion or no WebGL.
- **Live projection (`lib/gate.ts`, tested):** gate opens only on paid/decrypted (release receipt); submitted shows the accepted beam with payout pending; rejected keeps the gate shut with one rebound and "preflight rejected, nothing sent"; no money stage from solver events alone.
- **Lab (`lib/lab.ts`, tested):** local fixture only, no API/chain/signer import; permanent "Simulation · no proof or payment" labels.
- **Replaced:** dark three-column layout, Vault3D, Beams, ProvingGrid (proving shows a real elapsed clock and the real proof chip on the chamber).
- **Not done yet:** separate `/replay/:id` route (replay still enters via presenter keys R/Shift+R and is labelled), Rapier bundle code-splitting (3.9 MB dev bundle), comprehension test and on-laptop frame-time measurement.
