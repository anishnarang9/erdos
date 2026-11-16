# Localnet readiness and actions before the new Arc run

## 2026-11-15 22:49 -05:00 — Anish — Local-first readiness report

**Priority:** Complete and verify the new workload on localnet before another live Arc run for that workload. This report does not authorize implementation, a merge, wallet access, or live spending.

**Conclusion:** The main components exist. The remaining gate is a clean, repeatable exchange for the new problem on the integrated code. Do not count an older proof, an older Arc job, or passing assertions inside a failed test process as that gate.

### Evidence reviewed

This checkout is the older engine branch, `codex/anish-engine` at `adda3a3`. The report also inspected:

- Integration branch `codex/engine-commerce` at `2d9f2fd`, plus unpublished workload, test, documentation and report files in its existing worktree.
- Settlement branch `nick-settlement` at `57c387f`.
- Refreshed commerce branch `neil/plan-architecture` at `85ca5bb`.

This was a source and evidence review. No test suite, proof generation, or live transaction ran for this report. Counts below describe existing reports, not checks repeated here. Unpublished files remain provisional.

### Current position

| Area | Evidence | Remaining limitation |
| --- | --- | --- |
| Engine and settlement | Real Groth16 receipts, verifier tests, API/worker integration, restricted signing and independent buyer recovery exist. | Component tests do not establish the new full run. |
| Older local workload | The source-stamped rehearsal at `9458a81` generated one proof in 583.188 seconds. Its lifecycle checks include the exact 1,000,000-unit payout, dual recovery, semantic oracle, negatives and a Funded-job refund. | Report status is `partial`: the process exited 1 after an unhandled cleanup error. The later timer fix at `2d9f2fd` has focused tests, not a new complete rehearsal. |
| New Meridian Kiln workload | Fresh Grok-native authoring, two independent solver candidates and a separate oracle exist. The semantic report records 34 oracle tests and agreement on 39 differential cases, plus two follow-up mutations. | Files are unpublished. No complete new-workload funded local proof, payout and recovery report was found. |
| Arc deployment | Nick reports the core frozen. Independent integration evidence checks code, wiring, roles, fees and verifier pins. | Deployment readiness is not new-job acceptance or permission to spend. |
| Earlier Arc exchange | Neil records a reconciliation payout and exact recovery, plus a separate failing-job refund, in `commerce/evidence/arc-first-funded-jobs.md`. | Different workload and branch. The failing proof was rejected by preflight, not a mined rejected submission. This report did not independently replay the live evidence. |

## Ordered actions

### 1. Establish one source candidate

**Lead:** Anish integration. **Review:** Nick for settlement, Neil for commerce.

- Use the integration branch, not this engine-only checkout.
- Review the unpublished Meridian artifacts, fixture selector, oracle and documentation changes.
- Compare Neil's newer branch with the already integrated `8584b04` history. Review useful changes without replacing the hardened signer or restart controls.
- Commit the reviewed source candidate. Record its SHA and exact workload hashes before proving.

**Exit:** One identified candidate contains the engine, actual contracts, API, worker and new workload. No required code exists only in an untracked file.

### 2. Freeze the local acceptance inputs

**Lead:** Anish integration.

- Bind the English request, dataset, output declarations, normalized plan and independent oracle by hash.
- Recheck both valid solutions and requirement-breaking mutations.
- Preserve the distinction between verdict zero and malformed input. Duplicate lookup keys and arithmetic errors can abort instead of producing a failing receipt.
- Keep candidate answers out of constraint authoring.

**Exit:** The reviewer can map all 13 requirements to the 19 rules. Independent checks accept different valid solutions and reject meaningful violations.

### 3. Verify the local environment

**Lead:** Anish integration. **Settlement support:** Nick.

