// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementScript} from "./00_Config.s.sol";

/// @notice The whole sequence (USDC if local, verifier, core implementation, proxy, hook, freeze)
///         in one run, including every post-condition.
///
///         Local mode (`SETTLEMENT_LOCAL=1`, anvil chain 31337): deploys `MockUSDC` and
///         `MockRiscZeroVerifier`, and may be broadcast (`--broadcast --unlocked --sender <anvil 0>`).
///         Arc: simulation only. It refuses `--broadcast` on a non-local chain, because the live
///         deployment must go through scripts 01 to 05 one at a time.
///
///         It does not read the manifest between steps. When broadcasting locally it writes
///         `deployments/local.json` (git-ignored) so the Poster and Solver examples can find the addresses.
contract DeployLocal is SettlementScript {
    function run() external returns (Deployment memory d) {
        Config memory c = _loadConfig();
        _guardChain(c);
        if (!_isLocal()) require(!_broadcasting(), "DeployLocal is simulation-only on Arc; run scripts 01 to 05");

        d.usdc = _stepUsdc(c);
        d.verifier = _stepVerifier();
        d.coreImpl = _stepCoreImpl();
        d.core = _stepCoreProxy(d.coreImpl, d.usdc);
        d.hook = _stepHook(c, d.core, d.verifier, d.usdc);
        _stepFreeze(d.core, d.hook);
        vm.startBroadcast();
        d.deployer = _broadcaster();
        vm.stopBroadcast();
    }
}
