# Local open-claim deployment

2026-11-16 — Anish. These commands use a forkless local Arc node and unlocked Anvil accounts. They do not use a live wallet.

1. Start Arc Anvil on a free loopback port:

   ```sh
   arc-anvil --network arc --chain-id 5042002 --host 127.0.0.1 --port 18545 --accounts 3 --balance 100
   ```

2. From `contracts/`, dry-run and then broadcast the real verifier, patched core, and adapter. Use the first address from the node's `eth_accounts` response as `--sender`. Set `ARC_FORGE` to the Arc Foundry `forge` binary if it is not on `PATH`.

   ```sh
   OPEN_CLAIM_LOCAL=1 arc-forge script script/09_DeployOpenClaimLocal.s.sol:DeployOpenClaimLocal --network arc --rpc-url http://127.0.0.1:18545 --sender <anvil-account> --unlocked
   OPEN_CLAIM_LOCAL=1 arc-forge script script/09_DeployOpenClaimLocal.s.sol:DeployOpenClaimLocal --network arc --rpc-url http://127.0.0.1:18545 --sender <anvil-account> --unlocked --broadcast --slow --gas-price 20000000000 --priority-gas-price 20000000000
   ```

   The script requires the local flag, Arc chain ID, a low local block height, native six-decimal USDC, and no code at the known live core address. It renounces both core admin roles after deployment. It does not touch the live Arc endpoint.

3. Check the six confirmed receipts and current contract state. This writes the ignored `deployments/open-claim-local.json`.

   ```sh
   ARC_CAST=arc-cast python3 script/verify-open-claim-local.py --rpc-url http://127.0.0.1:18545
   ```

The local manifest is runtime evidence for that node only. The testnet template keeps adapter deployment fields null. Run `arc-forge test --match-path 'test/openclaim/*.t.sol'` for the independent adversarial and checked-in real-receipt tests.
