# Open-claim Arc Testnet deployment preflight

2026-11-16 08:54 -05:00 — Read-only. No wallet, signature, transaction, or live adapter deployment.

## Fixed block and contract state

All state calls and the creation gas estimate used block `72554683` (`0x45318bb`), hash `0x240f99565001722f6bfdbeb85e475c7cc0445b8b66ea482cda88fcf68c61192f`, timestamp `1794831829`, and base fee 20 gwei. RPC chain ID was `5042002`. The RPC was `https://rpc.testnet.arc.io`.

| Check at block 72554683 | Observed result |
| --- | --- |
| Core proxy `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8` | 212-byte runtime; Keccak-256 `0xdac3085f81cca92bb363b27a29074c33a338ba3c89cc395dc097ba20fac576d7` |
| ERC-1967 implementation slot | `0x55A3C9319EEe607579855880b5651766eBF103d7` |
| Patched implementation at that address | 21,560-byte runtime; Keccak-256 `0x7bdd6ba79fb1560523b2228edf03bef923f33edf41de728044de5ccae4037d13` |
| Verifier `0xCf8D70A203b40D3A17d023c0CDDF752870BC3992` | 7,480-byte runtime; Keccak-256 `0x0b496507a375b268f944877d4057cb475d412ea3f9376d406ae40a13fea49012`; `VERSION()` 3.1.0; `SELECTOR()` `0xe71e6620` |
| Native USDC `0x3600000000000000000000000000000000000000` | Six ERC-20 decimals; core `paymentToken()` equals this address |
| Core fees | `platformFeeBP()` 0; `evaluatorFeeBP()` 0 |

These values match `contracts/deployments/arc-testnet.json` and the open-claim template. The core proxy, implementation, verifier, token, and both fees were read independently from chain state at the same block.

## Complete freeze history

A rate-limited replay read `RoleGranted`, `RoleRevoked`, `HookWhitelistUpdated`, and `Upgraded` from core deployment block `72393888` through block `72554683`: 17 log windows, six matching logs, zero removed logs, exit 0. The only role holder ever granted was deployer `0x27f97754b165B68921c9dD0Ea88eDf617731A35a`. Both roles were revoked. The replay found no later grants, revocations, whitelist changes, or upgrades. `hasRole` for that deployer returned false for `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE`; `getRoleAdmin` for both returned `DEFAULT_ADMIN_ROLE`. The replayed holder sets were empty. The pinned hook and zero hook were whitelisted.

| Event | Block | Transaction |
| --- | --- | --- |
| Proxy upgraded to pinned implementation; both roles granted to deployer | 72393888 | `0xa39e70bae70c5ec6fd6f3742d1d3b8142531ff45c56cf08cd8b129d7b53d8a89` |
| Hook whitelisted | 72394225 | `0x5879f15659775285135a61ffad4b18110a21538fe2350449d5b6c99ec76577ef` |
| `ADMIN_ROLE` revoked | 72472531 | `0xe9881b7eb459774311f565c53abd58fdc08c8939ea6c32bff0a039928a060202` |
| `DEFAULT_ADMIN_ROLE` revoked | 72472534 | `0x01de71f7adc814a1c22f6531c65add4c1a8192ed86718630b4bd38ad64da0d1d` |

The existing read-only `06_Verify` script checked verifier, core implementation, proxy, and hook, then exited 1 on RPC HTTP 429 during its role-log replay. It did not print `ok frozen`. The slower independent replay above completed the role check. The verification script was not treated as a complete pass.

## Unsigned adapter creation preview

Constructor values, in order:

1. Core proxy: `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8`.
2. RISC Zero verifier: `0xCf8D70A203b40D3A17d023c0CDDF752870BC3992`.
3. Native USDC: `0x3600000000000000000000000000000000000000`.

