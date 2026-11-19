# Reference key guard trial

The six frozen drafts ran once against source `eda9e5b` after commerce, engine, and contracts CI passed. See the [trial definition](../../../docs/authoring-key-guard-trial-2026-11-18.md).

| Case | Task | Outcome | Latency (ms) | API cost |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-membership-r19` | `01M7R76YBR6AHHF694XZPTS73S` | False accept: over capacity | 14,491 | $0.017756 |
| `pier-variance-membership-r19` | `01M7R77FD58JNV4H2K1VVYZDTR` | Review ready | 9,552 | $0.008521 |
| `clearance-1-membership-r19` | `01M7R77TJP48MDNCQJCBYMJ9JT` | Review ready | 8,692 | $0.008616 |
| `badge-zone-1-membership-r19` | `01M7R784ANBNPKB61BB7GFN8FP` | Review ready with key guard normalization | 5,093 | $0.007651 |
| `category-clear-1-membership-r19` | `01M7R78AZAFB4FDMN5EAVHT456` | Review ready | 18,420 | $0.017079 |
| `nights-1-membership-r19` | `01M7R78Z6HYS4TDR4NEWCMXRGM` | Unknown program returned verdict 0 | 8,955 | $0.008863 |

All six final plans were native-valid. Four passed hidden oracle, coverage, quote, and example checks. Badge passed on its first reply. The API recorded the new reference key guard normalization at `/rules/0/where/left/left`. All seven badge candidates matched the independent oracle. Lab still accepted an over-capacity receipt. Nights checked the permitted night values, but returned verdict 0 instead of rejecting an unknown program. Keep both failures in the score.

All six reservations settled. Eight provider calls cost $0.068486, for $1.330633 in attributable campaign API usage. Median task latency was 9,253.5 ms. No Bot, approval, compile, proof, or Arc send ran in this cohort. Four draft successes in six tasks remain below the general authoring release gate.
