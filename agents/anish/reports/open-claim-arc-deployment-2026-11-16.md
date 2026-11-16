# Open-claim adapter Arc Testnet deployment

2026-11-16 09:05 -05:00 — Authorized single creation transaction. The [deployed manifest](../../../contracts/deployments/open-claim-arc-testnet.json) is the machine-readable record.

## Deployment result

| Field | Verified value |
| --- | --- |
| Chain | Arc Testnet, `5042002` |
| Deployer | `0xA2416Eb8159606C133298fF113a472608E6F9Fb7`; nonce 0 |
| Adapter | [`0x1fEd5e532A1405FAcD45b4096aD1ABf25BbA0CB8`](https://explorer.testnet.arc.io/address/0x1fed5e532a1405facd45b4096ad1abf25bba0cb8) |
| Creation transaction | [`0x30a8bc27f9cecf068eeaf5c822196c5149f825671c4e65013d559de353572e14`](https://explorer.testnet.arc.io/tx/0x30a8bc27f9cecf068eeaf5c822196c5149f825671c4e65013d559de353572e14) |
| Receipt | Status 1 in block `72563239`, hash `0x666c97bfadec79f87ab407dafd3dd714dc37b79638a6611b0e904eff0373ea32` |
| Runtime | 11,311 bytes; Keccak-256 `0x469a337cfb28530e01426274e353792fee03ea8cc7f9663a63c5f9c2a4e13f20` |
| Creation data | 13,222 bytes; Keccak-256 `0xad7f68985c4978a117d467a8e89321f0b6d4b539492cd34beb1280f104b321d6` |
| Gas | Limit 3,000,000; used 2,538,847; max fee 25 gwei; max priority fee 25 gwei; effective price 25 gwei; paid **0.063471175 testnet USDC** |

The constructor arguments, in order, were core proxy `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8`, real RISC Zero verifier `0xCf8D70A203b40D3A17d023c0CDDF752870BC3992`, and native USDC `0x3600000000000000000000000000000000000000`. The transaction value was zero. The receipt and transaction satisfy the user's approved 3,000,000-gas and 25-gwei maximum fee bounds, whose maximum charge was 0.075 testnet USDC.

## Checks before broadcast

The [read-only preflight](open-claim-arc-preflight-2026-11-16.md) had already replayed all core role events from deployment through block 72554683 and found no admin holders. The dedicated Foundry keystore unlocked from its macOS Keychain password. [Circle's public faucet](https://faucet.circle.com/) sent 20 testnet USDC to the signer in [transaction `0x07dc82…e292`](https://testnet.arcscan.app/tx/0x07dc82fda622993c71cce5d389f2e2aa141945e39ef5f1a87569055ed120e292), confirmed in block 72562912.

Immediately before broadcast, read-only calls at fixed block **72563220**, hash `0xb5f89f04d059956e5ca5d9d5c6e7cf52ecbea7c6590e71709082c7cbd066c62a`, confirmed chain state. The core proxy, patched implementation and verifier runtime hashes matched the pinned manifest. The ERC-1967 implementation slot, core payment token, both zero fees and exact adapter creation hash matched. The signer held 20 native testnet USDC, had nonce zero, and `eth_estimateGas` from that signer returned 2,560,164 gas. No privilege, hook-whitelist or upgrade events occurred between the earlier complete replay and this block. Base fee was 20 gwei. These `curl --retry 0` reads exited 0.

## Exact broadcast and verification commands

The pinned binary was `/Users/anishnarang/.local/share/ubc26/sprints/2026-11-15-core/tools/arc-foundry/forge`, commit `3e95efaeaaaca64d6ac9c1ee988968683dbd0d22`. The encrypted keystore was `ubc26-openclaim-arc-testnet`. Its password came from macOS Keychain into a temporary mode-0600 password file, which was deleted in a `finally` block. Neither private key nor password was printed or committed.

```sh
"$ARC_FORGE" create src/OpenClaimAdapter.sol:OpenClaimAdapter \
  --chain 5042002 --rpc-url https://rpc.testnet.arc.io \
  --account ubc26-openclaim-arc-testnet \
  --from 0xA2416Eb8159606C133298fF113a472608E6F9Fb7 \
  --password-file "$TEMP_PASSWORD_FILE" \
  --gas-limit 3000000 --gas-price 25gwei --priority-gas-price 25gwei \
  --broadcast \
  --constructor-args \
  0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8 \
  0xCf8D70A203b40D3A17d023c0CDDF752870BC3992 \
  0x3600000000000000000000000000000000000000
```

This command exited 0 and returned the adapter address and transaction above. **It is historical evidence, not an instruction to deploy another adapter.**

Read-only RPC calls after confirmation fetched `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getBlockByNumber`, `eth_getCode`, and the adapter's `core()`, `verifier()` and `usdc()` getters at the deployment block. They exited 0. The receipt status was 1, its contract address matched Forge's output, the transaction sender/nonce/value/chain/fee fields matched the approved command, and the transaction input was byte identical to the compiled init code plus the three 32-byte arguments. The getter addresses matched the constructor values.

The deployed runtime matched the compiled `OpenClaimAdapter` artifact byte for byte after substituting its three immutable values at all 18 compiler-listed reference offsets. Reference IDs `39372`, `39375` and `39378` mapped consistently to core, verifier and USDC. The runtime hash above was read from chain code. A later `eth_getCode` at head block 72563331 still returned 11,311 bytes, more than three blocks after creation.

Source verification also passed:

```sh
"$ARC_FORGE" verify-contract \
  0x1fEd5e532A1405FAcD45b4096aD1ABf25BbA0CB8 \
  src/OpenClaimAdapter.sol:OpenClaimAdapter \
  --chain 5042002 --verifier blockscout \
  --verifier-url https://explorer.testnet.arc.io/api/ \
  --creation-transaction-hash 0x30a8bc27f9cecf068eeaf5c822196c5149f825671c4e65013d559de353572e14 \
  --watch
```

This command exited 0 with `Pass - Verified`. The independent Blockscout API read reported `is_verified: true`, compiler `v0.8.28+commit.7893614a`, optimizer disabled, EVM `cancun`, and the exact 96-byte constructor arguments. Its published `source_code` had SHA-256 `ebf15d533353db02227ddbd0ef940cdfa318c7f8d2488197eed45d7bee2e611b`, identical to the local Solidity file. The deployed manifest records the explorer verification time `2026-11-16T14:05:31.492297Z`.

The adapter deployment is verified. A fresh funded Arc proof, buyer/solver signing policy, live claim/release and Circle Gateway payment remain separate integration gates; neither this transaction nor the local combined proof proves those live outcomes. The “Complete UBC-26 proof commerce” chat owns PR #7 integration and final CI.