The creation data is the compiled 13,126-byte init code plus 96 bytes of ABI-encoded constructor arguments: 13,222 bytes. Its Keccak-256 is `0xad7f68985c4978a117d467a8e89321f0b6d4b539492cd34beb1280f104b321d6`. An isolated offline Forge build reproduced the artifact init and runtime bytecode, including metadata. All 30 artifact metadata source hashes matched files on disk. `src/OpenClaimAdapter.sol` Keccak-256 was `0x7bae111accdb1ea0a62cc5a8da26a0fa1a530f2ae5d606f903787203da92fd79`; SHA-256 was `ebf15d533353db02227ddbd0ef940cdfa318c7f8d2488197eed45d7bee2e611b`.

`eth_estimateGas` at the fixed block used neutral public sender `0x0000000000000000000000000000000000000001`, zero value, no `to`, and those exact creation bytes. It returned `0x2710a4`, or **2,560,164 gas**. At a 25-gwei maximum fee, that estimate corresponds to **0.0640041 USDC** in Arc's 18-decimal native gas accounting. A proposed 3,000,000-gas transaction limit at the same maximum fee caps the gas charge at **0.075 USDC**. This is a preview from a neutral sender; an authorized sender and current block require a fresh estimate before signing. The prepared transaction uses chain 5042002, value zero, no recipient, this creation data, gas limit 3,000,000, max fee 25 gwei, and max priority fee 25 gwei. Nonce and final signature depend on the approved signer.

## Commands and results

The pinned Arc Foundry binary was `/Users/anishnarang/.local/share/ubc26/sprints/2026-11-15-core/tools/arc-foundry/forge`, commit `3e95efaeaaaca64d6ac9c1ee988968683dbd0d22`; `cast` came from the same directory. The read-only worker ran the following in a temporary contract copy. No command used `--broadcast`:

| Command or RPC operation | Exit | Result |
| --- | --- | --- |
| `SETTLEMENT_EXPECT_FROZEN=1 forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io --fork-block-number 72554683 --fork-retries 1 --compute-units-per-second 30 --non-interactive` | 1 | HTTP 429 during `eth_getLogs` after four code/wiring checks. |
| `forge build --offline` | 0 | Init/runtime and metadata match current source and artifacts. |
| `cast abi-encode 'constructor(address,address,address)' CORE VERIFIER USDC`; `cast keccak INIT_CODE_AND_ARGS` | 0 | 96-byte arguments and creation hash above. |
| `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getStorageAt`, `eth_call`, 17-window `eth_getLogs` replay, `eth_estimateGas` via `curl --retry 0` | 0 | Fixed-block results above; no write RPC. |
| `curl --retry 0 --silent --show-error --fail -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x45318bb",false]}' https://rpc.testnet.arc.io` | 0 | Parent independently confirmed the pinned block hash and 20-gwei base fee. |
| Parent `cast keccak` of compiled init code and constructor args; parent `eth_estimateGas` of the same data at `0x45318bb` | 0 | Independently reproduced the creation hash and `0x2710a4` gas estimate. |

An independent Grok 4.7 High read-only source and ABI audit at commit `3f0ecbf` found no concrete P1 or P2 issue. It ran 48 open-claim Foundry cases offline with zero failures and checked all eight published selectors. Its review was static; it did not establish live deployment or exhaustive security. The pinned native USDC assumption remains material because the core's funding path does not measure a token's actual balance delta.

## Operator gate

No user instruction authorizes a live signer or deployment gas limit. The adapter remains undeployed, so the template's adapter address, transaction hash, block, and runtime hash are JSON null. The precise blocker is an approved Foundry keystore name, its deployer address, and authorization to broadcast the prepared creation with gas limit at most 3,000,000 and max fee at most 25 gwei (maximum 0.075 USDC). Recheck the fixed pins and estimate at a new confirmed block before signing. After confirmation, read the deployed runtime and constructor immutables and record their actual values in a new `deployed-verified` manifest.
