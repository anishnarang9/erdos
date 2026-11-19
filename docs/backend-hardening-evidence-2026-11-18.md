# Backend hardening evidence — November 18

**Decision at 09:09 -05:00:** Keep general buyer authoring gated and keep the public API on its accepted release. The cold Arc job 9 passed its scoped end-to-end test. Natural-language authoring has not passed a reliability test.

## Results kept separate

| Evidence | Result | Limit |
| --- | --- | --- |
| Fresh independent buyer and solver, Arc job 9 | Proof, claim, release, 0.01 testnet USDC payout, byte-exact recovery, and independent oracle passed | One scoped task; buyer recovery had one transient 503 and solver needed read-only journal reconciliation |
| First ten-case authoring pilot | 0 complete successes; 5 `invalid_reply`, 3 invalid plans returned as unsupported, 1 Bot pass then compile failure, 1 missing clarification | API charges totaled $0.063529; one Bot charge lacks exact per-review attribution |
| Second authoring pilot | First supported case returned `plan_invalid`; 0 Bot dispatches; campaign stopped | One settled $0.006600 API charge; remaining nine cases did not run |
| Third authoring diagnostic | First supported case returned a native-valid draft that rejected both valid hidden outputs; 0 Bot dispatches; campaign stopped | One settled $0.008637 API charge; conservative observed upper $0.028637; remaining nine cases did not run |

See the [case classification](../agents/anish/reports/authoring-pilot-failure-classification-2026-11-18.md), [second failure record](../agents/anish/reports/authoring-round2-first-failure-2026-11-18.json), [third failure record](../agents/anish/reports/authoring-round3-first-failure-2026-11-18.json), and [job 9 audit](../agents/anish/reports/hosted-cold-agent-arc-job9-2026-11-18.json). The four first-pilot `invalid_reply` provider bodies other than the first `pier-drawers` trace are not retained locally. Their exact format errors are unknown.

## Offline candidate and measured checks

- The draft prompt now explains nested `record_field` levels and requires JSON field declarations to follow buyer evidence. This wording has no live provider result. Native validation and the hidden oracle remain release gates.
- The third diagnostic exposed a plan that was native-valid yet rejected both valid hidden outputs because it invented a top-level field. It also used `referenceFiles[0]` as a quote path, which did not verify. The next source candidate limits provider quote paths to the request and named references, and explains that a separate text output does not create a JSON field. This change passed offline tests only; the failed live result remains failed.
- The API now evaluates every buyer-supplied example against the generated plan, even if the model omits that example. It reuses checks for examples the model selected, and runs only the unselected examples again. An immutable disagreement blocks exact-revision approval even if the buyer later submits a separate passing example check. A red regression showed the prior gap; matching and disagreeing cases now pass. The retained third-pilot plan is native-valid but rejects the new public positive fixture and both valid hidden outputs, so this gate would detect that class of false rejection. It does not repair the plan or prove live authoring reliability.
- The API now creates configured compiler temp and cache directories before launching a native engine. The clean-state compile regression failed before this change and passed after it. This addresses the setup class behind the first pilot's compile failure; it does not relabel that failed attempt.
- The new frozen offline corpus has ID `hosted-qualification-2026-11-18` and digest `ea51f1ff461c88d63dfafc75b4cd5f048cab0958ce7b51d7c2ca5f36054688d8`. It contains 62 briefs across 22 families: 42 supported, 10 ambiguous, and 10 unsupported. Thirty-five briefs include references; outputs cover JSON, text, and binary files. The two new procurement cases have independent domain oracles and hidden candidates.
- A separate next-corpus revision has ID `hosted-qualification-2026-11-18-public-examples` and digest `8acf192a48f3c72a200a53ed628246a2fbdcbe339bcc4743253a7789d85f2cd7`. It adds buyer-visible positive and negative examples to the eight supported diagnostic briefs. Sixteen fixtures agree with both the domain oracle and native engine; none duplicates a complete hidden candidate. The original corpus and its failed live results stay fixed. This next version has no live model result.
- All 69 qualification tests passed, including the next-corpus fixtures and retained failed-plan regression. The native engine matched the independent oracle on 344 hidden candidate checks with zero failures. Full `pnpm check` passed: SDK 535 tests and 13 chain fixtures, API 1,040 tests, web 4, worker 1,048, and all workspace typechecks. These are local checks, not live model reliability.
- One new procurement case also completed a real local Groth16 proof under a synthetic context. The proof returned verdict 1 in 274.676 seconds. Decryption recovered the exact receipt bytes, and the independent oracle passed the recovered file. The [proof report](../agents/anish/reports/offline-procurement-proof-2026-11-18.json) keeps its image, rule, reference, proof and file hashes. This did not involve model authoring, Bot review, or Arc settlement.
- The qualification scorer now recognizes the API's structured `capability_unsupported` result only when its operation kind and name match the frozen expected capability. A regression failed before the fix and passed after it; all 68 current qualification tests pass. This prevents a correct capability response from being marked wrong during a later live campaign.

