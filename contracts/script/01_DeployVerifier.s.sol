// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementScript} from "./00_Config.s.sol";

/// @notice Step 1. Deploy `RiscZeroGroth16Verifier(CONTROL_ROOT, BN254_CONTROL_ID)` from the
///         vendored v3.1.0 sources. Post-conditions: `SELECTOR() == 0xe71e6620`, `VERSION() == "3.1.0"`.
///         Local mode (`SETTLEMENT_LOCAL=1`) deploys `MockRiscZeroVerifier` instead.
contract DeployVerifier is SettlementScript {
    function run() external returns (address verifier) {
        Config memory c = _loadConfig();
        _guardChain(c);
        verifier = _stepVerifier();
    }
}
