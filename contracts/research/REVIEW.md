# Settlement review (Review track, 2026-11-14)

Read-only review of `src/SettlementHook.sol`, `src/SettlementCodec.sol`, the patched core and the deploy scripts against SETTLEMENT-IMPLEMENTATION.md Sections 4, 6 and 7. It covers hook ordering, replay protection, the freeze step, funds safety and spec conformance.

**Result:** no Critical or High findings. The reviewer wrote 5 proof-of-concept tests in a scratch copy, and all 5 passed.

## Findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | Medium (integration) | The frozen core still whitelists `hook = 0`. A job created without our hook gets none of its protections. For example, a Poster who is their own evaluator can `reject` after the Solver submits. | Cannot be fixed on-chain without unfreezing. **Clients must require `job.hook == hook`, `job.evaluator == hook` and `terms(jobId).funded` before doing work.** Added to the commerce handoff. Documented by `test/hook/HookEdgeCases.t.sol::test_hooklessJobGivesSolverNoProtection`. |
| 2 | Low | A job with `hook = 0` and `evaluator = SettlementHook` can never be released. It can only be refunded after expiry. | Safe, and it only affects the Poster who created it. Covered by `test_hooklessJobWithHookEvaluatorIsRefundableOnly`. |
| 3 | Low | If USDC blocklists the Poster after `fund`, `claimRefund` reverts forever and the budget is stuck. | Residual risk. The spec forbids a sweep. USDC governance (blocklist, pause, upgrade) is a trust assumption. |
| 4 | Info (High if misused) | `MockRiscZeroVerifier.expect` is permissionless. A hook frozen with the mock would be permanently exploitable. | The deploy scripts deploy the mock only in local mode. Commit `62a5801` makes steps 01, 04 and 06 require the real verifier (selector `0xe71e6620`, version 3.1.0) on non-local chains. |
| 5 | Info | Token reentrancy during payout is blocked by the core's transient lock. | No action. |
| 6 | Low | The Poster controls how much proving time the Solver gets. `MIN_EXPIRY_MARGIN` is the only on-chain floor. | Raised from 120 s to 600 s in `config/arc-testnet.json`. Clients must check `terms.expiry` against their proving time before starting. |
| 7 | Info | `test/script/Deploy.t.sol` failed in the bytecode check of `00_Config.s.sol`. | Sent to the deploy track to fix. |
| 8 | Info | The compiler suggests `beforeAction` could be `view`. | Kept non-view to match `IACPHook`. |

## Conformance

Every row of the Section 6 callback table matches, and so does every hard rule. The additions are all safe:
- the `TermsFrozen` event;
- the exact 96-byte `fund` optParams check;
- `ExpiryOverflow` and `NotFundedStatus`;
- the constructor check that `paymentToken` equals the configured USDC;
- the `contextOf` and `expectedJournal` views;
- constructor immutables in place of constants.

## Test gaps

Added in `test/hook/HookEdgeCases.t.sol`:
- `fund` optParams of 95 and 97 bytes;
- a `uint64` expiry overflow;
- jobs the hook never saw;
- the real Groth16 verifier wired into the hook, rejecting both a foreign genuine receipt and a tampered seal.

Still open: real engine receipts (verdict 1 and verdict 0) through the hook, and a Solver contract that calls `submit` and `release` in one transaction.
