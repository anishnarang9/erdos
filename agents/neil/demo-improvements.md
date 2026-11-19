# Demo: known flaws and suggested improvements

Written 2026-11-18 for handoff to other agents. Scope: the landing page demo (`commerce/web/public/site/index.html#lab`, logic in `demo-lab.js`), the For Agents page, and how both are deployed. Read `handoff-demo-and-agents-pages.md` first for what exists.

Each item says what is wrong, why it matters, and what "done" looks like. Priority: **P1** fix before the video and judging, **P2** worth doing if time allows, **P3** later.

## 1. Honesty and correctness

| # | Pri | Flaw | Why it matters | Done when |
| --- | --- | --- | --- | --- |
| 1.1 | P1 | **The demo is a replay, not a live run.** Checks are hard-coded per sample (`results` arrays in `demo-lab.js`), and stage timings are shortened. Labels say "replay" and "runs in your browser", but a judge could still read "Run this job" as a live job. | Overclaiming loses trust faster than a modest demo. | Button reads "Replay this job" or the note sits next to it; or 2.1 is done and runs are live. |
| 1.2 | P1 | **Event names are not checked.** The "Look for" column (JobFunded, ProofAccepted…) is static text. The page confirms only that each transaction exists and succeeded or failed. | A wrong label would go unnoticed. | Decode each receipt's logs (topic0 = keccak of the event signature, using the ABIs in `commerce/sdk/src/chain/arc/abi`) and show ✓ per expected event. |
| 1.3 | P2 | **Job #4 shows no proof on chain.** By design the failing proof was never sent, so the evidence is the fund and the refund only. The "Nothing sent" stage explains it, but there is nothing to click. | A sceptic may ask how we know the proof failed. | Link the worker run log or the recorded verdict-0 preflight result (in `commerce/evidence`). |
| 1.4 | P2 | **The bounty's checks are illustrative.** "No earlier winner" and "Proof matches the rules" are not computed; they mirror the recorded outcome. | Same as 1.1. | Read the adapter's `submissions(jobId)` live to show the winner, or label them as recorded. |
| 1.5 | P2 | **The kiln (Meridian) sample was removed** because it has no Arc testnet run. The use-case card now says "Proved locally". | It is our most interesting workload. | Run it once on Arc testnet and add it as sample 04 (its data is still in `docs/fresh-exchange-input`). |

## 2. Make it truly live

| # | Pri | Suggestion | Done when |
| --- | --- | --- | --- |
| 2.1 | P2 | **Drive the demo from the hosted API.** Create a job, fund it with the demo signer, and stream the solver's run events (`GET /v1/demo/runs/:id/events`) into `feed()`. Keep the replay as a fallback when the API or prover is down. | A visitor can start a real job and watch real engine events; replay is labelled "Replay" only when used. |
| 2.2 | P2 | **Show engine telemetry honestly.** Real events are discrete (`proof.started`, `proof.finished` with cycles and seconds, `submission.*`, `release.*`). Show an elapsed timer during proving, never a fake percentage. | The progress bar advances only on real events during a live run. |
| 2.3 | P3 | **Let visitors check their own transaction hash** with a field that runs the same receipt check. | Paste any Arc tx and get status, block and decoded events. |

## 3. Code quality and maintenance

| # | Pri | Flaw | Done when |
| --- | --- | --- | --- |
| 3.1 | P1 | **Transaction hashes are copied in several places**: `demo-lab.js`, the escrow inspector in `site.js`, the case studies in `index.html`, `recorded-invoice.json`, and `commerce/evidence/*.md`. | One `evidence.json` in `public/site/` (job → tx hashes, figures) that every file reads. |
| 3.2 | P1 | **No tests for the demo.** `demo-lab.js` has no unit or browser test; I checked it by hand only. | A Playwright test runs all three samples against a mocked RPC and asserts stages, verdicts and the verify table. Unit-test that the sample data matches `evidence.json`. |
| 3.3 | P2 | **Two robot WebGL scenes** run at once (Solutions section and the demo), plus the globe and coin. On low-memory machines this is heavy; this laptop already hit memory stops. | Pause robots off-screen (they already skip frames when hidden), or share one renderer. Measure memory on a mid-range laptop. |
| 3.4 | P2 | **Cache-busting is manual.** Every edit needs `?v=` bumps in several files; forgetting one serves stale code. | Move the site into the Vite build (hashed filenames), or add a tiny script that stamps versions. |
| 3.5 | P3 | **Leftover code.** `initRecordedProof()` in `recorded-proof.js` is no longer used by the home page; `pages.css` and the old `.lab-panel` rules may hold unused selectors. | Remove dead code after confirming no page uses it. |
| 3.6 | P3 | The local preview server (`python -m http.server`) has no `/rpc`, so the console shows 501 errors before the fallback to Arc's public RPC. | Harmless on Vercel and Vite. Optionally try the public RPC first when `location.port === '4180'`. |

