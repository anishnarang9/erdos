# Open-claim deployment manifest v1

2026-11-16 — Anish.

`open-claim-arc-testnet.template.json` is a proposed configuration and keeps null adapter fields. `open-claim-arc-testnet.json` is the verified deployed adapter record. Preserve the selected-provider `arc-testnet.json` unchanged.

| Field | Required meaning |
| --- | --- |
| schemaVersion | Integer 1 |
| interfaceVersion | `open-claim-v1` |
| network | `arc-testnet` or `local-arc` |
| status | `proposed-not-deployed` in the template; `deployed-verified` only after a confirmed authorized deployment and independent code checks |
| chainId | Integer 5042002 |
| usdc | Six-decimal native USDC ERC-20 address `0x3600000000000000000000000000000000000000` |
| core | Pinned proxy address, implementation address, proxy runtime hash, deployment block and freeze result |
| coreImplementationRuntimeCodeHash | Keccak-256 runtime hash of the patched implementation |
| verifier | Pinned real verifier address, runtime hash, version `3.1.0` and selector `0xe71e6620` |
| adapter | Address, runtime hash and byte length, deploy transaction/block/hash and signer, constructor values, creation data hash, source contract/commit/hash, exported ABI path, gas fields and explorer URL |
| policy | Both adapter roles, zero hook, zero fees, expiry limits, solver payout identity and context domain |
| abis | Paths relative to `contracts/` |
| evidence | Explicit independent deployment, fresh proof and live exchange results; preflight block/hash, receipt, compiled-bytecode/immutable checks and explorer source verification |

The four unconfirmed adapter values remain JSON null in the template. The deployed manifest replaces each with independently checked chain evidence, including byte-for-byte runtime comparison after compiler-listed immutable substitution. Never use zero addresses or invented transaction hashes as deployment evidence. `adapterDeployed: true` does not imply `freshFundedProof` or `liveArcExchange`; those flags remain false until their separate live checks pass.

Before live use, reconstruct all core admin role holders through a fixed verification block. Require empty role sets, expected implementation and all runtime pins, correct immutable adapter wiring, correct real verifier selector and version, expected token, and both zero fees. Copying a historical `frozen` field does not perform those checks or authorize spending.

The local script writes `open-claim-local.json`. That file is runtime output and must stay outside commits. It uses a fresh patched core, real verifier and native local USDC. Anvil unlocked accounts serve only the local node. The local deploy script must reject live nodes before broadcasting.

Refunds call the core directly. The adapter stores historical terms and submissions. Consumers must read current core status to exclude refunded or completed jobs from discovery.
