# Settlement interface handoff

**2026-11-14 · Nick (workstream 2) → Neil (commerce) and Anish (engine)**

This is the contract-level interface for settlement on Arc Testnet (chain 5042002). The spec is [SETTLEMENT-IMPLEMENTATION.md](../agents/current%20plan/SETTLEMENT-IMPLEMENTATION.md). Code examples are in [examples/README.md](examples/README.md). Live addresses are in [deployments/arc-testnet.json](deployments/arc-testnet.json) (schema: [SCHEMA.md](deployments/SCHEMA.md)).

## Live on Arc Testnet

| Contract | Address | Deployed in block |
| --- | --- | --- |
| Core (escrow proxy, the address you call) | [`0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8`](https://explorer.testnet.arc.io/address/0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8) | 72393888 |
| Core implementation (patched) | [`0x55A3C9319EEe607579855880b5651766eBF103d7`](https://explorer.testnet.arc.io/address/0x55A3C9319EEe607579855880b5651766eBF103d7) | 72392852 |
| SettlementHook (hook and evaluator) | [`0x699d0e4a067F31229Be67C534B37dE964b6eDbAb`](https://explorer.testnet.arc.io/address/0x699d0e4a067F31229Be67C534B37dE964b6eDbAb) | 72394174 |
| RiscZeroGroth16Verifier v3.1.0 | [`0xCf8D70A203b40D3A17d023c0CDDF752870BC3992`](https://explorer.testnet.arc.io/address/0xCf8D70A203b40D3A17d023c0CDDF752870BC3992) | 72392474 |

Notes on the deployment:
- **Hook settings:** the hook is whitelisted on the core in block 72394225. Its on-chain settings are `MAX_ENVELOPE_BYTES = 16412` and `MIN_EXPIRY_MARGIN = 600`, and it reports `supportsInterface(0x7ff6bc9e) == true`.
- **Verifier evidence:** see [research/ARC-VERIFIER-LIVE.md](research/ARC-VERIFIER-LIVE.md).
- **Recorded freeze completed:** the manifest records `frozen: true`. The deployer renounced `ADMIN_ROLE` in tx `0xe9881b7e…0202` (block 72472531) and `DEFAULT_ADMIN_ROLE` in tx `0x01de71f7…0d1d` (block 72472534). Nick's evidence at block 72472573 reports no holders, zero fees, the intended whitelist, and matching runtime pins.
- **The all-holder script defect is corrected.** The scripts now discover every account from role events and check current membership. Earlier unfrozen observations and the broadcaster-only defect describe the prior revision.
- **Independent verification remains required.** A script-written `frozen: true` or Nick's snapshot alone does not authorize signing. Reconstruct both role-holder sets from every proxy-emitted `RoleGranted` and `RoleRevoked` event, including initialization in deployment block 72393888. Use one fixed verification block. Order logs by block, transaction index and log index. Require complete, gap-free history and page Arc requests at no more than 10,000 blocks. Require both final holder sets to be empty. Cross-check every discovered account with `hasRole` at that same block.
- **Verify provenance at that block.** Confirm the ERC-1967 implementation slot and runtime code against the pinned patched build. Check all four runtime hashes, verifier version and selector, both zero fees, and the intended hook whitelist. Review intervening upgrades, role-admin changes and initialization history, including the constructor upgrade, initial grants and `Initialized(1)`. Event reconstruction alone is insufficient when implementation provenance is unknown or code can mutate roles without events. Archive the block number/hash, logs and read results. Missing history, unexpected code or any remaining holder leaves freeze unproven. [OpenZeppelin role enumeration guidance](https://docs.openzeppelin.com/contracts/5.x/access-control#querying-privileged-accounts).
- **No live write is authorized by this handoff.** Do not repeat the completed freeze. Keep worker signing blocked until independent checks and separate spending/signing approvals pass.
- **Start log scans** at the core's deploy block, 72393888.

## Limits and rules at a glance

| Item | Value |
| --- | --- |
| Envelope cap (`MAX_ENVELOPE_BYTES`) | **16,412 bytes**. `submit` with 16,413 bytes or more reverts, and the job stays Funded |
| Seal | 260 bytes: selector `0xe71e6620` followed by 256 bytes of Groth16 proof (RISC Zero v3.1.0) |
| Core minimum expiry | `createJob` needs `expiredAt > block.timestamp + 300` |
| Hook minimum margin (`MIN_EXPIRY_MARGIN`) | `fund` needs `expiredAt >= block.timestamp + 600` |
| Submit and release | Need `block.timestamp < expiredAt` |
| Refund | `claimRefund` needs `block.timestamp >= expiredAt` and status Funded or Submitted. Anyone may call it. The exact expiry second belongs to refund, so the two windows never overlap |
| Budget | Must be above 0. The unit is USDC with 6 decimals (`0x3600000000000000000000000000000000000000`). Fees are 0 and frozen |
| Fee floor | `maxFeePerGas` must be at least 20 gwei, or Arc drops the transaction silently |
| Log paging | `eth_getLogs` is limited to 10,000 blocks per call |

## ABIs

These are exported from the build by `script/export-abi.sh`:

- [`abi/AgenticCommerce.json`](abi/AgenticCommerce.json): the **patched** core. `setBudget` is Poster-only.
- [`abi/SettlementHook.json`](abi/SettlementHook.json): the hook and evaluator.
- [`abi/RiscZeroGroth16Verifier.json`](abi/RiscZeroGroth16Verifier.json) and [`abi/IRiscZeroVerifier.json`](abi/IRiscZeroVerifier.json).

## Writes

| Who | Call | Encoding |
| --- | --- | --- |
| Poster | `core.createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook)` | `evaluator = hook = SettlementHook`, `provider != 0` |
| Poster | `core.setBudget(uint256 jobId, uint256 amount, bytes optParams)` | `optParams` must be empty |
| Poster | `usdc.approve(core, amount)` | The exact budget. `fund` has no expected-budget argument |
| Poster | `core.fund(uint256 jobId, bytes optParams)` | `abi.encode(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash)`, exactly 96 bytes |
| Solver | `core.submit(uint256 jobId, bytes32 deliverable, bytes optParams)` | `deliverable = sha256(envelope)`; `optParams = abi.encode(bytes envelope, bytes seal, bytes32 keyCommitment)` |
| Solver | `hook.release(uint256 jobId, bytes32 key)` | Only the funded provider may call it, after an accepted submit |
| Anyone | `core.claimRefund(uint256 jobId)` | After expiry |

Nobody can reject a Funded or Submitted job. Only `hook.release` can complete one.

## Read methods

| Method | Returns |
| --- | --- |
| `core.getJob(jobId)` | `(id, client, provider, evaluator, description, budget, expiredAt, status, hook)`. Status order: Open 0, Funded 1, Submitted 2, Completed 3, Rejected 4, Expired 5 |
| `hook.terms(jobId)` | `(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash, address provider, uint256 budget, uint64 expiry, bool funded)` |
| `hook.submissions(jobId)` | `(bytes32 envelopeHash, bytes32 keyCommitment, bool accepted)` |
| `hook.released(jobId)` | `bool` |
| `hook.contextOf(jobId)` | The exact 169-byte context the hook binds. Use it for the engine input and the key commitment |
| `hook.expectedJournal(jobId, envelopeHash, keyCommitment)` | `(bytes journal, bytes32 journalDigest)` that `submit` will verify with verdict 1 |
| `hook.MAX_ENVELOPE_BYTES()`, `hook.MIN_EXPIRY_MARGIN()`, `hook.core()`, `hook.verifier()`, `hook.usdc()` | Configuration |

## Events

| Contract | Event |
| --- | --- |
| Hook | `TermsFrozen(uint256 indexed jobId, address indexed provider, bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash, uint256 budget, uint64 expiry)` |
| Hook | `ProofAccepted(uint256 indexed jobId, bytes32 envelopeHash, bytes32 keyCommitment)` |
| Hook | `KeyReleased(uint256 indexed jobId, address indexed provider, bytes32 key, bytes32 envelopeHash)` |
| Core | `JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)` |
| Core | `BudgetSet(uint256 indexed jobId, uint256 amount)` |
| Core | `JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)` |
| Core | `JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)` |
| Core | `JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)`, where `reason` is the key commitment |
| Core | `PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount)` |
| Core | `Refunded(uint256 indexed jobId, address indexed client, uint256 amount)` |
| Core | `JobExpired(uint256 indexed jobId)` |

A valid submit emits `JobSubmitted` then `ProofAccepted`. A release emits `JobCompleted`, `PaymentReleased`, then `KeyReleased`.

## Wire format (engine)

This is byte-identical to ZKVM-IMPLEMENTATION Section 3. Both `SettlementCodec` and `examples/encode.ts` reproduce the fixture digest `9ae8cca7…115e`.

```text
context       = 0x01 || chainId[32] || escrow=core[20] || jobId[32] || provider[20] || rulesHash[32] || referenceHash[32]   (169 B)
journal       = context || verdict=0x01 || envelopeHash[32] || keyCommitment[32]                                         (234 B)
keyCommitment = sha256("UBC26/key/v1" || context || key[32])
```

## Client must-checks

These are from the review in [research/REVIEW.md](research/REVIEW.md).

1. Before working on a job, require `job.hook == hook`, `job.evaluator == hook` and `terms(jobId).funded`. The frozen core still accepts jobs with `hook = 0`, and the hook cannot protect those jobs.
2. Check `terms.expiry` against your real proving time. The only on-chain floor is 600 s.
3. Send `submit` with an explicit gas limit after an `eth_call` simulation. A tampered seal burns nearly all forwarded gas.
4. The key becomes public in calldata when `release` is sent, so do not send it in an `eth_call` to an untrusted RPC.

## Still to come

- **Next handoff:** the full deployment manifest plus one funded test job, with its provider, image ID, rules hash, reference hash and the context hex from `contextOf`. `script/08_CreateTestJob.s.sol` produces it.
- **Nov 16:** full live settlement.
