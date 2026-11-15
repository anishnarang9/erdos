# Deploy scripts

Spec: SETTLEMENT-IMPLEMENTATION.md Section 8. Run Arc Foundry inside WSL2. Every command below is shown for the `contracts/` directory:

```bash
wsl -e bash -lc "cd '/mnt/c/Users/<you>/Desktop/VS Code Projects/UBC-26/contracts' && <command>"
```

Use `arc-forge` with `--network arc` for acceptance runs (plain `arc-forge test` applies Ethereum rules, research R1).

## Safety rules the scripts enforce

- Each script reads `config/arc-testnet.json` and aborts unless `block.chainid` equals `chainId` (5042002).
- Local mode, `SETTLEMENT_LOCAL=1`, accepts only chain 31337 (anvil). It deploys `MockUSDC` and `MockRiscZeroVerifier` instead of Arc USDC and the Groth16 verifier. On any non-local chain, steps 01, 04 and 06 revert unless the verifier has `SELECTOR() == 0xe71e6620`, `VERSION() == "3.1.0"` and the v3.1.0 `BN254_CONTROL_ID`. A hook frozen on a mock verifier would be permanently exploitable.
- No script handles a private key. The signer comes from `--account <keystore-name>` (a Foundry keystore). Write placeholders in angle brackets as text; never paste a key.
- The manifest `deployments/arc-testnet.json` is written only with `--broadcast`. A step refuses to redeploy when its manifest address already has code, unless `SETTLEMENT_ALLOW_REDEPLOY=1`.
- External calls in broadcast mode become transactions, so each step does its reads before and its post-condition checks after the broadcast. The checks therefore run on simulated state. After every live step, run `06_Verify` to check the real chain.

## Files

| Script | Step |
| --- | --- |
| `00_Config.s.sol` | Shared base: config, chain guard, manifest, all step logic and checks (not run directly) |
| `01_DeployVerifier.s.sol` | Deploy `RiscZeroGroth16Verifier`; checks selector, version |
| `02_DeployCoreImpl.s.sol` | Deploy patched `AgenticCommerce` implementation |
| `03_DeployCoreProxy.s.sol` | ERC1967 proxy, `initialize(usdc, treasury, admin)`; checks slot, zero fees, `paymentToken`, roles |
| `04_DeployHook.s.sol` | `SettlementHook(core, verifier, usdc, maxEnvelopeBytes, minExpiryMargin)`; checks `supportsInterface(0x7ff6bc9e)` |
| `05_Freeze.s.sol` | Default: `setHookWhitelist(hook, true)`, then renounce `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` (irreversible). With `SETTLEMENT_WHITELIST_ONLY=1`: whitelist only, nothing renounced, status `whitelisted` |
| `06_Verify.s.sol` | Read-only check of the live deployment against the manifest |
| `DeployLocal.s.sol` | Whole sequence in one run. Local broadcast on anvil, or a full simulation on Arc (it refuses `--broadcast` on Arc) |
| `export-abi.sh` | Regenerates `../abi/*.json` |

The admin and signer for steps 03 and 05 must be the same account. The treasury is the signer unless `SETTLEMENT_TREASURY=<address>` is set; fees stay zero so it never receives funds.

## Live Arc deployment (Nick)

Fee flags: Arc drops a transaction below 20 gwei `maxFeePerGas` without a receipt, so set both flags to 20 gwei or more. Keep `--slow` so each transaction confirms before the next. Replace `<keystore-name>` with your Foundry keystore (`arc-cast wallet import <keystore-name> --interactive` creates one; type the key into that prompt yourself) and `<deployer-address>` with that keystore's address. `--sender <deployer-address>` is required in addition to `--account`: with `--account` alone Foundry fails with `Error: You seem to be using Foundry's default sender` (hit on step 03). Every live command below uses `$FLAGS`, so the sender is always set.

```bash
FLAGS="--rpc-url https://rpc.testnet.arc.io --account <keystore-name> --sender <deployer-address> --with-gas-price 25gwei --priority-gas-price 25gwei --slow"
```

Dry run each step first (same command without `--broadcast`; steps 01 and 02 simulate standalone, steps 03 to 05 need earlier contracts on chain, so use `DeployLocal` for a whole-sequence simulation on Arc state):

```bash
arc-forge script script/DeployLocal.s.sol:DeployLocal --network arc --rpc-url https://rpc.testnet.arc.io --sender <your-address> --with-gas-price 25gwei
```

Then, in order:

```bash
arc-forge script script/01_DeployVerifier.s.sol:DeployVerifier --network arc $FLAGS --broadcast
arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io

arc-forge script script/02_DeployCoreImpl.s.sol:DeployCoreImpl --network arc $FLAGS --broadcast
arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io

