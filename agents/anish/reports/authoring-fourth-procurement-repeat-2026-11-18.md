# Fourth campaign: procurement shape repeat

**Run:** 2026-11-18, isolated API image `sha256:cce99a353ec5474aff5a3179b5d46292a27bb78666dde7f0c13b2c31aca4bc94`, source `a40b7f4c9e8a3f15ca887e4e2be6068aae75ac6f`. Exact-source commerce, engine, and contracts CI passed. The corpus digest was `8acf192a48f3c72a200a53ed628246a2fbdcbe339bcc4743253a7789d85f2cd7`. Each case used a fresh task and idempotency key. Protected journals retain full replies, traces, and settled usage. Earlier failed tasks remain separate.

| Case | Task ID | Outcome at the frozen draft and oracle gate | API charge |
| --- | --- | --- | ---: |
| `lab-supplies-receipt-1` | `01M7QVHH85AZYCRD5ZYZWE459Y` | Native, fixtures, quotes, and coverage passed. Hidden duplicate and missing item cases returned `reject` instead of oracle `fail`. | 2,958 micro-USD |
| `clinic-supplies-receipt-1` | `01M7QVHXPRPGREJH5XK8QTEMVS` | Native, both fixtures, quotes, and all hidden oracle cases passed. Coverage listed four assumptions and blocked approval. | 16,860 micro-USD |
| `firmware-note-1` | `01M7QVJKAQRN7RAVVGA3J58DC6` | Native, both fixtures, quotes, coverage, and all hidden oracle cases passed. | 6,064 micro-USD |

One of three supported cases passed the draft and oracle gate. There were zero complete successes through Bot, approval, compile, package, and proof. No Bot decision, compile, package check, proof, Arc send, or public deployment ran. The repeat cost 25,882 micro-USD ($0.025882) in settled API usage. Fourth-campaign cumulative API cost is 135,685 micro-USD ($0.135685). Mean task latency was 10,005 ms; the longest was 19,922 ms. `clinic-supplies-receipt-1` used one repair call; the other two used one call each. Every task and charge settled.

The lab mismatches prevent payout in both engine and oracle, but they differ under the frozen exact-status rule. Do not count them as an oracle pass. The clinic assumptions restate or infer constraints from the brief and references; the system still treats every assumption as a buyer-clarification blocker. The firmware draft repeats the first-batch draft-stage success but has not reached Bot or compile.

The Grok account meter remained unavailable. These tasks used exact per-task API charges only. Bot cost and complete-run cost remain unmeasured. The accepted public API stayed ready and unchanged. General authoring is not qualified.

**Next:** Keep the source and result pins. Change prompt guidance so a model places only genuinely unstated conditions in `coverage.assumptions` and uses a Boolean existence rule rather than a lookup for item membership. Test the changed prompt offline, then freeze a separate live cohort. Read the account meter before any Bot call.
