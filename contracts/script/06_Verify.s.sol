// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {SettlementScript} from "./00_Config.s.sol";
import {AgenticCommerce} from "../src/core/src/AgenticCommercePatched.sol";
import {RiscZeroGroth16Verifier} from "../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {SettlementHook} from "../src/SettlementHook.sol";

/// @notice Read-only check of the live deployment against the manifest. Never broadcasts; run it
///         with `--rpc-url` and no signer after each live step.
///
///         Checks every manifest entry that is non-null. Set `SETTLEMENT_EXPECT_FROZEN=1` after step 5
///         to also require the freeze post-conditions (the deployer address comes from the manifest).
///         Reverts with a message on the first failed check.
contract VerifyDeployment is SettlementScript {
    function run() external {
        Config memory c = _loadConfig();
        _guardChain(c);
        address usdc = _resolveUsdc(c);
        address verifier = _manifestAddress(".contracts.verifier.address");
        address impl = _manifestAddress(".contracts.coreImplementation.address");
        address core = _manifestAddress(".contracts.core.address");
        address hook = _manifestAddress(".contracts.hook.address");
        address deployer = _manifestAddress(".deployer");

        require(usdc.code.length != 0, "USDC has no code");

        if (verifier != address(0)) {
            _requireCode("verifier", verifier);
            if (!_isLocal()) {
                RiscZeroGroth16Verifier v = RiscZeroGroth16Verifier(verifier);
                require(v.SELECTOR() == RISC0_V3_1_SELECTOR, "verifier SELECTOR");
                require(keccak256(bytes(v.VERSION())) == keccak256("3.1.0"), "verifier VERSION");
            }
            console.log("ok verifier", verifier);
        }
        if (impl != address(0)) {
            _requireCode("core implementation", impl);
            require(AgenticCommerce(impl).proxiableUUID() == ERC1967_IMPLEMENTATION_SLOT, "impl not UUPS");
            require(_implementationMatchesLocalBuild(impl), "implementation bytecode != local patched build");
            console.log("ok core implementation", impl);
        }
        if (core != address(0)) {
            _requireCode("core proxy", core);
            AgenticCommerce k = AgenticCommerce(core);
            require(
                address(uint160(uint256(vm.load(core, ERC1967_IMPLEMENTATION_SLOT)))) == impl,
                "proxy implementation slot"
            );
            require(address(k.paymentToken()) == usdc, "paymentToken");
            require(k.platformFeeBP() == 0 && k.evaluatorFeeBP() == 0, "fees not zero");
            console.log("ok core proxy", core);
        }
        if (hook != address(0)) {
            _requireCode("hook", hook);
            SettlementHook h = SettlementHook(hook);
            require(h.supportsInterface(IACP_HOOK_ID), "hook ERC-165");
            require(
                address(h.core()) == core && address(h.verifier()) == verifier && h.usdc() == usdc,
                "hook immutables"
            );
            require(h.MAX_ENVELOPE_BYTES() == c.maxEnvelopeBytes, "MAX_ENVELOPE_BYTES");
            require(h.MIN_EXPIRY_MARGIN() == c.minExpiryMargin, "MIN_EXPIRY_MARGIN");
            console.log("ok hook", hook);
        }
        if (vm.envOr("SETTLEMENT_EXPECT_FROZEN", false)) {
            require(
                core != address(0) && hook != address(0) && deployer != address(0),
                "manifest incomplete for freeze check"
            );
            _checkFrozen(core, hook, deployer);
            console.log("ok frozen");
        }
    }
}
