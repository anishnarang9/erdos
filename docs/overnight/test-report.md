# Open-claim adapter adversarial tests

2026-11-16 — Native Codex fallback worker — runtime checks complete.

All **168 local Foundry tests passed** across 14 suites. No test failed or skipped.
The command excluded `test/fork/*`. It made no live RPC call or live transaction.
The independent adapter file contains **42 tests**, including three fuzz tests with 256 runs each.

The cancelled Grok worker produced no test files. This worker wrote the tests with native Codex inference.
The native model was `gpt-6.1-sol`. The worker inherited its parent model without an override.
This worker made no Grok or direct model API call. It built no guest and generated no proof.
It sent no live transaction and made no commit or push.

## Scope and test method

- Changed `contracts/test/openclaim/OpenClaimAdapter.t.sol` and this report only.
- Used the approved API in `open-claim-v1.md`, published at `43b4fca`.
- Deployed the actual patched `AgenticCommerce` implementation behind its actual `ERC1967Proxy`.
- Froze both admin roles in default fixtures. Kept roles only in explicit fee and hook mutation fixtures.
- Used a local adversarial ERC-20 and the existing digest-selective mock verifier.
- Encoded context, key commitment, and journal independently. The tests do not import `SettlementCodec`.
- Kept the parent-owned real-verifier test file unchanged. The local regression run included its six checks.

## Rescued source and harness audit

The initial interface checkpoint did not contain the adapter source. The two initial test commands failed during compilation.
The parent later imported the rescued implementation and tests at `8b9589dff506a3741a7580414a8ad2a0631f8baf`.

Comparison with `stash@{0}^3` confirmed that the rescue preserved the original assertions.
Its harness changes placed each funding event expectation directly before its core action.
It also computed the envelope hash before `vm.prank`, which prevents the SHA-256 precompile from consuming the prank.
The rescue added a constructor test for a verifier address without code.

This worker then added two initial-fee constructor regressions and one outgoing-payment regression.
No assertion was removed or weakened. No further harness repair was necessary during this resumed run.

Checked source hashes after the successful local run:

| File | SHA-256 |
| --- | --- |
| `contracts/src/OpenClaimAdapter.sol` | `ebf15d533353db02227ddbd0ef940cdfa318c7f8d2488197eed45d7bee2e611b` |
| `contracts/test/openclaim/OpenClaimAdapter.t.sol` | `64eab2eab6279dde2ac4f7647431dfca4dba32858070de1154c75b837e7296ad` |

## Coverage

The file contains 42 test functions. Three functions use Foundry fuzzing.

- Funding, exact consumed approval, registration commitments, events, roles, state, and balances.
- Wrong buyer, duplicate registration, wrong budget, expiry, roles, hook, token, fees, zero budget, missing job, and unfunded job.
- Exact registration margin at 600 seconds. Rejection at 599 seconds and expiry.
- Failed initial funding leaves the real core Open and prevents registration.
- Manual 169-byte context, 234-byte journal, and published synthetic vector.
- Invalid first proof leaves the job Funded and unreserved. Two valid solver identities cannot replace the first accepted solver.
- Independent mutations of chain, adapter domain, job, solver, rules, references, image, envelope hash, key commitment, verdict, and selected-provider core domain.
- Unregistered hookless jobs, envelope limit, changed fees, wrong solver, wrong key, duplicate claim, and duplicate release.
- Exact solver payment and core payment events. Adapter donations and other job balances remain intact.
- Blocked solver and blocked adapter transfers roll back core completion and release state.
- Short and excess core transfers cannot use donations to pass the exact balance-delta check.
- Short and excess solver transfers revert with `WrongPaymentAmount`. Both job balances and adapter donations remain exact.
- Constructors reject a missing verifier contract and either initial fee type, including a fee of one basis point.
- A solver callback attempts same-job and cross-job reentrancy during its payout.
- Claim and release at expiry minus one. Rejection at expiry and later.
- Permissionless direct core refunds from Funded and Submitted. Unregistered jobs also retain their refund path.
- Failed buyer refunds preserve core state and funds. Adapter records remain historical after refunds.
- Direct core submit, complete, and reject calls cannot bypass the adapter.
- Fuzzed amounts, solver identities, keys, registration margins, delayed expiry boundaries, and both refund source states.