- Use pinned Arc Foundry and forkless, loopback-only Arc Anvil.
- Use the real Groth16 verifier, actual patched core and hook, and Arc's local native-USDC behavior.
- Do not use the convenience `SETTLEMENT_LOCAL=1` deployment as proof acceptance. Its documented default installs a mock verifier.
- Use fresh local-only accounts, private persistent attempt storage, and no external RPC or operator wallets.
- Prevent host sleep. Run guest builds and proving sequentially.
- Budget expiry from measured proving time plus funding, submission, release and recovery overhead. The contract's 600-second minimum is not a sufficient proving budget by itself.

**Exit:** Tool checks, contract tests, fixture-selector checks and typechecks pass. The cleanup regression is fixed and covered.

### 4. Run the complete new-workload exchange

**Lead:** Anish integration. **Commerce review:** Neil.

Run the real API and worker against the local contracts:

1. Import the reviewed plan through the API. Record its actual authoring provenance.
2. Approve the exact revision and references.
3. Compile through the real engine. Retain the package and commitments.
4. Quote and select the local provider.
5. Create the job, set the Poster-only budget, approve exactly 1,000,000 USDC base units, and fund.
6. Read the actual job ID and confirmed frozen terms.
7. Generate a fresh proof bound to that local chain, core, job, provider and package.
8. Submit through the restricted provider signer. Confirm `ProofAccepted` and Submitted state.
9. Release the matching key. Confirm Completed state, `KeyReleased` and the exact bounty payment.
10. Recover ciphertext and key from confirmed local chain data using a separate buyer path.
11. Decrypt with SDK and engine. Compare all file names and bytes.
12. Run the independent semantic oracle on the recovered files.

**Exit:** The entire process exits 0 without unhandled errors. A source-stamped report records all checks. Never substitute an archived receipt or synthetic precomputed context.

The new native Grok authoring is separate evidence. Importing its plan does not demonstrate a live HTTP drafting call or autonomous runtime solving. Those claims require their own runs.

### 5. Close rejection, refund and restart gaps

**Lead:** Anish integration. **Settlement review:** Nick.

- Generate a genuine verdict-zero receipt for a well-formed invalid Meridian delivery. Show that the verifier accepts its original journal but the passing-only settlement path rejects it.
- Check changed seal, ciphertext, image, commitments and cross-job replay. Confirm rejected submissions preserve funds.
- Check wrong caller, wrong key, early release and duplicate settlement.
- Check refunds from both Funded and Submitted states, including exact expiry. Keep these separate from the successful payout case.
- Resume after interrupted submit and release observations. Confirm no duplicate transaction or payout.
- Test a genuinely pending or uncertain send separately. Suppressing one receipt response after auto-mining does not cover that case.
- Never simulate or estimate release with the actual key. Report potential disclosure separately from confirmed payment.

**Exit:** Required cases have explicit evidence. Report real transactions, read-only calls, unit fixtures and skipped checks separately.

### 6. Publish and reproduce the result

**Lead:** Anish integration.

- Preserve the earlier partial attempts. Write Meridian results to a separate report.
- Run locked Rust, commerce, real-engine API, oracle, contract and examples checks.
- Require green commerce and core-fast CI for the final pushed SHA.
- Reproduce the documented local procedure from a clean checkout. Keep slow proof checks explicit rather than silently skipped.
- Publish sanitized receipts, commitments, tool versions, source/workload hashes, proof timing, payment and recovery results.

The explicit slow suite is `commerce/worker/vitest.funded.config.ts`. The unpublished selector uses `UBC26_FUNDED_WORKLOAD=meridian`. Review and publish that selector before treating this as a supported command.

## Gate before another live run of this workload

Proceed only when:

- The new workload completes fresh proof, acceptance, payout and independent recovery locally.
- The complete test process exits 0.
- Required rejection, refund and restart checks pass.
- Final source and evidence are published, with green checks and clean-checkout reproduction.
- Any remaining limitations are explicit.

Only then prepare the live run: approve actual accounts, exact terms and spending caps, refresh deployment checks, fund a new Arc job, and prove again for its confirmed context. A local proof cannot settle that different live job.

Buyer UI polish, x402, marketplace listings and additional integrations do not block this backend gate. If “fully working product” includes a browser-only buyer workflow, add that as a separate acceptance requirement. It is not established by the current local suite.
