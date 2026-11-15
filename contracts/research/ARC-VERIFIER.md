# ARC-VERIFIER: pinned RISC Zero verifier on Arc Testnet

Gate: SETTLEMENT-IMPLEMENTATION.md Section 11, Nov 14: "Nick deploys the pinned verifier on Arc. Upstream receipt verifies on Arc and tampering fails. Gas recorded."

Status: **fork evidence captured; live deployment NOT done.** Nothing in this file is a transaction on Arc. The live deployment needs Nick's keystore, and the sections below say exactly what to run.

Verifier: `RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID)` from `risc0-ethereum` v3.1.0 (`ff30da77ba4afdd496290ebebedb205348b15d83`), vendored in `contracts/src/verifier/groth16/`. Control root `0xe6feef13db7aed4a731c7b0852de1f5c89b137726073f625d05333184d3a551d`, BN254 control ID `0x0ac2eaf9d5ae64ffb75c4747fde32456e9ee6db3b32350cb2a0614ba91d081de`. Receipt: upstream `TestReceiptV3_1` (image ID `0xc92414d80cdeb43ba0f4ff4882447c21f18b547d41ffa506a84da164e8e31f7d`, journal ASCII `just a simple receipt`, 260-byte seal).

## 1. Fork evidence (fork of live Arc state, not a deployed contract)