arc-forge script script/03_DeployCoreProxy.s.sol:DeployCoreProxy --network arc $FLAGS --broadcast
arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io

arc-forge script script/04_DeployHook.s.sol:DeployHook --network arc $FLAGS --broadcast
arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io

# Step 05, option A (now): whitelist the hook only. Reversible: no role is renounced, the core is
# NOT frozen, the deployer keeps ADMIN_ROLE and DEFAULT_ADMIN_ROLE. Same account as step 03.
SETTLEMENT_WHITELIST_ONLY=1 arc-forge script script/05_Freeze.s.sol:Freeze --network arc $FLAGS --broadcast
arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io   # prints: ok hook whitelisted (core NOT frozen ...)

# Step 05, option B (later): the full freeze. IRREVERSIBLE. Same account as step 03. Skips the
# whitelist if already set, renounces both roles, runs the freeze checks.
arc-forge script script/05_Freeze.s.sol:Freeze --network arc $FLAGS --broadcast
SETTLEMENT_EXPECT_FROZEN=1 arc-forge script script/06_Verify.s.sol:VerifyDeployment --network arc --rpc-url https://rpc.testnet.arc.io
```

The default of `05_Freeze` (flag unset) is always the full freeze, so only the opt-in flag is safe to type by habit; never run option B by accident. After option A the manifest has `status: "whitelisted"`, `contracts.core.frozen: false`, `contracts.core.hookWhitelisted: true`. Until option B runs, whoever holds the deployer key can change fees, whitelist other hooks and upgrade the core.

Expected after each step (06 prints `ok <name>` lines and reverts with a message on failure):

| After | Post-condition |
| --- | --- |
| 01 | verifier has code; `SELECTOR() == 0xe71e6620`, `VERSION() == "3.1.0"` |
| 02 | implementation has code, `proxiableUUID()` is the ERC1967 slot, bytecode equals the local patched build modulo the UUPS self-address and metadata |
| 03 | proxy implementation slot equals the manifest implementation; both fees 0; `paymentToken()` is Arc USDC; signer holds both admin roles |
| 04 | hook has code; `supportsInterface(0x7ff6bc9e)`; immutables equal manifest and config (`MAX_ENVELOPE_BYTES` 16412, `MIN_EXPIRY_MARGIN` from config) |
| 05 (whitelist-only) | hook whitelisted; zero hook still whitelisted; fees 0; signer STILL holds both roles |
| 05 (full freeze) | hook whitelisted; signer holds neither role; `setHookWhitelist`, `setPlatformFee`, `setEvaluatorFee`, `upgradeToAndCall` revert `AccessControlUnauthorizedAccount` |

**A failed `--broadcast` can still leave a manifest entry.** Forge executes the script (and its manifest writes) during simulation, before any transaction is sent; if the send then fails, the manifest names an address that was never deployed. Handling: `_refuseRedeploy` ignores a manifest address with no code on the current chain, so rerunning the step works; `06_Verify` fails loudly on it (`<name>: manifest address has no code: reset the entry or rerun the step`); and later steps fail the same way via the code check. If the send did not happen, reset the entry (set the address back to `null`, restore `status`) or rerun the step, then commit only a manifest that `06_Verify` accepts. A forge script cannot write the manifest after the broadcast confirms, so this stays a manual check. Use `--resume` to resend stuck transactions.

After the full freeze the script has already set `status` to `frozen`. Commit `deployments/arc-testnet.json` and `broadcast/` receipts for evidence (`broadcast/` is git-ignored; copy what you need). Run `bash script/export-abi.sh` again only if the contracts changed.

## `eth_getLogs`

Arc rejects `eth_getLogs` over a 10,000-block range. Page in windows of at most 10,000 blocks when scanning from the `deployBlock` values in the manifest (the examples do this).

## Local anvil

```bash
arc-anvil --network arc        # chain ID 31337, default dev accounts; leave running
SETTLEMENT_LOCAL=1 arc-forge script script/DeployLocal.s.sol:DeployLocal --network arc \
  --rpc-url http://127.0.0.1:8545 --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --broadcast
