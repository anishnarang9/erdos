# nick status

Follow the [shared status rules](../AGENTS.md#status-and-handoffs). Add a heading with date, time, and UTC offset for each new entry. Keep the newest entry first.

## 2026-11-15 00:04 -05:00 — Nick

Branch `nick-settlement`, PR #4.

### Deployment progress

| Step | State | Details |
| --- | --- | --- |
| 01 Verifier | Live | `0xCf8D70A203b40D3A17d023c0CDDF752870BC3992`, block 72392474 |
| 02 Core implementation | Live | `0x55A3C9319EEe607579855880b5651766eBF103d7`, tx [`0xc734ab50…95bf`](https://explorer.testnet.arc.io/tx/0xc734ab50615f884c364a7af4627a08b989891b88b83944865b18fa314e5695bf), block 72392852. Used 4,720,997 gas and cost 0.118 USDC. `06_Verify` printed `ok core implementation` |
| 03 Core proxy | Not deployed | Two attempts sent nothing (see below). The deployer nonce is still 2. On retry, the proxy will be `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8`, the deployer's next CREATE address |
| 04 Hook | Not deployed | |
| 05 Freeze | **On hold** | See the TODO below |

### Step 03 attempts
- **First attempt.** The deployer was `--account settlement-deployer` without `--sender`. Forge built the transaction from its placeholder sender `0x1804…1f38` and refused to send it. Live commands now always pass `--sender 0x27f97754b165B68921c9dD0Ea88eDf617731A35a`.
- **Second attempt.** Wrong keystore password, so nothing was sent.
- **Manifest side effect.** Both failed attempts wrote unsent addresses into the manifest, because the scripts write it during simulation. I reset the `core` entry to null each time and recorded step 02's receipt block and transaction.

### Decision 27: hold the irreversible freeze
- **Choice:** do not renounce `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` yet. Step 05 will run in a whitelist-only mode, which calls `setHookWhitelist(hook, true)` and nothing else, so jobs can be created. `08_CreateTestJob` will take an explicit `SETTLEMENT_ALLOW_UNFROZEN=1` flag.
- **Alternative rejected:** freezing now, as the spec orders after the whitelist. The freeze cannot be undone. Holding it keeps the option to fix the core or hook configuration, or to redeploy, before anything is permanent. Whitelisting is reversible by the admin and is all that job creation needs.
- **Cost while unfrozen:** the deployer, a testnet-only key, can still upgrade the core, change fees or whitelist other hooks. Counterparties must not treat the core as trustless until the freeze runs.

### TODO: remove admin rights (Nick)
- Before the Nov 16 live settlement demo, run the full freeze: `05_Freeze` without `SETTLEMENT_WHITELIST_ONLY`, then `SETTLEMENT_EXPECT_FROZEN=1 06_Verify`.
- Until then, the manifest shows `frozen: false`, and the funded test job carries `coreFrozen: false`.

### Next action
1. Retry step 03 with `--sender`, then step 04.
2. Run the whitelist-only step 05, once the subagent's change lands.
3. Run `08_CreateTestJob` with `SETTLEMENT_ALLOW_UNFROZEN=1` once Anish supplies the image ID, rules hash and reference hash.

## 2026-11-14 23:54 -05:00 — Nick

### Arc verifier deployed: deliverable 4 is complete
- **Branch:** `nick-settlement`, PR #4.
- **Verifier:** [`0xCf8D70A203b40D3A17d023c0CDDF752870BC3992`](https://explorer.testnet.arc.io/address/0xCf8D70A203b40D3A17d023c0CDDF752870BC3992) on Arc Testnet.
- **Transaction:** [`0xd0fb5fb5…2b6f`](https://explorer.testnet.arc.io/tx/0xd0fb5fb5b4e921df0ee1b0220587f59259f7175cec841a49f3262ccbf2232b6f), block 72392474. It used 1,795,535 gas and cost 0.044888 USDC.
- **Deployer:** `0x27f97754b165B68921c9dD0Ea88eDf617731A35a`, a testnet-only wallet funded from Circle's faucet. Its key sits in an encrypted Foundry keystore named `settlement-deployer` in root's WSL home.

### Checks
- `06_Verify` printed `ok verifier`.
- `script/verifier-evidence.py` (read-only) passed **20 of 20** checks. The full output is in `contracts/research/ARC-VERIFIER-LIVE.md`.
  - The runtime code equals the local build, ignoring metadata and immutables.
  - Selector `0xe71e6620`, version `3.1.0`, and the control root and BN254 control ID all match.
  - The upstream receipt verifies (`eth_estimateGas` 267,946).
  - Altering any journal byte, the image ID, any proof byte, or any selector byte reverts.
- Evidence was captured at block 72392546.

### Fix
`01_DeployVerifier` wrote `deployBlock` as 72392473, the block it simulated against. The receipt says 72392474, so I corrected the manifest by hand and added `deployTx`. Not fixed in the script: steps 02 to 05 will record their simulation block the same way. The deploy block is only a starting point for log scans, so starting one block early does no harm.

### Tonight's deliverables
All four are now delivered. Sharing the verifier address and `contracts/HANDOFF.md` with Neil and Anish is still Nick's to do.

### Next action
Steps 02 to 05 (core implementation, proxy, hook, freeze) with `06_Verify` after each. Then `08_CreateTestJob`, once Anish supplies the image ID, rules hash and reference hash.

## 2026-11-14 23:30 -05:00 — Nick

Branch `nick-settlement`, PR #4. This is an audit against tonight's deliverables.

### Deliverables

| # | Deliverable | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Settlement contracts: escrow core, hook and evaluator, key release | **Delivered** | `contracts/src/` (patched Circle core, `SettlementHook`, `SettlementCodec`) |
| 2 | Passing local tests: valid and invalid proofs, wrong keys, replay, payout, expiry refunds | **Delivered** | `arc-forge test --network arc`: 120 passed, 0 failed, 1 skipped (the skip is the fork-only suite) |
| 3 | Interface handoff: ABIs, events and read methods, expiry rules, 16,412-byte envelope cap | **Delivered in the repo** | [`contracts/HANDOFF.md`](../../contracts/HANDOFF.md), `contracts/abi/`, `contracts/examples/`. Not yet sent to Neil and Anish directly (see Next action) |
| 4 | Arc verifier: deploy the pinned verifier, test a real receipt and altered inputs, share the address and evidence | **Partly delivered** | Fork evidence against live Arc state is in [`contracts/research/ARC-VERIFIER.md`](../../contracts/research/ARC-VERIFIER.md). **The live deployment and its address are still pending.** They need my keystore, which subagents never handle |

### Changes since the last entry
- **Envelope cap:** `MAX_ENVELOPE_BYTES` is now **16,412** (team value) in config, the manifest, tests and examples. 16,412 accepts, 16,413 reverts and the job stays Funded.
  - A full `submit` at the cap is 16,996 bytes of calldata. The Arc calldata floor is about 700,840 gas (about 0.014 USDC at 20 gwei), which is higher than execution: 142,927 with the mock verifier plus about 242.5k for a real `verify`.
- **Arc fork evidence:** `test/fork/ArcVerifierFork.t.sol` deploys the pinned verifier on a fork of Arc at block 72389800, so Arc's own precompiles execute. Results, 7 of 7 pass:
  - `SELECTOR` is `0xe71e6620` and `VERSION` is `3.1.0`.
  - The upstream receipt verifies, using 242,661 gas.
  - Changing any journal byte, the image ID, any proof byte, or any selector byte reverts.
- **New tooling:**
  - `script/verifier-evidence.py` gathers post-deploy evidence read-only and writes `research/ARC-VERIFIER-LIVE.md`.
  - `script/08_CreateTestJob.s.sol` creates and funds the next handoff's test job and writes `testJob` into the manifest. It is tested in-process.
- **Handoff document:** `contracts/HANDOFF.md`.

### Checks
- `arc-forge test --network arc`: 120 passed, 0 failed, 1 skipped.
- `arc-forge test --network arc --fork-url https://rpc.testnet.arc.io --fork-block-number 72389800 --match-path 'test/fork/*'`: 7 of 7 passed.
- `npm test` in `contracts/examples`: 13 of 13 passed.

### Next action (Nick)
1. Deploy the verifier on Arc. In WSL from `contracts/`:
   - deploy: `arc-forge script script/01_DeployVerifier.s.sol:DeployVerifier --network arc --rpc-url https://rpc.testnet.arc.io --account <keystore> --with-gas-price 25gwei --priority-gas-price 25gwei --slow --broadcast`;
   - check: `arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io`;
   - capture evidence: `python3 script/verifier-evidence.py --out research/ARC-VERIFIER-LIVE.md`.

   Commit the manifest and the evidence.
2. Send `contracts/HANDOFF.md` and the verifier address to Neil and Anish.
3. Then run steps 02 to 05 and `08_CreateTestJob` for the next handoff. That needs the image ID, rules hash and reference hash from Anish.

### Decisions made outside the spec in this checkpoint
Each entry gives the choice, the alternative it beat, and the reason.

21. **Cap set to 16,412.** The team fixed it at 16,412, replacing the spec default of 16,384. It plausibly equals a 16,384-byte bundle plus a 12-byte nonce and a 16-byte tag, but that derivation is UNVERIFIED. The hook takes the cap as a constructor argument, so no contract code changed.
22. **Fork test instead of waiting for a deploy.** The verifier evidence comes from a fork test now, not only after the live deploy. It exercises Arc's real BN254 and SHA-256 precompiles without a key. The fork test skips off chain 5042002, so the local suite stays green.
23. **Evidence script in Python.** It is a read-only Python script, not a Forge script. It uses the node's real `eth_call` and `eth_estimateGas`, which a Forge script would simulate locally instead.
24. **Evidence in its own file.** The script writes `ARC-VERIFIER-LIVE.md` rather than editing `ARC-VERIFIER.md`, so the hand-written fork section is never overwritten.
25. **Two overridable config functions.** `_isLocal` and `_manifestPath` in `00_Config.s.sol` are now `virtual`. Otherwise two script tests race on shared environment variables, because Forge runs suites in parallel.
26. **Duplicate-job guard.** `08_CreateTestJob` refuses to create a second test job unless `SETTLEMENT_ALLOW_NEW_TEST_JOB=1` is set. This stops a re-run from double-funding.

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
