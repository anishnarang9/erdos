# Tenth authoring trial, 2026-11-18

All eleven frozen cases ran once on isolated source `680e93c` after its commerce, engine, and contracts checks passed. See the [frozen inputs and pins](../../../docs/authoring-tenth-example-gate-2026-11-18.md).

| Case | Task | Result | Model latency (ms) | API charge |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-r13` | `01M7R371YB9HQ3J53W7WFYS8T3` | Review ready | 7,474 | $0.008752 |
| `pier-variance-r13` | `01M7R37BTBECSYQTAFP5YD1AC5` | Oracle mismatch, invalid examples | 22,182 | $0.018964 |
| `lot-expiry-1-r13` | `01M7R384CNPZBNKMVQZ5VT1P8Q` | Review ready | 5,447 | $0.007020 |
| `clearance-1-r13` | `01M7R38CGQ7DV64Y6378ZGXY98` | Oracle match, invalid example | 14,820 | $0.014904 |
| `badge-zone-1-r13` | `01M7R38XJ3QST72NGYQ250ZRD8` | Invalid record scope | 12,961 | $0.014809 |
| `category-clear-1-r13` | `01M7R39BMDWXP5VJT8N45TQ76E` | Invalid aggregate type | 16,267 | $0.014366 |
| `berth-fee-1-r13` | `01M7R39YFNBGV1TEV6106YJR58` | Review ready | 12,739 | $0.012692 |
| `hq-ambiguous-1-r13` | `01M7R3ACT34E8GQJ9AQE6CQB28` | Incomplete clarification | 1,013 | $0.003405 |
| `hq-ambiguous-8-r13` | `01M7R3AF315J9RNSXVBFHTPX6S` | Incomplete clarification | 1,121 | $0.003959 |
| `hq-unsupported-2-r13` | `01M7R3AK34A8MB6SSHJRDZ0J0W` | Clarification instead of missing capability | 1,183 | $0.003302 |
| `hq-unsupported-5-r13` | `01M7R3APXQBPKWWMNDDQR7MBHG` | Unsupported reply omitted required capability | 1,135 | $0.003872 |

Four of seven supported drafts passed native validation, coverage, quote, and hidden oracle checks. Three were ready for buyer review. Lot and berth-fee had usable examples on fresh tasks. Clearance had passing and failing examples, but an additional example was rejected, so the gate blocked review. Pier rejected two valid hidden outputs. Badge-zone and category-clear still failed native validation after repair.

Both ambiguous replies asked questions but missed frozen facets. The fee reply asked for a formula without asking for the currency unit. The rounding reply asked for a rule or precision without resolving both mode and step. The division reply asked for clarifications. The date reply explained why unrestricted date parsing is difficult but did not return the expected capability. Both unsupported cases missed the frozen protocol score.

All eleven reservations settled once across sixteen distinct provider traces. The cohort cost $0.106045. Cumulative attributable API usage is $0.883887. Median latency was 7,474 ms. The cohort made zero Bot calls and completed zero approvals, compiles, proofs, or Arc sends.

Retained journals and replies are in the protected operator directories. Inspect the repeated rule and example failures together before another paid trial. The observed review readiness does not meet the release gate.
