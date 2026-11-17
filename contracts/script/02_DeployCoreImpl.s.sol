// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementScript} from "./00_Config.s.sol";

/// @notice Step 2. Deploy the patched `AgenticCommerce` implementation from
///         `src/core/src/AgenticCommercePatched.sol` (client-only `setBudget`). Never the pristine
///         `AgenticCommerce.sol`. Post-conditions: UUPS implementation, initializers disabled.
contract DeployCoreImpl is SettlementScript {
    function run() external returns (address impl) {
        Config memory c = _loadConfig();
        _guardChain(c);
        impl = _stepCoreImpl();
    }
}