## Task boundary at this checkpoint

The native checker can express bounded file checks over JSON scalar fields and collections, text bytes, and opaque binary hashes. Tested offline families include ledger reconciliation, inventory limits, budgets, badge rules, schedules, route constraints, quantity checks, signed custody evidence, firmware file checks, and purchase-order receipts. These cases establish checker behavior for explicit rules and committed inputs. They do not show that a model will draft the right rules from each brief.

The current proof cannot establish an unstated buyer goal or external truth. A missing toll table, unit, threshold, or policy calls for buyer clarification. A subjective or external claim without a committed reference or approved signed evidence cannot be made payable by the current checker. The corpus has 10 ambiguous and 10 unsupported briefs to test those boundaries, but no live repeat-run accuracy result for them.

## Recovery checks and their limit

The full commerce check includes API regressions for owner-bound draft idempotency, retained spend reservations after an uncertain dispatch, Bot callback replay and failed delivery, and queued Bot work after restart. Worker tests cover a confirmed release receipt when local journal reconciliation fails, plus read-only resume without another claim or release send. The new native compiler test starts with no state directories. These tests exercise controlled failures. They do not prove that every live RPC, provider callback, or filesystem failure is recoverable. Job 9's transient first recovery read and local journal error remain observed operational faults.

A charge-write fault test found that a completed draft could be stored before its spend reservation settled. Task result and charge state now commit in one SQLite transaction. An injected settlement write failure leaves the dispatched task `running`; restart marks it `uncertain` and does not make a second model call. This is controlled local evidence, not a live provider crash drill.

After the stopped third diagnostic, the isolated pilot restarted with its saved state. A read-only task fetch returned the same revision and provider usage as the protected journal, with no new paid call. The pilot stopped again; public readiness and discovery remained HTTP 200. This confirms one saved-task recovery path, not all uncertain dispatch or callback failures.

The job 9 solver's confirmed-release journal fault has a read-only receipt path in the candidate runner; 15 focused receipt and journal tests passed. The buyer recovery command now retries one transient public job GET after HTTP 502/503/504 or a timeout. It keeps the same job ID, does not retry a 404, and stops after the second failure. This addresses the manual read-only retry seen after job 9, but has not been exercised against a new live failure.

## Release gate still open

1. Inspect the four missing provider bodies if the account logs are available. Preserve unknown causes where the exact response cannot be recovered. Test parser fixes against retained or controlled raw responses.
2. Test real drafts repeatedly on a frozen case set. The current qualification harness requires three fresh trials for each case, so this 62-case corpus would require 186 distinct calls. Score valid plans against hidden candidates; require zero false accepts and malformed accepts, and at least 95% semantic agreement for supported cases. Report clarification and unsupported accuracy separately. A smaller pilot can diagnose faults but cannot claim this gate.
3. For accepted supported plans, test exact Bot review, approval, queued compile, package verification, and local proof on a representative set. Record failures, latency, and complete-run cost. Verify saved task and chain journals cannot duplicate paid calls or transactions after restart or uncertain reads.
4. Set a separate production Bot account boundary and an attributable complete-run cost policy. The target is a 5–10¢ average including Bot review; the model-only mean in the old qualification harness is not enough.
5. Before any new paid campaign, freeze its cases, call count, maximum spend, per-attempt stop, account meter, and attribution rule. The second and third campaigns each stopped after one failed case. Their unused slots do not authorize another call or form a passing campaign.

The [third bounded diagnostic](authoring-next-bounded-qualification-2026-11-18.md) records its stopped ten-case stage and the wider repeat-run gate. The separate public-example corpus is an offline candidate for a future scope. No future paid dispatch is authorized here.

The post-campaign source changes made no additional paid model call, credit purchase, public deployment, or Arc transaction.
