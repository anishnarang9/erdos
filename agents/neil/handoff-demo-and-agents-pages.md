# Handoff: Demo (on the home page) and For Agents page

Updated 2026-11-18. The separate demo page was merged into the home page's demo section; `demo.html` now redirects to `index.html#lab`.

## Where things live (`commerce/web/public/site/`)

| File | Purpose |
| --- | --- |
| `index.html` `#lab` | Demo: how-to-test steps, three samples, proof replays, live activity feed |
| `demo-lab.js` | All demo logic (called from `site.js`, which passes the globe pulse and text-decode effect) |
| `recorded-proof.js`, `recorded-invoice.json` | Job #3 replay; re-checks the recorded delivery and key in the browser |
| `agents.html`, `pages.js`, `pages.css` | For Agents guide shell with draft placeholders |
| `demo.html` | Redirect to `index.html#lab` |

All pages share one menu: How it works, Demo, Arc results, For Agents, FAQ.

## What is real

| Sample | Step 2 (checks) | Step 3 (proof) |
| --- | --- | --- |
| 01 Match the invoices | Browser simulation (same rules as before) | Real Arc job #3 replay; job #4 refund linked |
| 02 Fit the kiln schedule | Browser simulation of the Meridian kiln limits | Proved on a local Arc fork only; no Arc testnet run yet |
| 03 Open bounty | Browser simulation | Real Arc open-claim jobs #7 (valid claim) and #6 (reverted claim, refund) |

The live activity feed labels every line: CHECK runs in the browser; ARC is read live from Arc testnet (`eth_getTransactionReceipt` for each receipt shown, `eth_blockNumber` every 4 s for the block ticker). Calls go to `/rpc` (Vercel and dev-server rewrite) and fall back to `https://rpc.testnet.arc.io`.

## To integrate later

1. Replace the browser simulations with API calls and stream engine events into `feed()` in `demo-lab.js`.
2. Run the kiln job on Arc testnet and add its receipts to sample 02.
3. Fill the For Agents placeholders.

After editing a script or stylesheet, bump its `?v=` reference so browsers do not serve stale copies.
