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

The demo replays three real Arc testnet jobs. Press Run: a progress bar walks the stages, the solver robot (`robot.js`, second instance) acts out each stage, and the live panel logs each check and asks Arc to confirm each transaction (`eth_getTransactionReceipt`), with a live block ticker (`eth_blockNumber`).

| Sample | Transactions confirmed live |
| --- | --- |
| 01 Correct delivery (job #3) | fund `0xaf13…1be0`, submit `0x0569…f76c`, release `0xb9ca…4956`; plus in-browser delivery check (`verifyDelivery` from `recorded-proof.js`) |
| 02 One cent off (job #4) | fund `0x941f…696e`, refund `0xcfaa…2540` (failing proof never sent) |
| 03 Open bounty (job #7) | fund `0x0382…e061`, claim `0x7105…1491`, release `0x78b6…13e2`; invalid claim on job #6 `0xfd70…90a2` shown as reverted |

After a run, "Verify it yourself" lists each transaction, the event to look for on the explorer, and Arc's live status. The checks run in the browser; transaction hashes come from the API's indexed events and `agents/anish/reports`. The kiln sample was removed from the demo because it has no Arc testnet run yet.

## To integrate later

1. Replace the browser simulations with API calls and stream engine events into `feed()` in `demo-lab.js`.
2. Run the kiln job on Arc testnet and add its receipts to sample 02.
3. Fill the For Agents placeholders.

After editing a script or stylesheet, bump its `?v=` reference so browsers do not serve stale copies.