## Commands and results

Commands ran from `contracts/` in the assigned worktree. The pinned executable was
`/Users/anishnarang/.local/share/ubc26/sprints/2026-11-15-core/tools/arc-foundry/forge`.
`forge --version` exited **0** and reported version `1.7.1-dev`, commit
`3e95efaeaaaca64d6ac9c1ee988968683dbd0d22`, release profile.

1. `forge test --network arc --match-path test/openclaim/OpenClaimAdapter.t.sol -vv`
   ran twice. Each attempt exited **1** before test execution.
   Both open-claim files import the adapter source, which did not yet exist.
   No test pass is claimed from either attempt.
2. `forge fmt test/openclaim/OpenClaimAdapter.t.sol` formatted the scoped test file successfully.
   A following source-existence check in the same shell command exited 1 because the adapter was still absent.
3. `forge fmt --check test/openclaim/OpenClaimAdapter.t.sol` exited **0**.
4. After rescue, `forge test --network arc --match-path test/openclaim/OpenClaimAdapter.t.sol --match-test test_constructorRejectsInitial -vv`
   exited **1**. Compilation passed. Both new tests failed because the constructor did not reject the initial fee.
5. `forge test --network arc --match-path test/openclaim/OpenClaimAdapter.t.sol -vv`
   exited **1** with **39 passed, 2 failed, 0 skipped**. Only the two new constructor regressions failed.
6. `forge test --network arc --match-path test/openclaim/OpenClaimAdapter.t.sol --match-test test_shortOrExcessSolverPayment -vv`
   exited **0** with **1 passed, 0 failed, 0 skipped**.
7. The implementer added `_checkTokenAndFees()` to the constructor.
   The exact focused command from step 4 then exited **0**, with **2 passed, 0 failed, 0 skipped**.
8. `forge test --network arc --no-match-path 'test/fork/*' -vv`
   exited **0** with **168 passed, 0 failed, 0 skipped** across **14 suites**.
   The independent adapter suite passed all **42 tests**. Each of its three fuzz tests ran **256 cases**.
9. Final scoped `forge fmt --check` and `git diff --check` commands exited **0** for the tracked test file.
   A Python check of this report's final newline, LF endings, and trailing whitespace exited **0**.
   `git diff --no-index --check /dev/null docs/overnight/test-report.md` exited **1** without whitespace diagnostics.
   The report is untracked and differs from `/dev/null`.

## Runtime and source findings

The constructor initially checked addresses, code, and token identity but omitted the zero-fee check.
The two regressions reproduced this defect before the implementer changed the source.
Both regressions pass after the fix. Registration, claim, and release also check the fee policy.

The audited claim path verifies the approved image and independent journal digest before it stores the winning solver.
Its core snapshot checks cover buyer, provider, evaluator, hook, status, budget, expiry, token, and both fees.
The release path checks both the adapter balance delta and the solver balance delta.
The callback test rejected both repeated payment and release of a second job during payment.

No state-machine failure remains in this test matrix. This is a bounded code and runtime check.
The six parent-owned real-receipt tests passed with the real verifier, actual core, and adapter at a synthetic domain.
They use checked-in receipts and `vm.etch`. They do not show a fresh proof or real-receipt payout lifecycle.

The parent owns final integration review, fork checks, and all shipping. This worker made no commit or push.
The normative API does not prescribe the core completion reason. The test checks its event identity and ABI shape.
The test checks full data for the adapter events and the core payment event.

These tests exercise local state-machine behavior with test doubles. They do not establish real proof soundness,
fresh proof acceptance, live deployment provenance, a live exchange, or production security.