`contracts/test/fork/ArcVerifierFork.t.sol` deploys the verifier **inside a fork** of Arc Testnet (the contract exists only in the test's local EVM, nothing is sent to Arc) and calls it there. The fork serves real Arc state and the BN254 (`0x06`, `0x07`, `0x08`) and `sha256` (`0x02`) precompiles execute under Arc rules. The test skips itself unless the chain ID is 5042002, so the plain local suite stays green (it reports 1 skipped).

Command (run in WSL from `contracts/`; run on 2026-11-14):

```bash
arc-forge test --network arc --fork-url https://rpc.testnet.arc.io --fork-block-number 72389800 \
  --match-path 'test/fork/*' -vv
```

Fork block 72389800, hash `0x816733e67ce4b87711a2ca7bcc015757203a7ec89428b2ee391d3b092a093ba1`, timestamp 1794716537, chain ID 5042002 (the chain head was 72389865 when it ran). Result: `7 passed; 0 failed; 0 skipped`.

| # | Case | Expected | Result | Gas |
| --- | --- | --- | --- | --- |
| 1 | `SELECTOR()` | `0xe71e6620` | PASS | |
| 2 | `VERSION()` | `"3.1.0"` | PASS | |
| 3 | `BN254_CONTROL_ID()`, seal length 260, receipt selector equals `SELECTOR()` | match | PASS | |
| 4 | `verify(SEAL, IMAGE_ID, sha256(JOURNAL))` | succeeds | PASS | 242,661 (external call, includes call overhead) |
| 5 | Flipped journal byte, every one of the 21 positions, digest recomputed | `VerificationFailed()` | PASS | cheap |
| 6 | Changed image ID (low bit) | `VerificationFailed()` | PASS | cheap |
| 7 | Flipped proof byte at offsets 4, 36, 132 and 259, `{gas: 3_000_000}` cap | `VerificationFailed()` | PASS | 2,923,811 / 2,912,313 / 2,912,315 / 2,912,317 of the 3,000,000 cap |
| 8 | Changed selector byte, each of the 4 bytes | `SelectorMismatch(bytes4,bytes4)` with the mutated and expected selectors | PASS | cheap |

Notes.

- A tampered proof point is off the curve, so a BN254 precompile call fails and burns all the gas forwarded to it. The verifier still reverts with `VerificationFailed()`, but only after using nearly the whole cap (row 7). Always send an explicit gas limit for a `submit` whose seal might be bad, and expect `eth_estimateGas` to fail on it.
- The 242,661 figure is the gas the fork's EVM charged. It matches the local `arc-forge` run (242,548, `research/R3.md`), so it does not by itself prove Arc's on-chain gas schedule. The authoritative number is the live `eth_estimateGas` the evidence script records after deployment (Section 2).
- Cases 1 to 8 also run locally without a fork in `test/verifier/Groth16Verifier.t.sol` (S16).

### Evidence script tested end to end on a local fork

`script/verifier-evidence.py` was run against a local `arc-anvil --fork-url https://rpc.testnet.arc.io` (chain ID 5042002, block 72389997), with the verifier deployed to that local node by a local dev-account transaction. All 19 checks passed (code matches the local build, getters, valid receipt, 3 journal, 1 image ID, 3 proof and 4 selector tampering cases, `eth_estimateGas` 267,355 including the 21,000 base cost and calldata). Pointed at the wrong contract (USDC, Circle's core) it fails with exit status 1. This is a test of the script, not evidence about Arc.

## 2. Live deployment (Nick runs this)

Nothing below has been run. Placeholders in angle brackets are yours to fill. Never paste a private key anywhere: the signer is a Foundry keystore (`arc-cast wallet import <keystore-name> --interactive` creates one and you type the key into that prompt yourself). The account needs USDC for gas; deployment costs about 1.8M gas, roughly 0.045 USDC at 25 gwei (estimate from a local fork).

Run inside WSL, from the repo's `contracts/` directory:

```bash
export PATH=/root/.local/bin:$PATH
cd "/mnt/c/Users/<you>/Desktop/VS Code Projects/UBC-26/contracts"
RPC=https://rpc.testnet.arc.io

# 0. Optional dry run (no --broadcast, writes nothing). Expect "verifier 0x..." and no revert.
arc-forge script script/01_DeployVerifier.s.sol:DeployVerifier --network arc --rpc-url $RPC \
  --sender <your-address> --with-gas-price 25gwei

# 1. Deploy the verifier (step 01). Arc drops any transaction below 20 gwei, hence 25 gwei.
arc-forge script script/01_DeployVerifier.s.sol:DeployVerifier --network arc --rpc-url $RPC \
  --account <keystore-name> --with-gas-price 25gwei --priority-gas-price 25gwei --slow --broadcast
```

Expected from step 1: a log line `verifier 0x<address>`, one transaction `status 1` in the forge output, and `deployments/arc-testnet.json` updated (`contracts.verifier.address`, `deployer`, `deployBlock`, `status` `partial`). The script already checked `SELECTOR()`, `VERSION()` and `BN254_CONTROL_ID()` on its simulated deployment. The signed transaction receipt is in `broadcast/01_DeployVerifier.s.sol/5042002/run-latest.json`.

Then capture the evidence, read-only and with no signer:

```bash
# 2. Check the live chain against the manifest (prints "ok verifier 0x...").
arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url $RPC

# 3. Evidence block: reads the address from deployments/arc-testnet.json, or SETTLEMENT_VERIFIER=<addr>.
python3 script/verifier-evidence.py --out research/ARC-VERIFIER-LIVE.md
```

Expected from step 3: a Markdown block on stdout, also written to `research/ARC-VERIFIER-LIVE.md`, headed `Verdict: ALL CHECKS PASSED`, with 20 rows (19 without a manifest `bn254ControlId`) all `PASS` and exit status 0. Any `FAIL` row makes the exit status 1. What the script does:

- aborts unless `eth_chainId` is 5042002;
- requires code at the address and compares it with the local build (`out/RiscZeroGroth16Verifier.sol/RiscZeroGroth16Verifier.json`) modulo the trailing CBOR metadata and the four immutable slots. The control root halves, BN254 control ID and selector are immutables, so they live in the runtime code and a byte comparison with the artifact cannot match unmasked. Masking them and then reading each through its public getter (compared with `ControlID.sol` and the manifest) checks the same thing;
- `eth_call`s `verify` with the real receipt (must succeed) and with each altered input (journal bytes 0, 10 and 20, image ID, proof bytes 4, 132 and 259 under a 3,000,000 gas cap, each of the 4 selector bytes), which must revert with `VerificationFailed()` or `SelectorMismatch`;
- records `eth_estimateGas` for the valid call, the block number and hash, the explorer link `https://explorer.testnet.arc.io/address/<address>` and the deploy transaction hash (from the manifest if present, otherwise from the `broadcast/` receipt).

Every call runs at one pinned block so the evidence is internally consistent. The script sends no transaction, and needs only Python 3 with the standard library, so it also runs on Windows Python. Run `arc-forge build --network arc` first if `out/` is missing.

**Where the evidence lands.** The script writes `research/ARC-VERIFIER-LIVE.md`; it does not edit this file. After it runs, commit that file (and `deployments/arc-testnet.json`), then share the address and that file. Fill the table below from it.

| Field | Value |
| --- | --- |
| Verifier address | `<0x... from the step 1 log>` |
| Explorer | `https://explorer.testnet.arc.io/address/<0x...>` |
| Deploy transaction | `<0x... from broadcast/01_DeployVerifier.s.sol/5042002/run-latest.json>` |
| Deploy block | `<number from the manifest>` |
| Evidence block | `<number from ARC-VERIFIER-LIVE.md>` |
| Valid receipt on Arc | `<PASS or FAIL>` |
| Tampering cases reverting | `<n of 11>` |
| `eth_estimateGas`, valid verify | `<gas>` |

## 3. Next handoff: one funded test job

Not part of tonight's gate. After steps 02 to 05 (core, hook, freeze) are live, `script/08_CreateTestJob.s.sol` creates and funds one test job. See `script/README.md` ("Verifier evidence and test job"). The Nov 16 gate evidence needs it.
