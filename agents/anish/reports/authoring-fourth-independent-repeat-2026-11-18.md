# Fourth campaign: independent same-source repeat

**Source:** `fc2e71706bd529c04063f66cb725ed27fdd60f89`, image `sha256:9434d49905211dbab6dda4310b0cbc32c50d7c264a3880b6ac268d6a6bcf849f`, corpus digest `8acf192a48f3c72a200a53ed628246a2fbdcbe339bcc4743253a7789d85f2cd7`. Exact-source commerce, engine, and contracts CI passed. Three first-wallet tasks and three new-wallet tasks used the same frozen briefs with distinct task IDs, provider traces, and idempotency keys. The service database shows six tasks, six settled reservations, two owner wallets, and 45,614 micro-USD in total charges for these six tasks. Earlier same-wallet replay requests created no task or charge.

| Brief | First-wallet task | New-wallet task | Both drafts |
| --- | --- | --- | --- |
| Lab receipt | `01M7QVZZMK2P9DFXHNGPR30EKD` | `01M7QW5H49VGWYHFPXKSWP2EPQ` | Native, fixtures, coverage, quotes, and all 9 hidden cases passed |
| Clinic receipt | `01M7QW09GKBMMPQ8264YPJYZBJ` | `01M7QW5TYXYYY9SQX0R8NCDM59` | Native, fixtures, coverage, quotes, and all 9 hidden cases passed |
| Firmware note | `01M7QW0MSAFMV302WHZRKK0F63` | `01M7QW68G09N1Q2CTMMZN6MMPX` | Native, fixtures, coverage, quotes, and all 6 hidden cases passed |

The new-wallet tasks settled 21,561 micro-USD ($0.021561): lab 4,373, clinic 9,147, firmware 8,041. The fourth campaign cumulative unique API spend is 181,299 micro-USD ($0.181299). Across the six independent tasks, mean API cost was about $0.007602 and mean task latency was about 8.0 seconds. One of the new-wallet tasks used one model repair call; the other two used one provider call each. Every new task and charge settled.

**Readiness interpretation:** Six of six independent tasks passed the draft and hidden-oracle gate for these three briefs. This is two samples per brief from two wallets on one source. The ten-case first batch and later failed cohorts remain failures; this evidence does not erase them. There are zero complete Bot-to-proof successes in this campaign. No Bot decision, approval, compile, package check, proof, Arc send, or public deployment ran. The account meter and Bot attribution remain unavailable. The accepted public API returned `/readyz` 200 and stayed on its prior release. General public authoring is still gated.

**Next:** Verify the exact generated lab plan through the local compiler, package checker, and prover. Run a wider frozen set across the 62-case corpus, including ambiguity and unsupported tasks. Resolve Bot cost attribution and production account separation before a release decision.
