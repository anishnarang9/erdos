# Hackathon demo runbook

**Show the buyer receiving the files and the solver receiving payment, then change one cent and show why escrow stays locked.** Invoice reconciliation is the main example. Meridian kiln scheduling shows how another specialist can use the same idea for a different deliverable.

## Evidence available today

| Run | What the team demonstrated | Evidence |
| --- | --- | --- |
| Arc Testnet job 3 | The buyer approved the checks and funded the selected solver. A 147.7-second Groth16 proof passed. One release paid 0.01 testnet USDC and published the key. The browser recovered the files. | [Run record and receipts](../commerce/evidence/arc-first-funded-jobs.md), [saved recording](../commerce/web/recordings/run-2026-11-16-job3-paid.json) |
| Arc Testnet job 4 | A one-cent error produced verdict 0. Submit preflight rejected it. The solver sent no submission. The buyer recovered the budget after expiry. | [Rejection record and confirmed refund](../commerce/evidence/arc-first-funded-jobs.md) |
| Agent-to-agent open bounty, job 9 | Independent buyer and solver agents completed a funded job. Buyer recovery matched the expected four bytes. The audit documents later read-only retries and reconciliation. | [Job 9 audit](../agents/anish/reports/hosted-cold-agent-arc-job9-2026-11-18.json) |
| Meridian scheduling | An independent solver found feasible schedules under the agreed rules. The website illustrates the capacity check with a 96 kg load. | [Workload, candidates, engine results and remaining gates](fresh-exchange-input/README.md) |

The landing page offers a local invoice simulation and a step-through of job 3. The final replay step hashes the saved envelope and released key with the recorded context and compares the results with the recorded commitments. The file previews come from the original delivery. The Arc submit receipt is the evidence of on-chain proof acceptance.

## Record the submission

| Edited time | Presenter action | Evidence the audience should see |
| --- | --- | --- |
| 0:00–0:15 | Show the two invoices. Ask whether an agent should pay for a ledger that is one cent off. | Expected and delivered amounts fit on one screen. |
| 0:15–0:50 | Show the buyer request, approved checks, solver and confirmed funding from the fresh invoice run. | Same job ID and agreed budget across these shots. Identify the allocation mode actually used. |
| 0:50–1:20 | Capture the solver preparing its files, proving and submitting. Shorten the wait in the edit. | On-screen “time-lapse · real time m:ss”, actual proof duration and the confirmed acceptance receipt. |
| 1:20–1:50 | Open the release receipt, then open the recovered invoice result. Hold on the rows long enough to read them. | Payout and key release share a receipt. The result contains the expected IDs and amounts. |
| 1:50–2:25 | Follow a second job with a one-cent error. Film the failed check and preflight, then return after actual expiry to capture its refund. | Same failing job ID across both clips, zero payout, and its confirmed refund receipt. |
| 2:25–2:45 | Switch to Meridian. Move Harbor’s 96 kg load from the 110 kg kiln to the 88 kg kiln. | The local check reports an 8 kg overload. Describe this as a feasibility demonstration. |

## Before recording

- **Anish** freezes the exact briefs, rules, deliverables, and reference files and runs the prepared buyer and solver flow. Save the original recording, job identifiers, event times and recovered files for each run.
- **Nick** checks the confirmed funding, submit, release and refund receipts against the correct job numbers, amounts and parties. Keep the failing job open through its real expiry.
- **Neil** captures the uninterrupted run at 1080p and edits the 2–3 minute submission. Keep “Simulation”, “Recorded run” or “Live · Arc Testnet” visible as appropriate. Use the robot and escrow visuals to explain the corresponding steps.
- **Acceptance before export:** match every financial claim to its receipt, compare the recovered invoice file to the reference, and check the video at projector size with captions. A fresh recording and the final edited video remain deliverables to verify.

For a booth or a network interruption, open **Explore the demo → Show the proof** and use the labelled job 3 recording. In the escrow section switch between **Correct delivery** and **One cent off** to open the job 3 release or job 4 refund. Keep [the frontend specification](ORBIT-26-FRONTEND-SPEC.md) and [the launch checklist](demo-launch-checklist-2026-11-18.md) alongside the receipt sheet.
