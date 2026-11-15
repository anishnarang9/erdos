# Arc settlement implementation plan

**2026-11-14 · Nick workstream · Proposed implementation details**

Build the Arc Testnet escrow, proof verification, and key release that settle a job. The Poster locks a USDC bounty. The Solver submits an encrypted solution with a RISC Zero Groth16 proof. The contract verifies the proof before the escrow records the submission. The Solver then releases the key in the transaction that pays the bounty. See the [three-way handoff](WORK-SPLIT.md) for ownership and the [engine plan](ZKVM-IMPLEMENTATION.md) for the proof wire format.

## 0. Terms and status markers

- **Poster** posts the problem and locks the USDC bounty. Earlier documents call this role the buyer.
- **Solver** submits the encrypted solution and proof, then collects the bounty. Earlier documents call this role the worker or provider. In ERC-8183 the Solver is the `provider`.
- **Bounty** is the ERC-8183 `budget`.
- **Core** is the ERC-8183 `AgenticCommerce` escrow. **Hook** and **evaluator** are one contract, `SettlementHook`.
- **VERIFIED** marks facts checked against a source on 2026-11-14. **UNVERIFIED** marks facts that a research task (Section 9) must resolve before code depends on them. Never build on an UNVERIFIED item.

## 1. Decision log

| Topic | Decision | Reason |
| --- | --- | --- |
| Scope | Workstream 2 only. Thin TypeScript examples are handoff material for the commerce owner | Matches [WORK-SPLIT.md](WORK-SPLIT.md) |
| Core | Deploy our own copy of Circle's verified `AgenticCommerce` source behind our own ERC1967 proxy | Circle's deployment is upgradeable by a Circle admin. Only an admin can whitelist a hook, so we could not install ours there. We write no new escrow |
| Patch | Exactly one change: `setBudget` requires `msg.sender == job.client` | The Poster sets the price. The Solver only submits and collects |
| Hook data layout | Follow the deployed code: every hook payload starts with `address caller` | We deploy that code. The written standard differs |
| Admin | Whitelist our hook, keep fees at zero, then renounce `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE` | No later upgrades or fee changes |
| Release | Only the funded Solver may call `release` | Matches WORK-SPLIT.md |
| Chains | Arc Testnet (chain ID 5042002) only. Keep chain, addresses, and token in config | Ethereum deployment is out of scope |
| Demo parameters | Bounty size and expiry windows are config values with no recommended numbers | Faucet and core limits in Section 2 constrain them |
| Chain access | Fork-and-gate (Section 3) | Safe parallel work without handling keys |
| Verifier (default) | Deploy `RiscZeroGroth16Verifier` directly. No router, estop, or timelock | Smallest testnet surface |
| Mocks (default) | Use a mock `IRiscZeroVerifier` until a real engine receipt arrives | Unblocks tests |
| Layout (default) | Foundry project in `contracts/` | Section 3 |

## 2. Verified facts

**Arc Testnet** (VERIFIED from docs.arc.io and read-only RPC calls)

- Chain ID 5042002. RPC `https://rpc.testnet.arc.io`. Explorer `https://explorer.testnet.arc.io` (Blockscout, API under `/api/v2/`). Faucet `https://faucet.circle.com`, 20 USDC per address per 2 hours, reCAPTCHA protected.
- USDC at `0x3600000000000000000000000000000000000000`. The ERC-20 interface has 6 decimals. Native gas accounting has 18 decimals. Both views share one balance. Never mix `msg.value` with `balanceOf`.
- Gas is paid in USDC. Minimum `maxFeePerGas` is 20 Gwei. A transaction below that is silently dropped with no receipt. Block gas limit is 30M. Timestamps are non-decreasing, not strictly increasing. `eth_getLogs` fails above a 10,000-block range.
- BN254 precompiles `0x06`, `0x07`, and `0x08` respond to `eth_call` on Arc Testnet.
- A value transfer to or from a blocklisted address reverts. Whether ERC-20 `transfer` and `transferFrom` revert for blocklisted addresses is UNVERIFIED (task R4). Never add a native-USDC sweep to the escrow.

**Circle's core** (VERIFIED from the explorer's verified source)

