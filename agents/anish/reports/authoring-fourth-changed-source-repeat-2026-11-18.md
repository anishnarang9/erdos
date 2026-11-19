# Fourth campaign: changed-source repair diagnostic

**Run:** 2026-11-18, isolated local image `sha256:bfe66ec157a1062b54c2554806f93c16ccbef0d54c53d33cf451b376d850e7bb`, source `c5f8eabf1825c2f6f76af3c404d245f99d621f26`. Commerce, engine, and contracts CI passed at this source. The corpus digest stayed `8acf192a48f3c72a200a53ed628246a2fbdcbe339bcc4743253a7789d85f2cd7`. Four new tasks used fresh idempotency keys and one model repair call each. Protected local journals retain each original task, reply, trace, and settled charge. The first-batch records remain separate.

| Case | Task ID | Final stage and cause | Settled API cost |
| --- | --- | --- | ---: |
| `pier-drawers` | `01M7QTWMKNDT0K8VCXVG1DFE41` | `plan_invalid`; repair produced a rule missing `right` | 6,742 micro-USD |
| `badge-zone-1` | `01M7QTXDJ6SJBC35VGWEVWEAK3` | Native-valid draft and buyer fixtures passed; hidden `unknown-badge` was `fail` vs oracle `reject` | 11,604 micro-USD |
| `nights-1` | `01M7QTXZ4BRJ2EGD9K9EHA3WJ0` | `plan_invalid`; repair produced a collection expression with the wrong type | 10,053 micro-USD |
| `lab-supplies-receipt-1` | `01M7QTYF8MB1GWRHB7CBPNSDVV` | Native-valid plan invented required output `capacity`; both buyer fixtures were rejected and two valid hidden outputs were rejected | 14,818 micro-USD |

All four cases failed the frozen draft and oracle gate. There were zero complete successes, zero Bot decisions, zero compiles, zero package checks, zero proofs, and zero Arc sends. There were eight provider calls, two per task. This repeat settled 43,217 micro-USD ($0.043217); the fourth campaign cumulative API total is 109,803 micro-USD ($0.109803). Mean task latency was 16,683 ms; the longest was 22,426 ms. Every task and charge is settled. No case was retried after its final result.

The `badge-zone-1` mismatch is a failure-class difference. Both `fail` and `reject` prevent payout, but the frozen oracle requires `reject` for an unknown badge. The `lab-supplies-receipt-1` output schema error is a real false rejection. The repair feedback did not resolve it. These results do not qualify general authoring. The public API still serves its accepted release.

**Next:** Keep this cohort intact. Add a bounded check for scalar output fields that a buyer-accepted positive fixture omits, provided no rule reads the field. Test the saved replies offline. Diagnose remaining rule-shape and scope errors before another changed-source paid cohort. Do not dispatch Bot until the account meter is available.

**Offline follow-up:** A later source candidate removed the unused `capacity` declaration from the saved repaired `lab-supplies-receipt-1` plan. The native engine then validated it and matched all hidden oracle candidates. This replay did not make a new model call and did not change the failed live result. Its buyer fixture checks and full API response still need a fresh candidate task.
