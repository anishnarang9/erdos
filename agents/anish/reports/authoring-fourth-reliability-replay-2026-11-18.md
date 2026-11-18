# Fourth campaign: six-request reliability probe audit

**Source:** `fc2e71706bd529c04063f66cb725ed27fdd60f89`, image `sha256:9434d49905211dbab6dda4310b0cbc32c50d7c264a3880b6ac268d6a6bcf849f`. Exact-source commerce, engine, and contracts CI passed. The frozen probe sent six client requests for three briefs in two rounds, with new idempotency keys for every request.

**Audit correction:** The API intentionally deduplicates identical draft input for one wallet across different idempotency keys. The three second-round requests returned the first round's task IDs and trace IDs. The local harness incorrectly reported them as three more paid successes and counted their charges twice. Protected original journals remain unchanged; this report is the corrected interpretation. The service database contains exactly three tasks and three settled reservations totaling 24,053 micro-USD ($0.024053), with no charge for the second-round replay requests. Fourth-campaign cumulative API cost is 159,738 micro-USD ($0.159738), not the harness's $0.183791.

| Brief | First task ID | First-round draft and oracle gate | Second request |
| --- | --- | --- | --- |
| Lab receipt | `01M7QVZZMK2P9DFXHNGPR30EKD` | Passed native, fixtures, coverage, quotes, and 9 hidden cases | Replayed same task and trace |
| Clinic receipt | `01M7QW09GKBMMPQ8264YPJYZBJ` | Passed native, fixtures, coverage, quotes, and 9 hidden cases | Replayed same task and trace |
| Firmware note | `01M7QW0MSAFMV302WHZRKK0F63` | Passed native, fixtures, coverage, quotes, and 6 hidden cases | Replayed same task and trace |

The first round gives three distinct draft-stage successes from one wallet. The second round gives **zero independent trials**. There are zero complete Bot-to-proof successes, zero Bot decisions, zero compiles, zero package checks, zero proofs, and zero Arc sends. Do not use the six client responses as a six-run reliability claim. This audit confirms duplicate paid calls were prevented at the service boundary and exposes a flaw in the private trial harness.

**Next:** Use a separate authenticated wallet for each repeat of the same input. Reject a returned task ID or trace ID already counted in the cohort. Freeze a new three-task cohort on the same source. Count only the new database reservations in the campaign cost. Keep the public API on its accepted release.
