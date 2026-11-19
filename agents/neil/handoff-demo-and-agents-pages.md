# Handoff: Demo page and For Agents page

Written 2026-11-18 by Claude for Neil (Dayang Niu). Picks up wherever this session stops.

## What exists

Both pages live in `commerce/web/public/site/` next to the landing page, share its styles, and ship with the web build (`/site/demo.html`, `/site/agents.html`). Local preview: `python -m http.server 4180 --bind 127.0.0.1 --directory commerce/web/public/site`.

| File | Purpose |
| --- | --- |
| `demo.html` | Three sample problems. Pick one, choose a correct or faulty delivery, run it, see the on-chain proof. |
| `agents.html` | Documentation shell for solver agents: sticky guide index, 10 sections, "Draft" placeholders. |
| `pages.css` | Styles for both pages, built on `site.css` and `site-v3.css` tokens. |
| `pages.js` | Mobile menu, demo replay, guide-index highlighting. |

The home page navigation links to both ("Samples", "For Agents").

## Demo page: what is real and what is UI-only

Per Dayang's request this is UI only. "Run" replays recorded data and sends nothing.

| Sample | Correct delivery | Faulty delivery |
| --- | --- | --- |
| 01 Invoice reconciliation | Real: Arc job #3 (submit, release) | Real: job #4 (refund) |
| 02 Open bounty | Real: open-claim job #7 (fund, claim, release) | Real: job #6 (reverted claim, refund) |
| 03 Catalog conversion | Preview: no on-chain run; links say "available after integration" | Same |

All hashes and figures come from `commerce/evidence/arc-first-funded-jobs.md` and `agents/anish/reports/open-claim-arc-live-acceptance-2026-11-16.md`. The data lives in the `PROBLEMS` array at the top of `pages.js`.

## To integrate later

1. **Live runs:** replace `run()` in `pages.js` with calls to the API (`POST /v1/jobs`, approve, compile, select quote, fund, then poll `GET /v1/jobs/:id/submission`). The receipt renderer `render(run)` already takes `{ verdict, outcome, copy, metrics, hashes, txs, source }`; map the API response to that shape.
2. **Sample 03:** record a real catalog-conversion run, then fill its `txs` hashes and metrics.
3. **For Agents guide:** replace each dashed `.placeholder` block with the real content. Sections and anchors are fixed (`#overview` … `#faq-agents`). API paths and headers shown are checked against `commerce/api/src` as of `main` 2026-11-18.

## Deployment

The web app deploys on Vercel from `commerce/web` (`commerce/web/vercel.json`, hosted mode from PR #22). These pages are static files in `public/site`, so they deploy automatically with the next build. No new environment variables.

After editing `pages.js` or `pages.css`, bump the `?v=` number on their references in `demo.html` and `agents.html` so browsers do not serve stale copies.

## Checks done

- All six runs (3 samples × correct/faulty): verdict, pipeline colours (failing proofs stop red at "Verified on Arc", then refund), receipts and explorer links correct.
- Desktop 1920 px and phone 390 px: no horizontal scroll; phone menu opens; guide index links all resolve and highlight on scroll.
- No console errors.
