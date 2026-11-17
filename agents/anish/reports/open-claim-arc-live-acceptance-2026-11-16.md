# Arc Testnet open-claim acceptance

2026-11-16 — Anish. **Passed** at runtime source `8fe6dc54873c5c0294ae0d3660ce04796622fbb8` on chain 5042002. The [structured report](open-claim-arc-live-acceptance-2026-11-16.json) and [receipt audit](open-claim-arc-receipts-2026-11-16.json) record the evidence.

Buyer `0x638202cCB15315dBc5b22e02717B908bEAc3AeBd` approved the existing Meridian revision. Its protected operator confirmed `createJob`, `setBudget`, exact USDC `approve`, `fund`, and adapter `register`. API job `01M7JEZTWQ3DP0NWNKHVJB56SK` became core job **7**, with a **0.01-USDC** bounty and zero remaining allowance.

One prover generated a fresh real Groth16 proof from the actual funded context and solver `0xfb7692d0BFb955E7EB727bf744b39F7B8441057F`. Proving plus private decryption validation took **1,095.026 seconds**. The verified adapter accepted the proof, reserved that solver, released the key, and paid exactly **10,000 atomic USDC units** through core → adapter → solver. Canonical receipts and the solver's native balance change, adjusted for both fees, establish the exact payout.

Buyer recovery used the confirmed public claim calldata and key-release event. Both SDK and engine reproduced the original `schedule.json` bytes. Both recovered directories passed the independent oracle with no errors. The file SHA-256 is `0607a7b43bf95913d5561d1872b14df0e9ba3fce160946f0bfac99d76608fbc2`.

| Evidence | Confirmed transaction |
| --- | --- |
| Job 7 funding | [03825acc…730e061](https://explorer.testnet.arc.io/tx/0x03825acc379fcfdbb640344beb64a7e78ce184449dee7399aa297e2ec730e061) |
| Job 7 registration | [38fd6c16…2810d0](https://explorer.testnet.arc.io/tx/0x38fd6c16851a89aeec9876380be40cda9ca48c7a253b360d2f42db9b042810d0) |
| Accepted proof and winning claim | [7105aab3…f91491](https://explorer.testnet.arc.io/tx/0x7105aab313556ff9227864cf7e9f7db901ee048fe6e92c6483b7f8d8bcf91491) |
| Key release and exact payout | [78b68705…3013e2](https://explorer.testnet.arc.io/tx/0x78b6870536b171a989a5ebdeb278a20a2ec730bcec91173852bb29a13c3013e2) |
| Reverted invalid claim on job 6 | [fd70667b…3290a2](https://explorer.testnet.arc.io/tx/0xfd70667b27a303f9836b7520b8dceb7fc551ce99a3fa023657fb7c3c2e3290a2) |
| Separate expired-job refund, job 6 | [4e030f22…75434d](https://explorer.testnet.arc.io/tx/0x4e030f22684c75c5e2e5360c7428ad574400a44d7cc5a08d627dd8076d75434d) |
| Failed-proof cleanup refund, job 5 | [4a4e7b51…61fdec](https://explorer.testnet.arc.io/tx/0x4a4e7b5101eca923d9ace5351271697730c31984034a99dd71ab1ad78761fdec) |
| Separate Circle Gateway batch | [a1b09da4…fdee6](https://explorer.testnet.arc.io/tx/0xa1b09da4c83077e51c4247ea9867215555c6881a7eb6ade34ac91080b3afdee6) |

The second solver identity, `0x5c8E2f73Eb2A4E8222b381e2fcb84e5769Ad8c85`, observed job 7's winner and returned `lost`. It started no proof, supplied no password descriptor, sent no claim or key, and retained a zero native balance. This checks abstention after an existing winner. The onchain invalid-claim test on job 6 supplies the separate live rejection evidence. Both expired jobs refunded exactly 10,000 atomic units. The market API excludes all three completed or expired jobs.

The [Circle paid API report](circle-gateway-paid-api-2026-11-16.json) records the official Gateway facilitator's 402 → payment → 200 response and identical cached 200 replay. This paid compile used earlier API job `01M7J7EHMGNDD4JKYRDWCN9NXZ`. The charge was **0.000001 USDC**, separate from each **0.01-USDC bounty**. Transfer `845d3e15-cfb7-405d-a08f-7ca3911c737e` completed in the confirmed batch above. Buyer Gateway balance changed from 0.010000 to 0.009999 USDC. Seller balance became 0.000001, with no pending batch amount. This used the real Circle facilitator.

| Actual gas cost | USDC |
| --- | ---: |
| Successful job 7: five buyer calls, claim and release | 0.032880600 |
| One-time adapter deployment by the separate deployer | 0.063471175 |
| Entire 24-transaction test, including setup, failed attempt, invalid claim and both refunds | **0.145837525** |
| Approved aggregate gas ceiling | 0.250000000 |

Gas cost depends on gas consumed and the fee per gas. It is separate from the bounty amount. The total excludes Circle's facilitator-paid batch gas and the external wallet funding transactions. The deposit, wallet transfer, bounties and refunds are principal transfers, not gas costs.

The first funded proof, job 5, failed during Docker Groth16 compression with OOM and exit 137. Its [failure record](open-claim-arc-proof-oom-2026-11-16.json) remains intact. It sent no claim or release. The repaired run used the documented Go memory settings, the pinned compression image, a 12-GiB Docker allocation, and one prover. Its compression container exited 0 without OOM. The replacement job used a fresh 4,500-second lifetime. Retry journals retained all prior nonces and maximum gas reservations. Live receipt-wait resumes used saved hashes. Unit tests cover dropped acknowledgments and ambiguous sends.

At runtime source `8fe6dc5`, workspace checks passed: SDK 13 Node checks plus 342 tests, API 778 tests, worker 901 tests, and all typechecks. [Commerce CI](https://github.com/anishnarang9/UBC-26/actions/runs/43896280974) and [engine/contract CI](https://github.com/anishnarang9/UBC-26/actions/runs/43896280860) passed. After publication, require all CI groups on [PR #7](https://github.com/anishnarang9/UBC-26/pull/7) at the exact final evidence commit. The [operator runbook](../../../docs/overnight/open-claim-live-operator.md) describes repeat execution and recovery.

This acceptance covers the complete prepared Meridian CLI/API workflow. Fresh English-rule drafting with Grok and a buyer browser UI remain separate work. Encrypted wallets, passwords, payment signatures, release keys and raw signed transactions remain outside Git. No prover remains active. No Grok CLI worker ran.
