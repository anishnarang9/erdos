# UBC-26 demo checklist — November 18, 2026

**Demo claim:** UBC-26 pays agents on Arc Testnet when a proof shows that a small, structured deliverable passes buyer-approved checks. The proof covers those checks. It does not establish unstated requirements or the truth of source data.

**Tomorrow's target:** Publish a working preset demo with confirmed Arc evidence and a recorded fallback. Public buyer authoring still returns HTTP 503. Present the site as a demo until the [hosted release gates](hosted-backend-handoff-2026-11-17.md#remaining-work-in-dependency-order) pass.

## To do

- [ ] **Anish — freeze the demo presets.** Use invoice reconciliation and Meridian resource allocation. For each preset, give Neil the exact brief, input and output files, rules in plain words, one passing example, one failing example, and final screen copy. Mark signed-evidence inventory as a **candidate pilot**. Keep each delivery within 16 files and 16,384 encoded bytes. Sources: [invoice demo and PR #5](https://github.com/anishnarang9/UBC-26/pull/5), [Meridian workload](fresh-exchange-input/README.md), [capability limits](../engine/capabilities-v1.json).
- [ ] **Anish — prepare the UI handoff and agent card.** Bring the merged PR #5 UI into the demo release branch. Supply each preset's job link, status source, expected Arc links, and copyable runner steps. Use the [public developer guide](public/README.md), [API contract](public/api.md), and [operator commands](hosted-client.md#fund-and-run-supplied-deliverables).
- [ ] **Nick — verify Arc inputs.** Check the deployed addresses before funding. After Anish runs each job, confirm funding, expiry, claim, release, payout, and explorer links against chain state. Give Anish and Neil a short receipt table. Use the [deployment manifest](../contracts/deployments/open-claim-arc-testnet.json) and [Arc operator guide](overnight/open-claim-testnet-operator.md).
- [ ] **Anish — run the exact demo jobs.** Obtain exact approval for any new testnet spend. Fund each frozen job, then generate its proof from the confirmed funded context. Record the expiry, submission, payout, and byte-exact recovery. Keep the [November 16 Arc acceptance](../agents/anish/reports/open-claim-arc-live-acceptance-2026-11-16.md) labelled as earlier evidence.
- [ ] **Neil — build the demo UI only.** Replace free-text requests, quote selection, wallet funding, and “Open Workspace” with preset cards, readable exact checks, confirmed Arc status, receipt links, and a “send this to your agent” card. Label live and recorded states. Check desktop and phone layouts. Anish owns the data, API, runner, funding, and deployment. Nick owns Arc verification.
- [ ] **Anish — rehearse and publish.** Rehearse the full agent run and settlement with Neil's UI. Record a clearly labelled fallback for network failure. Publish the demo, the preset specs, the agent steps, and Nick's receipt table. Run the relevant checks at the release commit. Use the [runner guide](public/README.md) and [hosted handoff](hosted-backend-handoff-2026-11-17.md).

## Documents to hand to the team

1. **Preset sheet, from Anish to Neil:** exact brief, files, checks, examples, screen copy, job link, and live or recorded label for each card.
2. **Agent quickstart, from Anish to Neil:** installation link, job link, local check, prepare after funding, run, and recovery steps. Start with the [public guide](public/README.md#fund-solve-and-recover).
3. **Arc receipt sheet, from Nick to Anish and Neil:** job ID, confirmed status, expiry, funding, claim, release, payout, and explorer links. Start with the [live acceptance report](../agents/anish/reports/open-claim-arc-live-acceptance-2026-11-16.md).
4. **Demo script and fallback, from Anish:** exact speaking points, live steps, recorded steps, and the known limits. The release key becomes public when its transaction is broadcast. Resource allocation demonstrates feasibility, not optimality.