```

That anvil account is the well-known public dev account, not a secret. The run writes `deployments/local.json` (git-ignored) with the local addresses, including the mock USDC, which has an open `mint(to, amount)`. Without `--broadcast` the same command is a simulation. `contracts/test/script/Deploy.t.sol` runs every script in-process and asserts all post-conditions: `arc-forge test --network arc --match-path 'test/script/*'`.

## Verifier evidence and test job

Full write-up, with the fork evidence and the commands for the Nov 14 verifier gate: [`../research/ARC-VERIFIER.md`](../research/ARC-VERIFIER.md).

| File | Purpose |
| --- | --- |
| `../test/fork/ArcVerifierFork.t.sol` | Deploys the verifier inside a fork of live Arc and checks the upstream receipt and tampering. Skips unless chain ID is 5042002. `arc-forge test --network arc --fork-url https://rpc.testnet.arc.io --fork-block-number 72389800 --match-path 'test/fork/*' -vv` |
| `verifier-evidence.py` | Read-only evidence for the deployed verifier: chain guard, code equals local build modulo CBOR metadata and the four immutables, getters, real receipt (must verify), eleven altered inputs (must revert), `eth_estimateGas`. Python standard library and JSON-RPC only; it sends no transaction. It was chosen over a Solidity script because it exercises the Arc node's own execution and gas (a forge script would re-run the call in a local simulation) and can print Markdown |
| `08_CreateTestJob.s.sol` | Creates and funds one test job on the deployed core (frozen, or unfrozen with `SETTLEMENT_ALLOW_UNFROZEN=1`) |

After step 01 is broadcast:

```bash
python3 script/verifier-evidence.py --out research/ARC-VERIFIER-LIVE.md   # address from the manifest, or SETTLEMENT_VERIFIER=<addr>
```

The script writes `research/ARC-VERIFIER-LIVE.md` itself (commit it); it does not edit `ARC-VERIFIER.md`.

### Step 08: one funded test job

Run after steps 01 to 05 are live. Normally 06 passes with `SETTLEMENT_EXPECT_FROZEN=1` (full freeze). If you did the whitelist-only step 05, set `SETTLEMENT_ALLOW_UNFROZEN=1`: the hook must still be whitelisted and every other check still applies, but the frozen requirement is waived, a warning is printed and the manifest `testJob` records `"coreFrozen": false`. The signer is the Poster and needs the bounty plus gas in USDC.

```bash
export SETTLEMENT_TEST_PROVIDER=<solver-address>
export SETTLEMENT_TEST_IMAGE_ID=0x<32 bytes>
export SETTLEMENT_TEST_RULES_HASH=0x<32 bytes>
export SETTLEMENT_TEST_REFERENCE_HASH=0x<32 bytes>

# Only after the whitelist-only step 05 (core not frozen):
export SETTLEMENT_ALLOW_UNFROZEN=1

# Dry run first: runs every pre-check and post-check, writes nothing.
arc-forge script script/08_CreateTestJob.s.sol:CreateTestJob --network arc --rpc-url https://rpc.testnet.arc.io --sender <poster-address> --with-gas-price 25gwei

# $FLAGS includes --sender; if the Poster differs from the deployer, use the Poster's keystore and address.
arc-forge script script/08_CreateTestJob.s.sol:CreateTestJob --network arc $FLAGS --broadcast
```

It sends the four Poster transactions in order: `createJob(provider, hook, now + demo.expirySeconds, "UBC-26 settlement test job", hook)`, `setBudget(jobId, demo.bountyUsdc in 6-decimal units, 0x)`, USDC `approve(core, budget)`, `fund(jobId, abi.encode(imageId, rulesHash, referenceHash))`. Pre-checks (before anything is sent): hook whitelisted and the manifest deployer holds no admin role (frozen, unless `SETTLEMENT_ALLOW_UNFROZEN=1`); hook wired to this core and USDC; `demo.expirySeconds >= hook MIN_EXPIRY_MARGIN + coreMinExpirySeconds`; Poster balance covers the bounty; no test job already in the manifest (`SETTLEMENT_ALLOW_NEW_TEST_JOB=1` overrides). Post-checks: job `Funded` with the right client, provider, evaluator, hook, budget and expiry; `hook.terms(jobId)` matches the three inputs and is `funded`; the core's USDC balance rose by the budget.

With `--broadcast` it writes a `testJob` object into `deployments/arc-testnet.json`: `jobId`, `poster`, `provider`, `imageId`, `rulesHash`, `referenceHash`, `budget` (base units, 6 decimals), `expiry`, `context` (`hook.contextOf(jobId)`, 169 bytes), `createdBlock`, `coreFrozen`. Transaction hashes are not known inside a script, so `txHashes` is `null`; take them from `broadcast/08_CreateTestJob.s.sol/5042002/run-latest.json`. The job ID is the core's counter plus one at simulation time; the core is public, so if another job lands first `setBudget` reverts and nothing is funded (re-run). The funded job expires after `demo.expirySeconds`: the Solver must submit and release before then, otherwise anyone may `claimRefund`.

Test: `arc-forge test --network arc --match-path 'test/script/CreateTestJob.t.sol'` runs the script in-process against a local-mode deployment.
