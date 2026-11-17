// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementBase} from "./SettlementBase.t.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";
import {IACPHook} from "../../src/core/src/interfaces/IACPHook.sol";
import {SettlementHook} from "../../src/SettlementHook.sol";
import {ISettlementCore} from "../../src/interfaces/ISettlementCore.sol";
import {IProofVerifier} from "../../src/interfaces/IProofVerifier.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// S13 (admin renounced), plus hook construction, getters and ERC-165.
contract FreezeTest is SettlementBase {
    // ------------------------------------------------------------------ S13

    function test_S13_adminRolesRenounced() public view {
        assertFalse(s.core.hasRole(s.core.ADMIN_ROLE(), admin));
        assertFalse(s.core.hasRole(s.core.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_S13_setHookWhitelistReverts() public {
        address[] memory cs = _privileged();
        address h = address(s.hook);
        for (uint256 i; i < cs.length; i++) {
            vm.expectRevert();
            vm.prank(cs[i]);
            s.core.setHookWhitelist(h, false);
            vm.expectRevert();
            vm.prank(cs[i]);
            s.core.setHookWhitelist(other, true);
        }
        assertTrue(s.core.whitelistedHooks(h), "hook whitelist must persist");
    }

    function test_S13_setFeesRevert() public {
        address[] memory cs = _privileged();
        for (uint256 i; i < cs.length; i++) {
            vm.expectRevert();
            vm.prank(cs[i]);
            s.core.setPlatformFee(100, treasury);
            vm.expectRevert();
            vm.prank(cs[i]);
            s.core.setEvaluatorFee(100);
        }
        assertEq(s.core.platformFeeBP(), 0);
        assertEq(s.core.evaluatorFeeBP(), 0);
    }

    function test_S13_upgradeReverts() public {
        address[] memory cs = _privileged();
        address newImpl = address(new Core());
        for (uint256 i; i < cs.length; i++) {
            vm.expectRevert();
            vm.prank(cs[i]);
            s.core.upgradeToAndCall(newImpl, "");
        }
        // implementation slot unchanged
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        address impl = address(uint160(uint256(vm.load(address(s.core), slot))));
        assertTrue(impl != newImpl, "implementation changed");
    }

    function test_S13_grantRoleReverts() public {
        bytes32 adminRole = s.core.ADMIN_ROLE();
        bytes32 defaultAdmin = s.core.DEFAULT_ADMIN_ROLE();
        address[] memory cs = _privileged();
        for (uint256 i; i < cs.length; i++) {
            vm.expectRevert();
            vm.prank(cs[i]);
            s.core.grantRole(adminRole, cs[i]);
            vm.expectRevert();
            vm.prank(cs[i]);
            s.core.grantRole(defaultAdmin, cs[i]);
        }
    }

    function test_S13_noOtherHookCanBeWhitelistedNorUsed() public {
        // A second hook instance against the same core cannot be used: nobody can whitelist it.
        SettlementHook h2 =
            new SettlementHook(ISettlementCore(address(s.core)), IProofVerifier(address(s.verifier)), s.token, MAX_ENVELOPE, MARGIN);
        address h2a = address(h2);
        vm.expectRevert(Core.HookNotWhitelisted.selector);
        vm.prank(poster);
        s.core.createJob(solver, h2a, EXPIRY, "job", h2a);
    }

    function test_S13_coreCannotBeReinitialized() public {
        vm.expectRevert();
        s.core.initialize(s.token, treasury, other);
    }

    function _privileged() internal view returns (address[] memory cs) {
        cs = new address[](5);
        cs[0] = admin;
        cs[1] = treasury;
        cs[2] = other;
        cs[3] = poster;
        cs[4] = address(s.hook);
    }

    // ------------------------------------------------------------------ construction, getters, ERC-165

    function test_getters() public view {
        assertEq(address(s.hook.core()), address(s.core));
        assertEq(address(s.hook.verifier()), address(s.verifier));
        assertEq(s.hook.usdc(), s.token);
        assertEq(s.hook.MAX_ENVELOPE_BYTES(), MAX_ENVELOPE);
        assertEq(s.hook.MIN_EXPIRY_MARGIN(), MARGIN);
    }

    function test_constructorRejectsPaymentTokenMismatch() public {
        address core_ = address(s.core);
        address ver = address(s.verifier);
        address wrongToken = address(new MockUSDC());
        vm.expectRevert();
        new SettlementHook(ISettlementCore(core_), IProofVerifier(ver), wrongToken, MAX_ENVELOPE, MARGIN);
    }

    function test_erc165() public view {
        assertTrue(s.hook.supportsInterface(type(IACPHook).interfaceId), "IACPHook");
        assertTrue(s.hook.supportsInterface(0x01ffc9a7), "ERC165");
        assertFalse(s.hook.supportsInterface(0xffffffff), "0xffffffff");
        assertFalse(s.hook.supportsInterface(0x12345678), "random");
    }

    function test_hookWhitelistedInCoreAtDeploy() public view {
        assertTrue(s.core.whitelistedHooks(address(s.hook)));
        assertEq(address(s.core.paymentToken()), s.token);
        assertEq(s.core.platformTreasury(), treasury);
    }
}