## 4. UX and accessibility

| # | Pri | Suggestion | Done when |
| --- | --- | --- | --- |
| 4.1 | P1 | **Explain the result in one sentence above the verify table** ("This job paid because…"), and the verify-table headers on phones (they are hidden under 1100 px). | A first-time visitor understands the outcome without reading the table. |
| 4.2 | P2 | **Explorer links open in a new tab with no hint of what to click there.** Add a small "What you'll see" tooltip or screenshot for one transaction. | Non-crypto judges can verify one transaction unaided. |
| 4.3 | P2 | **Keyboard and screen reader pass.** The robot is decorative (`aria-hidden`), and stage changes are announced through the feed only. | Run axe; announce stage changes in a polite live region; full run possible by keyboard. |
| 4.4 | P2 | **Reduced motion:** runs complete instantly (`sleep` returns 0), so the stages are hard to follow. | Keep short, non-animated pauses under reduced motion. |
| 4.5 | P3 | The live feed keeps 40 lines and has no clear button or filter. | Add "Clear" and an ARC-only filter. |

## 4b. Motion (added 2026-11-18)

Current motion: scroll reveals (main's `scroll-enter`, now also on the how-to, sample buttons, live panel and follow-up), the solver robot changing pose per stage, a shimmering progress bar while running, ticks popping in per stage, a green or red glow on the solver panel at the verdict, and staggered entry of the result and verify rows. All of it is disabled under reduced motion.

| # | Pri | Suggestion | Done when |
| --- | --- | --- | --- |
| 4b.1 | P2 | The robot's pose changes, but it has no "failed" gesture for job #4; it simply returns to compiling. | A head-shake or red-eye pose in `robot.js` for refused runs. |
| 4b.2 | P2 | The globe at the top reacts to outcomes (`setOutcome`), but it is off-screen during the demo. | Add a small coin or escrow animation in the solver panel: coin locks on fund, flies to solver on release, returns to buyer on refund. |
| 4b.3 | P3 | Three WebGL scenes plus the hero planets are heavy (see 3.3). | Profile with Performance panel; drop to one robot. |

## 5. For Agents page

| # | Pri | Gap | Done when |
| --- | --- | --- | --- |
| 5.1 | P1 | Every section after Overview is a **draft placeholder**. | Fill from `docs/public/solver.md` and `commerce/api/src` (routes, auth message format, quote EIP-712 types). |
| 5.2 | P2 | No runnable example. | A copy-paste script that lists jobs and posts a signed quote against the hosted API. |

## 6. Deployment

| # | Pri | Issue | Done when |
| --- | --- | --- | --- |
| 6.1 | P1 | **Vercel blocks deploys of commits authored by `Neilyoo98`** ("Git author must have access to the project"). The account `neilyoo98` did not yet appear in Anish's team when last checked. | Neil accepts the team invite; a merge by Neil deploys; or Anish redeploys `main`. |
| 6.2 | P1 | After every merge, check the live site, not just the local preview. | Visit the production URL and run all three samples; the Arc block ticker updates. |
| 6.3 | P2 | No hosted API, so the workspace (`/#/app`) cannot run live jobs on Vercel. | API hosted (Anish's DigitalOcean plan) and `/v1` rewritten in `commerce/web/vercel.json`. |

## Suggested order for the next agent

1. 6.1 and 6.2 (get the right version live), then 1.1 and 4.1 (honest labels, clear result).
2. 3.1 and 3.2 (single evidence file, Playwright test), so later changes are safe.
3. 1.2 (decode events), 5.1 (fill the guide).
4. 2.1–2.2 when the hosted API exists.
