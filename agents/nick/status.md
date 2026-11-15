# nick status

Follow the [shared status rules](../AGENTS.md#status-and-handoffs). Add a heading with date, time, and UTC offset for each new entry. Keep the newest entry first.

## 2026-11-14 23:06 -05:00 — Nick

### Summary
- **Branch:** `nick-settlement`, cut from `nick`. It covers tracks R1 to R5, T1 to T5 and Review from [SETTLEMENT-IMPLEMENTATION.md](../current%20plan/SETTLEMENT-IMPLEMENTATION.md). Sonnet 5.5 subagents ran each track. T3 (the hook) was written by the lead agent, and T4's tests were written from the spec without reading it.
- **Pull request:** see the PR into `main` from `nick-settlement`.
- **Changed:** `contracts/` is a Foundry project containing:
  - the vendored Circle core (pristine and patched copies);
  - the vendored RISC Zero v3.1.0 verifier and a mock verifier;
  - `SettlementHook` and `SettlementCodec`;
  - tests S1 to S16 plus edge cases;
  - deploy steps 01 to 06 with a manifest template, ABIs and viem examples;
  - research notes R1 to R5, GAS and REVIEW.

### Checks
- `arc-forge test --network arc` from `contracts/` in WSL: **119 passed, 0 failed** (11 suites).
- `npm test` in `contracts/examples`: **12 passed, 0 failed**, including the engine fixture digest `9ae8cca7…115e`.
- Core provenance (S1): the unpatched copy matches Circle's implementation `0xA316…351a`, ignoring metadata and immutables.
- Arc dry run: the full deploy sequence simulates against live Arc state. Nothing was broadcast, and no key was used.

### Not done
- No live Arc deployment yet. The Nov 14 gate ("Nick deploys the pinned verifier on Arc") and the Nov 16 receipts are pending my run of `contracts/script/README.md`.
- Real engine receipts through the hook are pending Anish.
- Arc gas for a real `verify` is UNVERIFIED. It measured 242,548 locally.

### Next action
1. Deploy with `contracts/script/README.md`, steps 01 to 05, with `06_Verify` after each.
2. Fill `contracts/deployments/arc-testnet.json`.
3. Run the four acceptance transactions: an accepted proof, a payout with key release, an expiry refund, and a rejected submission.
4. Send Neil the ABIs, the manifest and `contracts/examples/README.md`. Send Anish the 16 KiB cap and a funded context.

### Decisions made outside the written spec
Each entry gives the choice, the alternative it beat, and the reason.

1. **Job-ID flag in transient storage.** The flag uses `uint256 transient _releasingJobId`, not a storage `bool` per job.
   - **Reason:** it clears automatically at the end of the transaction, costs about 100 gas instead of about 20k, and cannot be left set by a revert. Arc runs cancun, and the core already uses `ReentrancyGuardTransient`.
2. **Envelope cap and expiry margin set at construction.** `MAX_ENVELOPE_BYTES` and `MIN_EXPIRY_MARGIN` are constructor immutables, not compile-time constants.
   - **Reason:** Section 6 calls them config, and the cap may shrink after gas measurement. Immutables let config change without editing source. Both are still fixed once deployed.
3. **Expiry margin of 600 s.** The margin defaults to 600 s, up from the 120 s first chosen. The longer 30 to 60 minutes the reviewer suggested was rejected.
   - **Reason:** the margin is the only on-chain floor on proving time (Review finding 6). An hour would make the expiry-refund demo wait an hour. Clients still check `terms.expiry` against their real proving time.
4. **Exact 96-byte `fund` optParams.** `fund` optParams must be exactly 96 bytes (`BadFundParams`). The alternative was to accept anything `abi.decode` tolerates, including trailing bytes.
   - **Reason:** one canonical encoding means a malformed client fails loudly instead of funding a job whose terms it did not intend.
5. **Payment-token check in the constructor.** The constructor checks `core.paymentToken() == usdc` and rejects zero addresses. The alternative was to store `usdc` unchecked.
   - **Reason:** it catches a mis-wired deployment before the freeze, which cannot be undone.
6. **Overflow guard on expiry.** `fund` reverts with `ExpiryOverflow` if `expiredAt > type(uint64).max`. The alternative was a silent truncating cast.
   - **Reason:** a truncated expiry would move the time boundary.
7. **Extra event and read helpers.** Added the `TermsFrozen` event and the `contextOf(jobId)` and `expectedJournal(jobId, envelopeHash, keyCommitment)` views. The alternative was making clients rebuild the context from `terms`.
   - **Reason:** the commerce client and the engine read the exact on-chain bytes and cannot drift from them.
8. **Local interfaces for the core and verifier.** The hook talks to the core through `ISettlementCore` and to the verifier through `IProofVerifier`. The alternative was importing the full `AgenticCommerce` and upstream `IRiscZeroVerifier`.
   - **Reason:** the hook does not compile against the core's OZ tree or the verifier's dependency on OZ `SafeCast`, and the tests check ABI compatibility against the real contracts.
9. **Codec as a separate library.** The Section 7 byte formats live in `src/SettlementCodec.sol`, not inline in the hook.
   - **Reason:** one definition shared by the hook and the smoke test. T4 still uses its own encoder, so the two cross-check.
10. **Patched core beside the original.** It is `src/core/src/AgenticCommercePatched.sol`, next to the pristine file, not in a `patched/` folder.
    - **Reason:** relative imports stay identical, so the patch is one line. Its SHA-256 is `98887ae1…f618`.
11. **Proxy taken from Circle's verified source.** The `ERC1967Proxy` is vendored from the verified source of Circle's own proxy, not hand-written.
    - **Reason:** it is the real contract the deployment uses, and it shares the core's OZ 5.6.x tree.
12. **Mock verifier accepts a set of triples.** It accepts any registered triple, not exactly one preconfigured triple as Section 5 says. The upstream `RiscZeroMockVerifier` was also rejected: it accepts any `selector || claimDigest` and cannot reject a chosen proof.
    - **Reason:** tests need several valid triples per run.
13. **Vendored forge-std as a test dependency.** forge-std v1.9.7 (`77041d2c`, `src/` only) sits under `contracts/lib/forge-std`. The alternatives were hand-written cheatcode interfaces or a git submodule.
    - **Reason:** the test and script tracks need `Test`, `Script` and `console`. Vendoring matches how the rest is pinned.
14. **Scripts refuse to deploy a mock verifier off-chain.** Deploy steps 01, 04 and 06 revert on any non-local chain unless the verifier reports selector `0xe71e6620` and version `3.1.0`.
    - **Reason:** a hook frozen with the permissionless mock would be permanently exploitable (Review finding 4). The spec only says to use the mock until a real receipt arrives.
15. **Deploy logic in one base script.** Step logic and post-condition checks live in `00_Config.s.sol`, with thin wrappers for 01 to 05. A self-contained file per step was rejected.
    - **Reason:** `DeployLocal` and `Deploy.t.sol` reuse the same code, so what is tested is what Nick runs.
16. **Release simulation off by default.** The examples' `simulateRelease` is opt-in, not on by default.
    - **Reason:** simulating sends the real key to the RPC node.
17. **Examples in TypeScript.** They use Node's native type stripping with `tsc --noEmit`, not plain JavaScript and not a build step.
    - **Reason:** Neil's client is TypeScript, and no build is needed.
18. **Acceptance flag.** Acceptance runs use `arc-forge test --network arc`, not plain `arc-forge test`.
    - **Reason:** research R1 found the plain form runs Ethereum rules with no USDC at `0x3600…`. Our tests use a mock USDC, so both pass, but only `--network arc` matches the spec's acceptance requirement.
19. **Reverting-payout case uses a mock token.** S11 uses `test/mocks/BlocklistUSDC.sol`.
    - **Reason:** it is local and deterministic. R4 later confirmed that real Arc USDC reverts on transfers to a blocklisted address, so a fork test can add live evidence.
20. **Build and repo hygiene.**
    - `contracts/**` is forced to LF line endings, so vendored sources and the patch stay byte-identical on Windows.
    - The repo now has a root `.gitignore`.
    - Personal Claude settings (`.claude/settings.local.json`) stay out of git.

### Residual risks to tell the team
These are from `contracts/research/REVIEW.md`.
- **Hook-less jobs (Review finding 1).** The frozen core still accepts `hook = 0`, and such a job has no protection. Solvers must check `job.hook == hook`, `job.evaluator == hook` and `terms(jobId).funded` before working.
- **Blocklisted Poster (Review finding 3).** If USDC blocklists the Poster after funding, the refund is stuck forever.
- **Tampered seal gas.** A tampered real seal burns nearly all forwarded gas, so `submit` needs an explicit gas limit and a preflight `eth_call`.

## 2026-11-14 20:50 -05:00 — Nick

- Branch `nick`, fast-forwarded into `main`. [PR #2](https://github.com/anishnarang9/UBC-26/pull/2) carried the settlement plan. I merged `main` into `nick` first and resolved one `PLAN.md` conflict by keeping both Neil's workstream 3 entry and the settlement entries.
- Changed: corrected my own `PLAN.md` entries (stale push status, the miscounted Section 10 corrections, Poster versus buyer wording) and added answers to Neil's questions Q-N1, 2, 5, 11, 12 and 13. Other owners' files and entries are untouched.
- Checks: no conflict markers remain in `agents/`. This is a docs-only change. Not run: any contract tests or live Arc calls.
- Open for Neil: `COMMERCE-IMPLEMENTATION.md` lines 122 and 310 still say `setBudget` is provider-only. Our core makes it Poster-only. Neil also proposed the interface handoff for Nov 15 at 12:00, while our plan says only Nov 15.
- Next action: install Arc Foundry in WSL2, then start research track R and the contract tracks. Hand Neil and Anish the Section 10 corrections.

## 2026-11-14 19:45 -05:00 — Nick

- Branch `nick`. Added the [settlement implementation plan](../current%20plan/SETTLEMENT-IMPLEMENTATION.md) and a PLAN.md entry with the new decisions and corrections for Anish and Neil.
- Checks: read-only Arc RPC confirmed chain ID 5042002 and BN254 precompiles. Circle's core source came from the explorer. Not yet checked: forking support in Arc Foundry, USDC blocklist behavior, verifier control IDs. These are research tasks R1 to R4 in the plan.
- Next action: install Arc Foundry in WSL2, then start research track R and the contract tracks. Share the corrections with Anish and Neil.
