// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementBase} from "./SettlementBase.t.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";

/// S10 (expiry boundaries) and S12 (refund deltas).
/// Rule: submit and release need block.timestamp < expiry. claimRefund needs block.timestamp >= expiry.
contract ExpiryTest is SettlementBase {
    // ------------------------------------------------------------------ expiry before submission

    function test_S10_expiryBeforeSubmission_exactSecond() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);

        // One second before expiry: refund is not yet possible.
        vm.warp(EXPIRY - 1);
        vm.expectRevert(Core.WrongStatus.selector);
        vm.prank(other);
        s.core.claimRefund(id);

        // At exactly the expiry second: submit reverts, refund works.
        vm.warp(EXPIRY);
        _submitExpectRevert(s, id, env, seal, kc);
        _assertFundedNotSubmitted(s, id);

        Bal memory b = _snap(s);
        vm.expectEmit(true, true, false, true, address(s.core));
        emit Refunded(id, poster, BUDGET);
        vm.expectEmit(true, false, false, true, address(s.core));
        emit JobExpired(id);
        vm.prank(other);
        s.core.claimRefund(id);

        assertEq(_status(s, id), EXPIRED);
        assertEq(_bal(s, poster), b.poster + BUDGET, "poster refunded");
        assertEq(_bal(s, address(s.core)), 0, "core drained");
        assertEq(_bal(s, solver), 0);
    }

    function test_S10_afterExpiryEverythingStaysClosed() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        vm.warp(EXPIRY + 1 days);
        _submitExpectRevert(s, id, env, seal, kc);
        _releaseExpectRevert(s, id, solver, KEY);
        vm.prank(poster);
        s.core.claimRefund(id);
        // after the refund nothing can move money again
        _submitExpectRevert(s, id, env, seal, kc);
        _releaseExpectRevert(s, id, solver, KEY);
        vm.expectRevert(Core.WrongStatus.selector);
        s.core.claimRefund(id);
        assertEq(_bal(s, poster), POSTER_FUNDS);
        assertEq(_bal(s, solver), 0);
    }

    function test_S10_lastSecondSubmitWorks() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(512);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        vm.warp(EXPIRY - 1);
        _submit(s, id, env, seal, kc);
        assertEq(_status(s, id), SUBMITTED);
        // and refund is still closed in that same second
        vm.expectRevert(Core.WrongStatus.selector);
        s.core.claimRefund(id);
    }

    // ------------------------------------------------------------------ expiry after submission

    function test_S10_expiryAfterSubmission_exactSecond() public {
        (uint256 id,,) = _submittedJob();

        vm.warp(EXPIRY - 1);
        vm.expectRevert(Core.WrongStatus.selector);
        vm.prank(other);
        s.core.claimRefund(id);

        vm.warp(EXPIRY);
        Bal memory b = _snap(s);
        _releaseExpectRevert(s, id, solver, KEY); // correct key, exact expiry second
        _assertSame(b, _snap(s));
        assertFalse(s.hook.released(id));

        vm.prank(other);
        s.core.claimRefund(id);
        assertEq(_status(s, id), EXPIRED);
        assertEq(_bal(s, poster), b.poster + BUDGET);
        assertEq(_bal(s, solver), 0);
        assertEq(_bal(s, address(s.core)), 0);

        // late release still impossible, and the key stays unreleased
        _releaseExpectRevert(s, id, solver, KEY);
        assertFalse(s.hook.released(id));
    }

    function test_S10_lastSecondReleaseWorksThenRefundClosed() public {
        (uint256 id,,) = _submittedJob();
        vm.warp(EXPIRY - 1);
        _release(s, id, KEY);
        assertEq(_bal(s, solver), BUDGET);
        vm.warp(EXPIRY);
        vm.expectRevert(Core.WrongStatus.selector);
        s.core.claimRefund(id);
        assertEq(_bal(s, poster), POSTER_FUNDS - BUDGET, "no double payment to the poster");
    }

    function test_S10_refundBeforeExpiryReverts() public {
        uint256 funded = _fundedJob();
        (uint256 submitted,,) = _submittedJob();
        uint256[3] memory times = [T0, EXPIRY - 1 hours, EXPIRY - 1];
        for (uint256 i; i < times.length; i++) {
            vm.warp(times[i]);
            vm.expectRevert(Core.WrongStatus.selector);
            vm.prank(poster);
            s.core.claimRefund(funded);
            vm.expectRevert(Core.WrongStatus.selector);
            vm.prank(other);
            s.core.claimRefund(submitted);
        }
        assertEq(_status(s, funded), FUNDED);
        assertEq(_status(s, submitted), SUBMITTED);
    }

    // ------------------------------------------------------------------ S12 refund deltas

    function test_S12_refundExactDeltas() public {
        uint256 id = _fundedJob();
        Bal memory before_ = _snap(s);
        assertEq(before_.poster, POSTER_FUNDS - BUDGET);
        assertEq(before_.core, BUDGET);
        vm.warp(EXPIRY);
        vm.prank(other);
        s.core.claimRefund(id);
        Bal memory after_ = _snap(s);
        assertEq(after_.poster, before_.poster + BUDGET, "poster delta");
        assertEq(after_.poster, POSTER_FUNDS, "poster whole again");
        assertEq(after_.core, before_.core - BUDGET, "core delta");
        assertEq(after_.core, 0);
        assertEq(after_.solver, 0, "solver unchanged");
        assertEq(after_.hook, 0);
        assertEq(after_.treasury, 0);
        assertEq(after_.other, 0, "caller gets nothing");
    }

    function test_S12_refundAfterSubmissionExactDeltas() public {
        (uint256 id,,) = _submittedJob();
        Bal memory before_ = _snap(s);
        vm.warp(EXPIRY + 5);
        s.core.claimRefund(id);
        Bal memory after_ = _snap(s);
        assertEq(after_.poster, before_.poster + BUDGET);
        assertEq(after_.core, 0);
        assertEq(after_.solver, 0);
        assertEq(after_.hook, 0);
    }
}
