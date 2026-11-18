# Backend hardening evidence — November 18

**Decision at 09:09 -05:00:** Keep general buyer authoring gated and keep the public API on its accepted release. The cold Arc job 9 passed its scoped end-to-end test. Natural-language authoring has not passed a reliability test.

## Results kept separate

| Evidence | Result | Limit |
| --- | --- | --- |
| Fresh independent buyer and solver, Arc job 9 | Proof, claim, release, 0.01 testnet USDC payout, byte-exact recovery, and independent oracle passed | One scoped task; buyer recovery had one transient 503 and solver needed read-only journal reconciliation |
| First ten-case authoring pilot | 0 complete successes; 5 `invalid_reply`, 3 invalid plans returned as unsupported, 1 Bot pass then compile failure, 1 missing clarification | API charges totaled $0.063529; one Bot charge lacks exact per-review attribution |
| Second authoring pilot | First supported case returned `plan_invalid`; 0 Bot dispatches; campaign stopped | One settled $0.006600 API charge; remaining nine cases did not run |

See the [case classification](../agents/anish/reports/authoring-pilot-failure-classification-2026-11-18.md), [second failure record](../agents/anish/reports/authoring-round2-first-failure-2026-11-18.json), and [job 9 audit](../agents/anish/reports/hosted-cold-agent-arc-job9-2026-11-18.json). The four first-pilot `invalid_reply` provider bodies other than the first `pier-drawers` trace are not retained locally. Their exact format errors are unknown.

## Offline candidate and measured checks

- The draft prompt now explains nested `record_field` levels and requires JSON field declarations to follow buyer evidence. This wording has no live provider result. Native validation and the hidden oracle remain release gates.
- The API now creates configured compiler temp and cache directories before launching a native engine. The clean-state compile regression failed before this change and passed after it. This addresses the setup class behind the first pilot's compile failure; it does not relabel that failed attempt.
- The new frozen offline corpus has ID `hosted-qualification-2026-11-18` and digest `ea51f1ff461c88d63dfafc75b4cd5f048cab0958ce7b51d7c2ca5f36054688d8`. It contains 62 briefs across 22 families: 42 supported, 10 ambiguous, and 10 unsupported. Thirty-five briefs include references; outputs cover JSON, text, and binary files. The two new procurement cases have independent domain oracles and hidden candidates.
- All 66 qualification tests passed. The native engine matched the independent oracle on 344 candidate checks with zero failures. Full `pnpm check` passed: SDK 535 tests and 13 chain fixtures, API 1,037 tests, web 4, worker 1,048, and all workspace typechecks. These are local checks, not live model reliability.
- One new procurement case also completed a real local Groth16 proof under a synthetic context. The proof returned verdict 1 in 274.676 seconds. Decryption recovered the exact receipt bytes, and the independent oracle passed the recovered file. The [proof report](../agents/anish/reports/offline-procurement-proof-2026-11-18.json) keeps its image, rule, reference, proof and file hashes. This did not involve model authoring, Bot review, or Arc settlement.

## Task boundary at this checkpoint

The native checker can express bounded file checks over JSON scalar fields and collections, text bytes, and opaque binary hashes. Tested offline families include ledger reconciliation, inventory limits, budgets, badge rules, schedules, route constraints, quantity checks, signed custody evidence, firmware file checks, and purchase-order receipts. These cases establish checker behavior for explicit rules and committed inputs. They do not show that a model will draft the right rules from each brief.

The current proof cannot establish an unstated buyer goal or external truth. A missing toll table, unit, threshold, or policy calls for buyer clarification. A subjective or external claim without a committed reference or approved signed evidence cannot be made payable by the current checker. The corpus has 10 ambiguous and 10 unsupported briefs to test those boundaries, but no live repeat-run accuracy result for them.

## Recovery checks and their limit

The full commerce check includes API regressions for owner-bound draft idempotency, retained spend reservations after an uncertain dispatch, Bot callback replay and failed delivery, and queued Bot work after restart. Worker tests cover a confirmed release receipt when local journal reconciliation fails, plus read-only resume without another claim or release send. The new native compiler test starts with no state directories. These tests exercise controlled failures. They do not prove that every live RPC, provider callback, or filesystem failure is recoverable. Job 9's transient first recovery read and local journal error remain observed operational faults.

## Release gate still open

1. Inspect the four missing provider bodies if the account logs are available. Preserve unknown causes where the exact response cannot be recovered. Test parser fixes against retained or controlled raw responses.
2. Test real drafts repeatedly on a frozen case set. The current qualification harness requires three fresh trials for each case, so this 62-case corpus would require 186 distinct calls. Score valid plans against hidden candidates; require zero false accepts and malformed accepts, and at least 95% semantic agreement for supported cases. Report clarification and unsupported accuracy separately. A smaller pilot can diagnose faults but cannot claim this gate.
3. For accepted supported plans, test exact Bot review, approval, queued compile, package verification, and local proof on a representative set. Record failures, latency, and complete-run cost. Verify saved task and chain journals cannot duplicate paid calls or transactions after restart or uncertain reads.
4. Set a separate production Bot account boundary and an attributable complete-run cost policy. The target is a 5–10¢ average including Bot review; the model-only mean in the old qualification harness is not enough.
5. Before any new paid campaign, freeze its cases, call count, maximum spend, per-attempt stop, account meter, and attribution rule. The second pilot stopped after one failed case. Its unused nine calls are not a passing campaign or a reason to spend again automatically.

The [proposed next qualification](authoring-next-bounded-qualification-2026-11-18.md) freezes a ten-case diagnostic stage and names the wider repeat-run gate. It authorizes no spending.

No new paid model call, credit purchase, public deployment, or Arc transaction is part of this offline candidate.
