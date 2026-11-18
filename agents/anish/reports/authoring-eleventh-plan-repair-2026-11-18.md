# Eleventh authoring trial, 2026-11-18

Six frozen cases ran once on isolated source `82505b5` after exact-source commerce, engine, and contracts CI passed. The source includes current main at `a3f6cae`. The engine check included an independently installed runner. See the [frozen inputs and pins](../../../docs/authoring-eleventh-plan-repair-2026-11-18.md).

| Case | Task ID | Result | Latency (ms) | API charge |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-r14` | `01M7R3TGW09S6D4J8F2EJKAH7X` | Review ready | 7,925 | $0.007893 |
| `lot-expiry-1-r14` | `01M7R3TTHQKQJHMPYPRPX94NK5` | Review ready | 5,989 | $0.006128 |
| `pier-variance-r14` | `01M7R3V2S2ZQPFCW45WCB453BH` | Review ready | 9,480 | $0.009044 |
| `clearance-1-r14` | `01M7R3VDW2KT1FTCE6TB44TBKZ` | Oracle mismatch | 7,234 | $0.007378 |
| `badge-zone-1-r14` | `01M7R3VP0374B4WPTR6J1H3J6J` | Native invalid after repair | 11,344 | $0.016196 |
| `category-clear-1-r14` | `01M7R3W497PSNJWFDG7K54ADYB` | Oracle match, example rejected | 16,432 | $0.015807 |

Four of six drafts matched native, coverage, quote, and hidden checks. Three also had usable examples and reached buyer review readiness. Lab, lot, and pier passed on the first reply. Clearance returned a rule failure for an unknown post. The hidden oracle requires input rejection, but the buyer brief does not state that distinction. The frozen trial counts it as a mismatch.

Both repair requests included the prior plan. Badge-zone's first reply used an invalid record scope. Its repair returned an unexpected field in a collection operation and failed native validation. Category's repair resolved a native type error and matched the oracle. Its unknown-category example was rejected rather than scored verdict 0, which blocked buyer review. Neither task triggered the example-only revision lock in this cohort. Route regressions cover that path.

The six tasks generated eight distinct provider traces and settled $0.062446. Cumulative attributable API usage is $0.946333. Median latency was 8,702.5 ms. There were no Bot reviews, approvals, compiles, proofs, or Arc sends in this diagnostic.

Original tasks and provider replies remain in protected operator storage. The observed readiness remains below the release gate. Future briefs should specify input rejection where the oracle distinguishes it from verdict 0. Preserve the original scores when a brief changes.
