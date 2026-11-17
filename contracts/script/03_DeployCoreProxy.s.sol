// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementScript} from "./00_Config.s.sol";

/// @notice Step 3. Deploy the ERC1967 proxy over the step-2 implementation, calling
///         `initialize(usdc, treasury, admin)`. The admin is the broadcasting account and holds both
///         admin roles until step 5. The treasury is `SETTLEMENT_TREASURY` or the admin (fees stay
///         zero, so the treasury never receives anything). Post-conditions: implementation slot,
///         fees zero, `paymentToken() == usdc`, roles held by the signer.
contract DeployCoreProxy is SettlementScript {
    function run() external returns (address proxy) {
        Config memory c = _loadConfig();
        _guardChain(c);
        address impl = _manifestAddress(".contracts.coreImplementation.address");
        proxy = _stepCoreProxy(impl, _resolveUsdc(c));
    }
}