- Proxy `0x0747EEf0706327138c69792bF28Cd525089e4583` points to implementation `0xA316fd02827242D537F84730F8a37D0BA5fd351a`, compiled with solc 0.8.28, EVM `cancun`, optimizer off. Source path `src/AgenticCommerce.sol`, plus `src/interfaces/IACPHook.sol`. The proxy was initialized with USDC, a treasury, and an admin. Only that admin can call `setHookWhitelist` or upgrade.
- `createJob(provider, evaluator, expiredAt, description, hook)` requires a nonzero evaluator, `expiredAt > block.timestamp + 5 minutes`, a whitelisted hook, and ERC-165 support for `IACPHook` when the hook is nonzero.
- `setBudget(jobId, amount, optParams)` works only in Open state. The unpatched code allows only the provider.
- `fund(jobId, optParams)` requires Open state, the client as caller, a set provider, and `block.timestamp < expiredAt`. It does not take an expected budget and does not revert when the budget is zero.
- `submit(jobId, deliverable, optParams)` is allowed in Funded state, and also in Open state when the budget is zero. Only the provider may call it.
- `complete(jobId, reason, optParams)` requires Submitted state and the evaluator as caller. `reject` is allowed for the client while Open and for the evaluator while Funded or Submitted.
- `claimRefund(jobId)` is not hooked, is permissionless, and works in Funded or Submitted state once `block.timestamp >= expiredAt`.
- Hook payloads, with `msg.sender` as the first field: `createJob` after-hook `abi.encode(caller, provider, evaluator)` with selector `createJob`; `setBudget` `abi.encode(caller, amount, optParams)`; `fund` `abi.encode(caller, optParams)`; `submit` `abi.encode(caller, deliverable, optParams)`; `complete` and `reject` `abi.encode(caller, reason, optParams)`. The core caps no hook gas. All state-changing core functions are `nonReentrant`.

**RISC Zero** (VERIFIED from the v3.1.0 release)

- Tag `v3.1.0` of `risc0-ethereum` is commit `ff30da77ba4afdd496290ebebedb205348b15d83`. Selector `0xe71e6620`. The release notes state that earlier receipts must be regenerated.
- `RiscZeroGroth16Verifier` takes `constructor(bytes32 control_root, bytes32 bn254_control_id)`. `verify(bytes seal, bytes32 imageId, bytes32 journalDigest)` is `view` and reverts on failure with `VerificationFailed()` or `SelectorMismatch(bytes4,bytes4)`. The seal is a 4-byte selector plus 256 bytes, 260 bytes in total.
- The released test receipt is in `contracts/test/TestReceiptV3_1.sol`. Its `IMAGE_ID` is `c92414d80cdeb43ba0f4ff4882447c21f18b547d41ffa506a84da164e8e31f7d` and its `JOURNAL` is the ASCII text `just a simple receipt`. The control root and BN254 control ID values are UNVERIFIED here (task R3). The mock verifier's existence is UNVERIFIED (task R3).

## 3. Toolchain, layout, and chain-access rules

- The host is Windows. Run the Arc Foundry tools (`arc-forge`, `arc-cast`, `arc-anvil`) inside WSL2, for example `wsl -e bash -lc "cd /mnt/c/... && arc-forge test"`. The repository stays on the Windows file system. Standard `forge` and `anvil` do not reproduce Arc behavior and must not be used for acceptance results. Node runs natively on Windows for the viem examples.
- Layout:

| Path | Purpose |
| --- | --- |
| `contracts/src/core/` | Vendored core and the patch |
| `contracts/src/verifier/` | Vendored verifier and a mock |
| `contracts/src/SettlementHook.sol` | Hook and evaluator |
| `contracts/test/` | Foundry tests |
| `contracts/script/` | Deploy and freeze scripts |
| `contracts/abi/` | Exported ABIs |
| `contracts/deployments/arc-testnet.json` | Deployment manifest |
| `contracts/examples/` | viem examples |
| `contracts/research/` | Research findings |
| `contracts/config/` | Demo and chain parameters |

- **Fork-and-gate** rules for every subagent:
  1. Work on local `arc-anvil --network arc`. If task R1 confirms forking works, also test against forked Arc state.
  2. Read-only network access is allowed: `eth_call`, `eth_getCode`, `eth_getLogs`, explorer GET requests, documentation fetches.
  3. Do not create, request, read, or store private keys. Do not pass `--broadcast` or `--private-key`. Do not send transactions to any live network. Nick runs deploy scripts.
  4. Every script must read the chain ID and abort unless it equals the configured value (5042002).
  5. A subagent that needs a live transaction records the exact command and the expected result in its status entry. It does not run it.
