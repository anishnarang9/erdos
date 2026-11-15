// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementScript} from "./00_Config.s.sol";

/// @notice Step 5. As the admin from step 3: `setHookWhitelist(hook, true)`, then
///         `renounceRole(ADMIN_ROLE)` and `renounceRole(DEFAULT_ADMIN_ROLE)`. IRREVERSIBLE: after
///         this no one can whitelist hooks, change fees or upgrade the core. Post-conditions: hook
///         whitelisted, the signer holds neither role, and `setHookWhitelist`, `setPlatformFee`,
///         `setEvaluatorFee` and `upgradeToAndCall` revert with `AccessControlUnauthorizedAccount`.
contract Freeze is SettlementScript {
    function run() external {
        Config memory c = _loadConfig();
        _guardChain(c);
        _stepFreeze(_manifestAddress(".contracts.core.address"), _manifestAddress(".contracts.hook.address"));
    }
}
