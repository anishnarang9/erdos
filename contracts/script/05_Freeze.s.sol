// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementScript} from "./00_Config.s.sol";

/// @notice Step 5. As the admin from step 3: `setHookWhitelist(hook, true)`, then
///         `renounceRole(ADMIN_ROLE)` and `renounceRole(DEFAULT_ADMIN_ROLE)`. IRREVERSIBLE: after
///         this no one can whitelist hooks, change fees or upgrade the core. Refuses before
///         broadcasting if any address other than the signer holds either role (found by replaying
///         the core's RoleGranted/RoleRevoked events), since renouncing would then not freeze it.
///         Post-conditions: hook whitelisted, NO address holds either role, `getRoleAdmin(ADMIN_ROLE)`
///         is DEFAULT_ADMIN_ROLE, and for the signer and every former holder `setHookWhitelist`,
///         `setPlatformFee`, `setEvaluatorFee` and `upgradeToAndCall` revert with
///         `AccessControlUnauthorizedAccount`. Needs `--rpc-url` on Arc (`eth_getLogs`).
///
///         `SETTLEMENT_WHITELIST_ONLY=1` selects the non-irreversible path: only
///         `setHookWhitelist(hook, true)`, no role is renounced, manifest `frozen` stays false and
///         `status` becomes `whitelisted`. Re-run without the flag later to freeze. The default (flag
///         unset) is the full, irreversible freeze. An env flag on this contract was chosen over a
///         separate wrapper so both paths share one entry point and one command line.
contract Freeze is SettlementScript {
    function run() external {
        _startRoleLogCapture();
        Config memory c = _loadConfig();
        _guardChain(c);
        address core = _manifestAddress(".contracts.core.address");
        address hook = _manifestAddress(".contracts.hook.address");
        if (vm.envOr("SETTLEMENT_WHITELIST_ONLY", false)) _stepWhitelistOnly(core, hook);
        else _stepFreeze(core, hook);
    }
}
