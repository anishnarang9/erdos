# Reference membership contract trial, 2026-11-18

Six clarified briefs ran once on the same isolated API source, `82505b5`, using a new wallet. The brief IDs changed. The oracle, hidden candidates, supplied reference files, and earlier scores did not change. See the [frozen trial](../../../docs/authoring-membership-contract-trial-2026-11-18.md).

| Case | Task ID | Result | Latency (ms) | API charge |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-membership-r15` | `01M7R443KVMVWZY944CTP7J6RW` | Oracle match, example rejected | 20,168 | $0.019254 |
| `pier-variance-membership-r15` | `01M7R44S7HSZJMWZ07DR521XH9` | Oracle mismatch | 22,867 | $0.018525 |
| `clearance-1-membership-r15` | `01M7R45HNS7SEQQ34BC0MNV9KN` | Oracle match, example rejected | 10,443 | $0.012265 |
| `badge-zone-1-membership-r15` | `01M7R45Y732RAK9A20VZTMVZ2T` | Invalid record scope | 17,640 | $0.017368 |
| `category-clear-1-membership-r15` | `01M7R46JTMA9VR6XCTY15M1M3E` | Oracle match, example rejected | 18,685 | $0.014809 |
| `nights-1-membership-r15` | `01M7R476RSND5V5A6HWKQ387W1` | Oracle mismatch and invalid example names | 13,513 | $0.014707 |

Three of six drafts matched the hidden oracle and the other draft checks. Zero reached buyer review readiness. Lab, clearance, and category each included an unknown-key example that the engine rejected. Clearance matched the previously missed unknown-post outcome. Pier rejected two valid answers. Nights allowed duplicate programs and schedules that omitted either night. Badge-zone still failed native validation on a record field scope. Its repair did not resolve the error.

All six reservations settled. The cases used twelve unique provider traces and cost $0.096928. Cumulative attributable campaign API usage is $1.043261. Median latency was 18,162.5 ms. There were zero Bot reviews, approvals, compiles, proofs, or Arc sends. This is evidence about changed inputs, with one sample for each brief. It does not establish repeat reliability.
