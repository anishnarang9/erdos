# Fourth authoring campaign: first frozen batch

**Run:** 2026-11-18, local isolated API image `sha256:dab3e4b47e3ea6f8d5127aa298efa09d669779f4ac491d21eb2c93b1a30e4e0e`, source `84238b6383aabd32fcfacef358a18906b5bc6e51`. The corpus digest was `8acf192a48f3c72a200a53ed628246a2fbdcbe339bcc4743253a7789d85f2cd7`. The native engine binary SHA-256 was `979b6038734ad2cc287996da401eb960c57dd96605181bf2ee0dd742c97a4a47`. One API task ran for each frozen case. Private journals retain the task IDs, idempotency keys, full replies, trace IDs, and settled charge rows. The original replies remain unchanged.

| Measure | Result |
| --- | ---: |
| Complete successes through Bot, compile, package, and proof | 0 / 8 supported |
| Supported drafts with native validity and hidden-oracle agreement | 1 / 8 (`firmware-note-1`) |
| Supported drafts rejected as `plan_invalid` | 6 / 8 |
| Supported drafts with hidden-oracle disagreement | 1 / 8 (`lab-supplies-receipt-1`) |
| Correct clarifications | 0 / 1 |
| Correct unsupported decisions under frozen exact-capability rule | 0 / 1 |
| Bot reviews, compiles, package checks, proofs, Arc sends | 0 each |
| Settled API charges | 66,586 micro-USD ($0.066586) |
| Mean task latency; longest task | 5,633 ms; 11,284 ms |

The six invalid plans each declared `rows` as both a scalar field and a collection on the output file. Some also repeated that conflict in a reference file. The engine rejected the first duplicate before it could report later errors. An offline replay removed only duplicate scalar fields that buyer fixtures or exact reference JSON proved were arrays. This replay did **not** replace the live outcomes: four of the six plans still failed native validation, and two became native-valid but disagreed with the independent oracle. The later errors include wrong record scope, wrong operand types, and an invalid rule shape.

`lab-supplies-receipt-1` passed native plan validation but rejected two valid hidden outputs. Its buyer-visible examples were rejected by the declared JSON schema because the plan invented a top-level `capacity` field in the output. `hq-ambiguous-7` asked for a toll threshold and output schema but omitted the missing toll table and currency unit. `hq-unsupported-1` correctly avoided a payable draft for regex matching, but its free-text reason did not name the required `regex_match` capability. The frozen scorer therefore marked both cases failed.

This batch used API calls only. The Grok Dashboard account meter was unavailable while another Chrome window was active. The API recorded exact settled provider charges per task and enforced a $10 local daily ceiling. The $0.066586 is attributable API spend, not an account-wide total or a Bot charge. No Bot call ran. The public API kept its accepted image and remained ready. This result does not qualify general authoring.

**Next:** Keep this failed batch. Test the narrow duplicate-field normalization and a one-repair candidate offline. Freeze a changed-source repeat before another paid task. Bot, compile, and proof checks can follow only a supported draft that passes the fixture and independent oracle gates.
