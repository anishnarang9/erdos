# Deployment manifest schema

`arc-testnet.json` is the single record of the Arc Testnet deployment. It is a template until Nick deploys: every address is `null`. Scripts in `contracts/script/` fill the address fields (only when run with `--broadcast`); everything else is fixed text. `local.json` (git-ignored) has the same shape and is written by a local broadcast. Hex values are 0x-prefixed. Addresses are EIP-55 strings or null.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer, 1 |
| `network` | `arc-testnet` |
| `status` | `template`, `partial` (some steps done), or `frozen` (step 5 done) |
| `deployer` | Account that signed steps 03 to 05 and held the admin roles until the freeze. Set by step 03 |
| `chain.chainId` | 5042002. Scripts abort when the live chain ID differs |
| `chain.rpcUrl`, `explorerUrl`, `explorerApi` | Public endpoints (Blockscout under `/api/v2/`) |
| `chain.blockGasLimit` | 30,000,000 |
| `chain.minMaxFeePerGasGwei` | 20. A lower `maxFeePerGas` is dropped silently |
| `chain.maxLogBlockRange` | 10,000. Larger `eth_getLogs` ranges fail |
| `chain.timestampsNonDecreasing` | True: two blocks can share a timestamp |
| `usdc.address`, `usdc.decimals` | Arc USDC (6 decimals in the ERC-20 view). In `local.json` this is the mock USDC |
| `contracts.verifier.address` | Deployed `RiscZeroGroth16Verifier` |
| `contracts.verifier.selector`, `version` | `0xe71e6620`, `3.1.0`; checked on chain |
| `contracts.verifier.controlRoot`, `bn254ControlId` | Constructor arguments from `ControlID.sol` at risc0-ethereum `ff30da77` |
| `contracts.verifier.sealLengthBytes` | 260 (4-byte selector plus 256 bytes) |
| `contracts.verifier.abi`, `interfaceAbi` | Paths relative to `contracts/` |
| `contracts.coreImplementation.address` | Patched `AgenticCommerce` implementation (not the proxy) |
| `contracts.coreImplementation.contract`, `patch` | Source path and patch file |
| `contracts.core.address` | ERC1967 proxy. This is the escrow address the clients call and the `escrow` field of the context |
| `contracts.core.implementation` | Implementation the proxy points to (equals `coreImplementation.address`) |
| `contracts.core.treasury` | Fee treasury, never paid because fees are zero |
| `contracts.core.frozen` | True after step 5 |
| `contracts.hook.address` | `SettlementHook`: both the job's hook and its evaluator |
| `contracts.hook.erc165InterfaceId` | `0x7ff6bc9e` (`IACPHook`) |
| `contracts.hook.maxEnvelopeBytes` | 16412 (16,384-byte bundle + 12-byte nonce + 16-byte tag). Larger envelopes make `submit` revert |
| `contracts.hook.minExpiryMarginSeconds` | Seconds a job must still have when funded. Read from `config/arc-testnet.json` |
| `contracts.*.deployer`, `deployBlock` | Signer and the block number seen at script time (a lower bound for log scans; the transaction may land a few blocks later) |
| `reference.*` | Circle's own proxy and implementation, for provenance only |
| `policy.fees` | Platform and evaluator fee basis points, both 0 |
| `policy.adminRoles` | Both admin roles are renounced in step 5 |
| `policy.coreMinExpirySeconds`, `coreMinExpiryRule` | `createJob` needs `expiredAt > now + 300` (strict) |
| `policy.hookMinExpiryMarginSeconds`, `hookMinExpiryMarginRule` | `fund` needs `expiredAt >= now + margin` |
| `policy.maxEnvelopeBytes` | Same as `contracts.hook.maxEnvelopeBytes` |
| `policy.timeBoundary` | `submit` and `release` need `block.timestamp < expiredAt`; `claimRefund` needs `>= expiredAt` |
| `sources.risc0Ethereum` | Repo, tag `v3.1.0`, commit `ff30da77ba4afdd496290ebebedb205348b15d83` |
| `sources.circleImplementation` | Circle implementation `0xA316...351a` and its verified source URL, OpenZeppelin 5.6.x (patch release UNVERIFIED) |
| `sources.forgeStd` | v1.9.7, tests and scripts only |
| `sources.patch` | Patch path and SHA-256 `98887ae10e08040c0dc957ed6a07a753a651e3c23e402bc562f17099eb2bf618`; the change is one line in `setBudget` |
| `sources.settlementRepoCommit` | Repository commit of the contract sources the scripts deploy. Update when the contracts change |
| `compiler` | solc 0.8.28, EVM `cancun`, optimizer off, no via-IR, toolchain version |
| `abis` | Map of contract name to ABI path (`contracts/abi/*.json`) |
| `hookPayloads` | For each core function, when the hook is called and the `data` layout. Every payload starts with `address caller` |
| `encodings` | Context, journal, digest and key commitment byte layouts, per-call input encodings, and the engine fixture values |
| `posterTransactions` | The four Poster transactions in order, with their events |
| `solverTransactions` | `submit` and `release` with their events |
| `refund` | `claimRefund(jobId)`: permissionless once `block.timestamp >= expiredAt` |

Core events: `JobCreated(jobId indexed, client indexed, provider indexed, evaluator, expiredAt, hook)`, `BudgetSet(jobId indexed, amount)`, `JobFunded(jobId indexed, client indexed, amount)`, `JobSubmitted(jobId indexed, provider indexed, deliverable)`, `JobCompleted(jobId indexed, evaluator indexed, reason)`, `PaymentReleased(jobId indexed, provider indexed, amount)`, `Refunded(jobId indexed, client indexed, amount)`, `JobExpired(jobId indexed)`. Hook events: `TermsFrozen(jobId indexed, provider indexed, imageId, rulesHash, referenceHash, budget, expiry)`, `ProofAccepted(jobId indexed, envelopeHash, keyCommitment)`, `KeyReleased(jobId indexed, provider indexed, key, envelopeHash)`.