- Follow [agents/AGENTS.md](../AGENTS.md) and the shared rules below. Never weaken a test to make it pass. Mark any claim you cannot verify as UNVERIFIED and open or extend a research task.
- **Commits, pushes, and PRs.** Commit each coherent change on your track's branch. Push after each checkpoint commit and before you end a session. You do not need Nick's approval to push. Open a pull request against `main` when a track reaches a done condition from Section 9 or a gate from Section 11. Write a detailed description: the track and gate it serves, what changed and why, the files and paths touched, the tests run with their results (pass or fail, with the commands), the S-case IDs covered, open UNVERIFIED items, blockers, and the next owner. Link the commits and any transaction or receipt evidence. Do not merge your own pull request unless Nick asks. Exception: Nick pushes `SETTLEMENT-IMPLEMENTATION.md` himself, so subagents never push changes to that file. Request changes to it in your status entry.
- **Progress and decisions.** Add an entry to your own `status.md` at each checkpoint, blocker, or handoff, newest first, with `YYYY-MM-DD HH:MM ±HH:MM` in the heading. Record the branch, what changed, checks and results, blockers, and the next action. Record every decision or change that affects the team, including changes to ownership, dependencies, timing, interfaces, or the corrections in Section 10, in a dated entry at the top of the shared [PLAN.md](PLAN.md) with the author in the heading, the reason, and the affected owners.

## 4. Core: vendored source and the patch

1. Fetch the verified source from the explorer API for implementation `0xA316…351a`, including `IACPHook.sol` and the OpenZeppelin files it imports. Task R2 records the exact OpenZeppelin version and remappings. Copy the files into `contracts/src/core/` unchanged. Keep Circle's compiler settings (solc 0.8.28, `evm_version = "cancun"`, optimizer off).
2. **Provenance test.** Compile the unpatched copy and compare the deployed runtime bytecode with `eth_getCode` of the implementation, ignoring the metadata hash. If it differs, stop and record the difference in `contracts/research/R2.md`.
3. **The patch.** In `setBudget`, change the authorization check from `msg.sender != job.provider` to `msg.sender != job.client`. Store the change as `contracts/src/core/setBudget-client-only.patch`, generated against the unpatched copy. The patch must contain no other change. A test checks that the patched source differs from the unpatched copy in that single line.
4. **Deployment.** Deploy the patched implementation, then an ERC1967 proxy whose initializer is `initialize(USDC, treasury, admin)`. The treasury is any nonzero address. Fees stay at their zero default.
5. **Freeze.** After the hook is deployed, the admin calls `setHookWhitelist(hook, true)` and then `renounceRole` for `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`. Tests prove that `setHookWhitelist`, `setPlatformFee`, `setEvaluatorFee`, and `upgradeToAndCall` all revert afterward.

## 5. Verifier

- Vendor `RiscZeroGroth16Verifier` and its dependencies from `risc0-ethereum` at `ff30da77…`. Read the control root and BN254 control ID from the release's `ControlID.sol` (task R3). Deploy the verifier directly. Check that its `SELECTOR` equals `0xe71e6620` and its `VERSION` equals `3.1.0`.
- Test with `TestReceiptV3_1`: `verify(SEAL, IMAGE_ID, sha256(JOURNAL))` succeeds. A flipped journal byte, a changed image ID, and a changed seal byte each revert. Record the verification gas locally and, when Nick runs the deployment, on Arc.
- Mock: a contract implementing `IRiscZeroVerifier` that accepts one preconfigured `(seal, imageId, journalDigest)` triple and reverts otherwise. Use the upstream mock if task R3 finds one. The evaluator takes the verifier address at construction so tests and the deployment can swap it.

## 6. SettlementHook specification

