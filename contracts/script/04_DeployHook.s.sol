// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementScript} from "./00_Config.s.sol";

/// @notice Step 4. Deploy `SettlementHook(core, verifier, usdc, maxEnvelopeBytes, minExpiryMargin)`
///         with the last two taken from `config/arc-testnet.json`. Post-conditions:
///         `supportsInterface(0x7ff6bc9e)` and every immutable equal to its input.
contract DeployHook is SettlementScript {
    function run() external returns (address hook) {
        Config memory c = _loadConfig();
        _guardChain(c);
        hook = _stepHook(
            c,
            _manifestAddress(".contracts.core.address"),
            _manifestAddress(".contracts.verifier.address"),
            _resolveUsdc(c)
        );
    }
}
