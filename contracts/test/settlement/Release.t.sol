// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementBase, IToken} from "./SettlementBase.t.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";
import {MockRiscZeroVerifier} from "../../src/verifier/MockRiscZeroVerifier.sol";
import {BlocklistUSDC} from "../mocks/BlocklistUSDC.sol";

/// S9, S11, S12 (payout) and the hard rules (no reject escape hatch, only the hook completes).
contract ReleaseTest is SettlementBase {
    // ------------------------------------------------------------------ happy path and S12 payout

    function test_S12_payoutExactDeltas() public {
        (uint256 id, bytes memory env, bytes32 kc) = _submittedJob();
        Bal memory before_ = _snap(s);
        assertEq(before_.poster, POSTER_FUNDS - BUDGET);
        assertEq(before_.core, BUDGET);
        assertEq(before_.solver, 0);

        vm.expectEmit(true, true, false, true, address(s.hook));
        emit KeyReleased(id, solver, KEY, sha256(env));
        _release(s, id, KEY);

        Bal memory after_ = _snap(s);
        assertEq(after_.solver, before_.solver + BUDGET, "solver delta");
        assertEq(after_.core, before_.core - BUDGET, "core delta");
        assertEq(after_.core, 0, "core drained");
        assertEq(after_.poster, before_.poster, "poster unchanged");
        assertEq(after_.hook, 0, "hook holds nothing");
        assertEq(after_.treasury, 0, "no fees");
        assertEq(after_.other, 0);
        assertEq(_status(s, id), COMPLETED);
        assertTrue(s.hook.released(id));
        (bytes32 eh, bytes32 skc, bool acc) = s.hook.submissions(id);
        assertEq(eh, sha256(env));
        assertEq(skc, kc);
        assertTrue(acc);
    }

    function test_S12_payoutEvents() public {
        (uint256 id,, bytes32 kc) = _submittedJob();
        vm.expectEmit(true, true, false, true, address(s.core));
        emit JobCompleted(id, address(s.hook), kc);
        vm.expectEmit(true, true, false, true, address(s.core));
        emit PaymentReleased(id, solver, BUDGET);
        _release(s, id, KEY);
    }

    function test_S12_feesAreZero() public view {
        assertEq(s.core.platformFeeBP(), 0);
        assertEq(s.core.evaluatorFeeBP(), 0);
    }

    // ------------------------------------------------------------------ S9

    function test_S9_wrongKeyReverts() public {
        (uint256 id,,) = _submittedJob();
        Bal memory b = _snap(s);
        _releaseExpectRevert(s, id, solver, KEY_B);
        _releaseExpectRevert(s, id, solver, bytes32(0));
        _releaseExpectRevert(s, id, solver, bytes32(uint256(KEY) ^ 1));
        _assertSame(b, _snap(s));
        assertFalse(s.hook.released(id));
        assertEq(_status(s, id), SUBMITTED);
        // the right key still works afterwards
        _release(s, id, KEY);
        assertEq(_status(s, id), COMPLETED);
    }

    function test_S9_earlyReleaseBeforeSubmissionReverts() public {
        uint256 id = _fundedJob();
        Bal memory b = _snap(s);
        _releaseExpectRevert(s, id, solver, KEY);
        _assertSame(b, _snap(s));
        _assertFundedNotSubmitted(s, id);
    }

    function test_S9_releaseUnknownOrUnfundedJobReverts() public {
        _releaseExpectRevert(s, 12345, solver, KEY);
        uint256 id = _createJob(s, solver, EXPIRY);
        _releaseExpectRevert(s, id, solver, KEY);
    }

    function test_S9_nonSolverReleaseReverts() public {
        (uint256 id,,) = _submittedJob();
        Bal memory b = _snap(s);
        address[] memory cs = new address[](5);
        cs[0] = other;
        cs[1] = poster;
        cs[2] = solver2;
        cs[3] = admin;
        cs[4] = treasury;
        for (uint256 i; i < cs.length; i++) {
            // even with the correct key (which is public once released, and known to the Solver only before)
            _releaseExpectRevert(s, id, cs[i], KEY);
        }
        _assertSame(b, _snap(s));
        assertFalse(s.hook.released(id));
        assertEq(_status(s, id), SUBMITTED);
    }

    function test_S9_duplicateReleaseReverts() public {
        (uint256 id,,) = _submittedJob();
        _release(s, id, KEY);
        Bal memory b = _snap(s);
        _releaseExpectRevert(s, id, solver, KEY);
        _assertSame(b, _snap(s));
        assertTrue(s.hook.released(id));
        assertEq(_status(s, id), COMPLETED);
        assertEq(b.solver, BUDGET, "paid exactly once");
    }

    function test_S9_releaseDoesNotCrossJobs() public {
        (uint256 id1,,) = _submittedJob();
        uint256 id2 = _fundedJob();
        // job 2 has no accepted submission; job 1's key must not release it
        _releaseExpectRevert(s, id2, solver, KEY);
        _assertFundedNotSubmitted(s, id2);
        _release(s, id1, KEY);
        assertFalse(s.hook.released(id2));
    }

    // ------------------------------------------------------------------ S11 reverting payout

    function test_S11_blocklistedSolverReleaseRevertsStateUnchanged() public {
        BlocklistUSDC bl = new BlocklistUSDC();
        Stack memory k = _deployStack(address(bl), address(new MockRiscZeroVerifier()));
        uint256 id = _createAndFund(k, solver, BUDGET, EXPIRY);
        bytes memory env = _envelope(256);
        (bytes memory seal, bytes32 kc) = _proof(k, id, env, KEY);
        _submit(k, id, env, seal, kc);

        bl.setBlocked(solver, true);
        Bal memory b = _snap(k);
        _releaseExpectRevert(k, id, solver, KEY);

        assertFalse(k.hook.released(id), "released flag leaked");
        assertEq(_status(k, id), SUBMITTED, "status changed");
        _assertSame(b, _snap(k));
        assertEq(_bal(k, address(k.core)), BUDGET);
        (,, bool acc) = k.hook.submissions(id);
        assertTrue(acc, "submission lost");

        // Unblocked, the same release succeeds: no stuck in-progress flag, nothing half-applied.
        bl.setBlocked(solver, false);
        _release(k, id, KEY);
        assertEq(_bal(k, solver), BUDGET);
        assertTrue(k.hook.released(id));
        assertEq(_status(k, id), COMPLETED);
    }

    function test_S11_blockedSolverCanBeRefundedAfterExpiry() public {
        // A blocked payee must not trap the Poster's funds forever.
        BlocklistUSDC bl = new BlocklistUSDC();
        Stack memory k = _deployStack(address(bl), address(new MockRiscZeroVerifier()));
        uint256 id = _createAndFund(k, solver, BUDGET, EXPIRY);
        bytes memory env = _envelope(256);
        (bytes memory seal, bytes32 kc) = _proof(k, id, env, KEY);
        _submit(k, id, env, seal, kc);
        bl.setBlocked(solver, true);
        _releaseExpectRevert(k, id, solver, KEY);
        vm.warp(EXPIRY);
        k.core.claimRefund(id);
        assertEq(_bal(k, poster), POSTER_FUNDS);
        assertEq(_status(k, id), EXPIRED);
    }

    // ------------------------------------------------------------------ hard rules

    function test_Hard_posterCannotRejectFunded() public {
        uint256 id = _fundedJob();
        Bal memory b = _snap(s);
        vm.expectRevert(Core.Unauthorized.selector);
        vm.prank(poster);
        s.core.reject(id, bytes32(0), "");
        _assertSame(b, _snap(s));
        assertEq(_status(s, id), FUNDED);
    }

    function test_Hard_posterCannotRejectSubmitted() public {
        (uint256 id,,) = _submittedJob();
        Bal memory b = _snap(s);
        vm.expectRevert(Core.Unauthorized.selector);
        vm.prank(poster);
        s.core.reject(id, bytes32(0), "");
        _assertSame(b, _snap(s));
        assertEq(_status(s, id), SUBMITTED);
    }

    function test_Hard_nobodyElseCanRejectFundedOrSubmitted() public {
        uint256 funded = _fundedJob();
        (uint256 submitted,,) = _submittedJob();
        address[] memory cs = new address[](5);
        cs[0] = other;
        cs[1] = solver;
        cs[2] = solver2;
        cs[3] = admin;
        cs[4] = treasury;
        for (uint256 i; i < cs.length; i++) {
            vm.expectRevert(Core.Unauthorized.selector);
            vm.prank(cs[i]);
            s.core.reject(funded, bytes32(0), "");
            vm.expectRevert(Core.Unauthorized.selector);
            vm.prank(cs[i]);
            s.core.reject(submitted, bytes32(0), "");
        }
        assertEq(_status(s, funded), FUNDED);
        assertEq(_status(s, submitted), SUBMITTED);
    }

    function test_Hard_evaluatorHasNoRejectEntryPoint() public {
        // The evaluator is the hook. It exposes no reject (or complete) function an outsider could use.
        (uint256 id,,) = _submittedJob();
        address h = address(s.hook);
        (bool ok1,) = h.call(abi.encodeWithSignature("reject(uint256,bytes32,bytes)", id, bytes32(0), bytes("")));
        assertFalse(ok1, "hook exposes reject");
        (bool ok2,) = h.call(abi.encodeWithSignature("complete(uint256,bytes32,bytes)", id, bytes32(0), bytes("")));
        assertFalse(ok2, "hook exposes complete");
        vm.prank(poster);
        (bool ok3,) = h.call(abi.encodeWithSignature("reject(uint256,bytes32,bytes)", id, bytes32(0), bytes("")));
        assertFalse(ok3, "hook exposes reject to poster");
        assertEq(_status(s, id), SUBMITTED);
    }

    function test_Hard_onlyHookCanComplete() public {
        (uint256 id,, bytes32 kc) = _submittedJob();
        Bal memory b = _snap(s);
        address[] memory cs = new address[](5);
        cs[0] = poster;
        cs[1] = solver;
        cs[2] = other;
        cs[3] = admin;
        cs[4] = treasury;
        for (uint256 i; i < cs.length; i++) {
            vm.expectRevert(Core.Unauthorized.selector);
            vm.prank(cs[i]);
            s.core.complete(id, kc, "");
        }
        _assertSame(b, _snap(s));
        assertEq(_status(s, id), SUBMITTED);
    }

    function test_Hard_completeWithoutReleaseRevertsEvenFromHookAddress() public {
        // Simulates the hook address calling core.complete outside `release`: the hook's own
        // beforeAction(complete) must refuse because no release is in progress.
        (uint256 id,, bytes32 kc) = _submittedJob();
        Bal memory b = _snap(s);
        vm.expectRevert();
        vm.prank(address(s.hook));
        s.core.complete(id, kc, "");
        _assertSame(b, _snap(s));
        assertEq(_status(s, id), SUBMITTED);
        assertFalse(s.hook.released(id));
    }

    function test_Hard_completeViaCoreBeforeActionDirectReverts() public {
        // Impersonating the core on the hook callback without a release in progress.
        (uint256 id,, bytes32 kc) = _submittedJob();
        bytes memory d = abi.encode(address(s.hook), kc, bytes(""));
        bytes4 sel = Core.complete.selector;
        vm.expectRevert();
        vm.prank(address(s.core));
        s.hook.beforeAction(id, sel, d);
    }

    function test_Hard_claimRefundIsPermissionless() public {
        uint256 id = _fundedJob();
        vm.warp(EXPIRY);
        vm.prank(other);
        s.core.claimRefund(id);
        assertEq(_status(s, id), EXPIRED);
        assertEq(_bal(s, poster), POSTER_FUNDS);
    }
}