`SettlementHook` implements `IACPHook` and the evaluator role. It declares ERC-165 support for the `IACPHook` interface ID (task R5 confirms the ID from Circle's `IACPHook.sol`). Every callback reverts unless `msg.sender == core`.

**Immutables:** `core`, `verifier`, `usdc`. **Constants and config:** `MAX_ENVELOPE_BYTES` (default 16384, final value set from the gas measurement in Section 8), `MIN_EXPIRY_MARGIN` (seconds the funded job must remain open, config value).

**Storage**

```solidity
struct Terms { bytes32 imageId; bytes32 rulesHash; bytes32 referenceHash;
               address provider; uint256 budget; uint64 expiry; bool funded; }
struct Submission { bytes32 envelopeHash; bytes32 keyCommitment; bool accepted; }
mapping(uint256 => Terms) public terms;
mapping(uint256 => Submission) public submissions;
mapping(uint256 => bool) public released;
```

**Callback rules.** Decode every payload as the deployed layout. "Read the job" means `core.getJob(jobId)`.

| Selector | Hook | Rule |
| --- | --- | --- |
| `createJob` | after | `abi.decode(data, (address, address, address))`. Require evaluator == `address(this)` and provider != 0 |
| `setBudget` | before | `abi.decode(data, (address, uint256, bytes))`. Require amount > 0 and empty `optParams` |
| `fund` | before | `abi.decode(data, (address, bytes))`, then `abi.decode(optParams, (bytes32, bytes32, bytes32))` as `(imageId, rulesHash, referenceHash)`. Read the job. Require budget > 0, provider != 0, and `expiry >= block.timestamp + MIN_EXPIRY_MARGIN` |
| `fund` | after | Read the job. Require status Funded. Store `Terms` with the provider, budget, and expiry read from the core and `funded = true` |
| `submit` | before | `abi.decode(data, (address, bytes32, bytes))`, then `abi.decode(optParams, (bytes, bytes, bytes32))` as `(envelope, seal, keyCommitment)`. Require `terms.funded`, caller == `terms.provider`, `block.timestamp < terms.expiry`, no accepted submission, `envelope.length <= MAX_ENVELOPE_BYTES`, and `sha256(envelope) == deliverable`. Build the context and journal (Section 7) with verdict 1. Call `verifier.verify(seal, terms.imageId, sha256(journal))`. Any failure reverts |
| `submit` | after | Store `Submission{envelopeHash: deliverable, keyCommitment, accepted: true}`. Emit `ProofAccepted(jobId, envelopeHash, keyCommitment)` |
| `complete` | before | Require that `release` started this call (an internal in-progress flag for this `jobId`) |
| `reject`, others | any | Allow without state changes. The contract never calls `reject` |

**`release(uint256 jobId, bytes32 key)`**

1. Require `msg.sender == terms[jobId].provider`, `submissions[jobId].accepted`, `!released[jobId]`, and `block.timestamp < terms[jobId].expiry`.
2. Rebuild the context. Require `sha256(abi.encodePacked("UBC26/key/v1", context, key)) == submissions[jobId].keyCommitment`.
3. Set `released[jobId] = true` and the in-progress flag. Call `core.complete(jobId, keyCommitment, "")`. Clear the flag. Emit `KeyReleased(jobId, provider, key, envelopeHash)`. A reverting payout reverts the whole transaction.
4. Reentrancy: `core.complete` calls back into this contract's `beforeAction` and `afterAction`. Do not guard `release` and the callbacks with one shared non-reentrant lock. Use the in-progress flag and the core's own `nonReentrant`.

**Hard rules**

- No `reject` or other evaluator escape hatch. The Poster recovers funds only through the core's permissionless `claimRefund` after expiry.
- Time boundary: submit and release require `block.timestamp < expiry`. Refund requires `block.timestamp >= expiry`. The two never overlap.
- A bad submission reverts, so the job stays Funded and the Solver may retry before expiry.
- Read methods and events for the commerce owner: `terms(jobId)`, `submissions(jobId)`, `released(jobId)`, `ProofAccepted`, `KeyReleased`, plus the core's `JobCreated`, `BudgetSet`, `JobFunded`, `JobSubmitted`, `JobCompleted`, `PaymentReleased`, `Refunded`, and `JobExpired`.

## 7. Wire formats

These come from [ZKVM-IMPLEMENTATION.md](ZKVM-IMPLEMENTATION.md) and must stay byte-identical.

```text
context       = 0x01 || chainId[32] || escrow[20] || jobId[32] || provider[20]
                || rulesHash[32] || referenceHash[32]                     (169 bytes)
journal       = context || verdict[1] || envelopeHash[32] || keyCommitment[32]   (234 bytes)
journalDigest = SHA256(journal)
keyCommitment = SHA256("UBC26/key/v1" || context || key[32])
```

`chainId` is `block.chainid` as a 32-byte big-endian value. `escrow` is `core`. `provider`, `rulesHash`, and `referenceHash` come from the frozen `Terms`. `jobId` is the core job ID. The image ID passed to `verify` is `Terms.imageId`.

Fixture, used as a Solidity unit test: chain ID 5042002, job ID 7, escrow `0x11`×20, provider `0x22`×20, rules hash `0x33`×32, reference hash `0x44`×32, verdict 1, envelope hash `ad46cb73…12e6`, key commitment `3bbc3bf1…c99d`, key `0x55`×32. The journal digest must equal `9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e`. The full values are in the ZKVM plan. The test constructs the context with those values directly, because the live chain ID and escrow differ.

Function inputs:

| Call | Encoding |
| --- | --- |
| `createJob` | `(provider, evaluator = SettlementHook, expiredAt, description, hook = SettlementHook)` |
| `fund` `optParams` | `abi.encode(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash)` |
| `submit` `deliverable` | `envelopeHash` |
| `submit` `optParams` | `abi.encode(bytes envelope, bytes seal, bytes32 keyCommitment)` |
| `release` | `(jobId, key)` |

## 8. Deployment, manifest, and tests

**Deployment order** (Nick runs it): verifier, core implementation, core proxy, `SettlementHook`, whitelist the hook, renounce both admin roles. Each step is a separate script with a chain-ID guard, a dry run, and a post-condition check.

**Manifest** `contracts/deployments/arc-testnet.json`: chain ID, RPC and explorer URLs, USDC address and decimals, core proxy and implementation addresses, hook/evaluator address, verifier address and selector, ABI file paths, fee policy (zero), `MIN_EXPIRY_MARGIN`, core minimum expiry (5 minutes), `MAX_ENVELOPE_BYTES`, source commits and compiler settings, patch checksum, and the hook payload layouts from Section 2.

**Test matrix** (track T4 writes these from this document, not from the implementation):

| ID | Case | Expected |
| --- | --- | --- |
| S1 | Core bytecode provenance (unpatched copy vs Circle's) | Match modulo metadata |
| S2 | Patch is a single line; Solver `setBudget` reverts; Poster `setBudget` works | Pass |
| S3 | Callbacks called by a non-core address | Revert |
| S4 | Zero budget, unfunded `submit`, wrong evaluator, zero provider | Revert |
| S5 | Wrong image ID, mutated envelope, invalid seal | `submit` reverts, job stays Funded |
| S6 | Genuine verdict-0 receipt | Verifies on the verifier, rejected on `submit` |
| S7 | Commitment substitution, and replay across job, provider, escrow, and chain | Revert |
| S8 | Retry after a failed submission before expiry | Succeeds |
| S9 | Wrong key, early release, non-Solver release, duplicate release | Revert, balances unchanged |
| S10 | Expiry before submission, expiry after submission, exact-expiry second | Refund works, submit and release revert |
| S11 | Reverting payout (blocklisted or reverting recipient mock) | `release` reverts, state unchanged |
| S12 | USDC balance deltas for payout and refund | Exact |
| S13 | Admin roles renounced | All admin calls revert |
| S14 | Journal digest fixture | Equals `9ae8cca7…115e` |
| S15 | Gas for `submit` at `MAX_ENVELOPE_BYTES` and at a typical size | Recorded; cap confirmed or reduced |
| S16 | Upstream `TestReceiptV3_1` on the real verifier | Passes; tampering fails |

Acceptance for the Nov 16 gate also needs transaction receipts on Arc for one accepted proof, one payout with key release, one expiry refund, and one rejected submission, plus USDC balance evidence.

## 9. Subagent tracks and research tasks

Each track owns a set of paths and edits nothing else. If a track needs a change in another track's files, it records the request in its status entry.

| Track | Owns | Needs | Done when |
| --- | --- | --- | --- |
| R research | `contracts/research/` | Nothing | Tasks R1 to R5 answered with sources |
| T1 core | `contracts/src/core/`, the patch | R1, R2 | S1 and S2 pass |
| T2 verifier | `contracts/src/verifier/` | R1, R3 | S16 passes locally |
| T3 hook and evaluator | `contracts/src/SettlementHook.sol` | R2, R5, Sections 6 and 7 | Compiles, ERC-165 works, all Section 6 rules implemented |
| T4 tests | `contracts/test/` | Sections 6 to 8 only | S1 to S15 green on local `arc-anvil` |
| T5 deploy and handoff | `contracts/script/`, `deployments/`, `abi/`, `examples/` | T1 to T3 | Dry runs pass; manifest schema, ABIs, and viem preflight and decoder examples exist |
| Review | Nothing (read-only) | All | A written review of hook ordering, replay protection, and the freeze step |

T3 and T4 start in parallel from this document. T4 must not read `SettlementHook.sol` before writing its tests. Disagreements between the two are resolved by this document.

**Research tasks**

- **R1 Arc Foundry.** Find the pinned release at `github.com/circlefin/arc-foundry/releases`, the working WSL invocation, and whether `arc-forge` supports forking (`--fork-url`). Record the flags used for acceptance tests.
- **R2 Circle source.** Confirm the OpenZeppelin version and remappings that match the verified source. Run the provenance comparison. Read the live core settings with `eth_call`: platform and evaluator fee, hook whitelist for address zero, role holders, and the ERC1967 implementation slot.
- **R3 RISC Zero.** Read `ControlID.sol`, `Groth16Verifier.sol`, and the deployment scripts at `ff30da77…`. Record the control root and BN254 control ID. Find the upstream mock verifier, its selector behavior, and the exact seal length. Check whether any `deployment.toml` entry lists Arc.
- **R4 Arc behavior.** Check ERC-20 behavior of USDC for transfers into and out of a contract, including a blocklisted address (the contract-addresses page lists a seeded test address). Check `approve` semantics and any `permit` support. Measure gas for a 16 KiB calldata transaction with `eth_estimateGas` and find any transaction size limit.
- **R5 Hook interface.** Compute the ERC-165 interface ID of Circle's `IACPHook` and record it with its source.

## 10. Corrections for the other owners

These affect [WORK-SPLIT.md](WORK-SPLIT.md), [ZKVM-IMPLEMENTATION.md](ZKVM-IMPLEMENTATION.md), and [Anish's context](../anish/AGENTS.md). They are not edited here.

1. WORK-SPLIT sections 2.4 and 2.6 decode hook data as `(bytes32, bytes)`. The deployed layout is `(address, bytes32, bytes)`. The `fund` payload is `(address, bytes)` and wraps `abi.encode(bytes32, bytes32, bytes32)`.
2. WORK-SPLIT section 2.1 starts from draft revision `a078cab5`. Use Circle's verified source plus the one-line patch instead.
3. Funding takes four Poster transactions: `createJob`, `setBudget`, a USDC `approve` for exactly the bounty, and `fund`. The Solver does not call `setBudget`. `fund` has no expected-budget argument.
4. The core rejects any job whose expiry is not more than 5 minutes ahead. The refund demo needs jobs open for at least that long on Arc.
5. Any signer that sends Arc transactions must set `maxFeePerGas` at or above 20 Gwei. Log readers must page `eth_getLogs` in ranges of at most 10,000 blocks.
6. `agents/anish/AGENTS.md` still cites verifier commit `f6d9398`. The current pin is v3.1.0 at `ff30da77…`.
7. Circle's core calls the hook after `createJob`. Circle's own deployment is upgradeable by its admin. Ours is frozen by role renunciation.

## 11. Build order and gates

| Date | Gate | Evidence |
| --- | --- | --- |
| Nov 14 | Verifier and research | R1 to R5 answered. Nick deploys the pinned verifier on Arc. Upstream receipt verifies on Arc and tampering fails. Gas recorded |
| Nov 15 | Contracts and local tests | T1 to T3 complete. S1 to S16 green locally. Manifest schema and ABIs sent to Anish and Neil |
| Nov 16 | Settlement on Arc | Nick deploys and freezes. Rejected proof and wrong key preserve funds. Valid release pays and exposes the key. Expiry refund works. Receipts and balances recorded |
| After Anish delivers | Real receipts | Replace the mock with real engine receipts for one verdict-1 and one verdict-0 job and repeat the Nov 16 checks |
