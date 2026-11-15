// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HookFixture} from "./HookSmoke.t.sol";
import {AgenticCommerce} from "../../src/core/src/AgenticCommercePatched.sol";
import {SettlementHook} from "../../src/SettlementHook.sol";
import {SettlementCodec} from "../../src/SettlementCodec.sol";
import {ISettlementCore} from "../../src/interfaces/ISettlementCore.sol";
import {IProofVerifier} from "../../src/interfaces/IProofVerifier.sol";
import {RiscZeroGroth16Verifier} from "../../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {ControlID} from "../../src/verifier/groth16/ControlID.sol";
import {TestReceipt} from "../verifier/TestReceiptV3_1.sol";

/// @notice Edge cases raised by the Review track (2026-11-14) that the S-matrix did not cover.
contract HookEdgeCasesTest is HookFixture {
    // ── fund optParams must be exactly abi.encode(bytes32, bytes32, bytes32) ──

    function _openJob() internal returns (uint256 jobId) {
        vm.startPrank(poster);
        jobId = core.createJob(solver, address(hook), block.timestamp + 1 hours, "job", address(hook));
        core.setBudget(jobId, 1e6, "");
        usdc.approve(address(core), 1e6);
        vm.stopPrank();
    }

    function test_fundOptParamsShortReverts() public {
        uint256 jobId = _openJob();
        bytes memory p = abi.encode(IMAGE_ID, RULES, REF);
        assembly { mstore(p, 95) }
        vm.prank(poster);
        vm.expectRevert(SettlementHook.BadFundParams.selector);
        core.fund(jobId, p);
    }

    function test_fundOptParamsLongReverts() public {
        uint256 jobId = _openJob();
        vm.prank(poster);
        vm.expectRevert(SettlementHook.BadFundParams.selector);
        core.fund(jobId, abi.encodePacked(abi.encode(IMAGE_ID, RULES, REF), bytes1(0)));
    }

    function test_fundHugeExpiryReverts() public {
        vm.startPrank(poster);
        uint256 jobId = core.createJob(solver, address(hook), uint256(type(uint64).max) + 1, "job", address(hook));
        core.setBudget(jobId, 1e6, "");
        usdc.approve(address(core), 1e6);
        vm.expectRevert(SettlementHook.ExpiryOverflow.selector);
        core.fund(jobId, abi.encode(IMAGE_ID, RULES, REF));
        vm.stopPrank();
    }

    // ── Jobs the hook never saw ──

    /// A job with evaluator = hook but hook = 0 never reaches the hook, so it can never be
    /// released. It stays refundable after expiry (Review finding 2).
    function test_hooklessJobWithHookEvaluatorIsRefundableOnly() public {
        vm.startPrank(poster);
        uint256 expiry = block.timestamp + 1 hours;
        uint256 jobId = core.createJob(solver, address(hook), expiry, "job", address(0));
        core.setBudget(jobId, 1e6, "");
        usdc.approve(address(core), 1e6);
        core.fund(jobId, abi.encode(IMAGE_ID, RULES, REF));
        vm.stopPrank();

        (,,,,,, bool funded) = hook.terms(jobId);
        assertFalse(funded);
        vm.prank(solver);
        core.submit(jobId, bytes32(0), "");
        vm.prank(solver);
        vm.expectRevert(SettlementHook.NotProvider.selector);
        hook.release(jobId, KEY);

        vm.warp(expiry);
        core.claimRefund(jobId);
        assertEq(usdc.balanceOf(poster), 10e6);
    }

    /// Documents Review finding 1: the frozen core still allows hook = 0, and such a job is not
    /// protected by any SettlementHook rule. Solvers must check job.hook and job.evaluator.
    function test_hooklessJobGivesSolverNoProtection() public {
        vm.startPrank(poster);
        uint256 jobId = core.createJob(solver, poster, block.timestamp + 1 hours, "job", address(0));
        core.setBudget(jobId, 1e6, "");
        usdc.approve(address(core), 1e6);
        core.fund(jobId, "");
        vm.stopPrank();
        vm.prank(solver);
        core.submit(jobId, bytes32(uint256(1)), "");
        vm.prank(poster);
        core.reject(jobId, bytes32(0), "");
        assertEq(usdc.balanceOf(solver), 0);
        assertEq(usdc.balanceOf(poster), 10e6);
    }

    // ── The real Groth16 verifier wired into the hook ──

    function _realStack() internal returns (AgenticCommerce c, SettlementHook h) {
        RiscZeroGroth16Verifier real = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID);
        c = core;
        // A second hook on the same core, whitelisting impossible after freeze, so build a fresh stack.
        AgenticCommerce impl = new AgenticCommerce();
        c = AgenticCommerce(
            address(
                new ERC1967ProxyShim(
                    address(impl), abi.encodeCall(AgenticCommerce.initialize, (address(usdc), admin, admin))
                )
            )
        );
        h = new SettlementHook(ISettlementCore(address(c)), IProofVerifier(address(real)), address(usdc), MAX_ENVELOPE, 120);
        vm.prank(admin);
        c.setHookWhitelist(address(h), true);
    }

    /// The upstream receipt is genuine for its own journal, so funding a job with its image ID and
    /// submitting its seal must still fail: the hook rebuilds our journal, which differs.
    function test_realVerifierRejectsForeignGenuineReceipt() public {
        (AgenticCommerce c, SettlementHook h) = _realStack();
        vm.startPrank(poster);
        uint256 jobId = c.createJob(solver, address(h), block.timestamp + 1 hours, "job", address(h));
        c.setBudget(jobId, 1e6, "");
        usdc.approve(address(c), 1e6);
        c.fund(jobId, abi.encode(TestReceipt.IMAGE_ID, RULES, REF));
        vm.stopPrank();

        bytes memory envelope = hex"00";
        bytes32 kc = SettlementCodec.keyCommitment(h.contextOf(jobId), KEY);
        bytes32 envHash = sha256(envelope);
        bytes memory opt = abi.encode(envelope, TestReceipt.SEAL, kc);
        vm.prank(solver);
        vm.expectRevert();
        c.submit{gas: 5_000_000}(jobId, envHash, opt);
        assertEq(uint8(c.getJob(jobId).status), uint8(AgenticCommerce.JobStatus.Funded));
    }

    function test_realVerifierRejectsGarbageSeal() public {
        (AgenticCommerce c, SettlementHook h) = _realStack();
        vm.startPrank(poster);
        uint256 jobId = c.createJob(solver, address(h), block.timestamp + 1 hours, "job", address(h));
        c.setBudget(jobId, 1e6, "");
        usdc.approve(address(c), 1e6);
        c.fund(jobId, abi.encode(TestReceipt.IMAGE_ID, RULES, REF));
        vm.stopPrank();

        bytes memory seal = TestReceipt.SEAL;
        seal[100] ^= 0x01;
        bytes memory envelope = hex"00";
        bytes32 envHash = sha256(envelope);
        bytes memory opt = abi.encode(envelope, seal, bytes32(0));
        vm.prank(solver);
        vm.expectRevert();
        c.submit{gas: 5_000_000}(jobId, envHash, opt);
        assertEq(uint8(c.getJob(jobId).status), uint8(AgenticCommerce.JobStatus.Funded));
    }
}

import {ERC1967Proxy as ERC1967ProxyShim} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
