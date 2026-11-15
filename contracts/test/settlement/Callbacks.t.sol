// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SettlementBase, IToken} from "./SettlementBase.t.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";
import {SettlementHook} from "../../src/SettlementHook.sol";

/// S2 (behavioral), S3 and S4 and the Section 6 callback table.
contract CallbacksTest is SettlementBase {
    // ------------------------------------------------------------------ S2 behavioral

    function test_S2_solverSetBudgetReverts() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.expectRevert(Core.Unauthorized.selector);
        vm.prank(solver);
        s.core.setBudget(id, BUDGET, "");
    }

    function test_S2_posterSetBudgetWorks() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.expectEmit(true, false, false, true, address(s.core));
        emit BudgetSet(id, BUDGET);
        vm.prank(poster);
        s.core.setBudget(id, BUDGET, "");
        assertEq(s.core.getJob(id).budget, BUDGET);
    }

    function test_S2_thirdPartySetBudgetReverts() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.expectRevert(Core.Unauthorized.selector);
        vm.prank(other);
        s.core.setBudget(id, BUDGET, "");
    }

    // ------------------------------------------------------------------ S3 non-core callers

    function _selectors() internal pure returns (bytes4[] memory sels) {
        sels = new bytes4[](6);
        sels[0] = Core.createJob.selector;
        sels[1] = Core.setBudget.selector;
        sels[2] = Core.fund.selector;
        sels[3] = Core.submit.selector;
        sels[4] = Core.complete.selector;
        sels[5] = Core.reject.selector;
    }

    /// Payloads in the deployed layout (caller first).
    function _payloads() internal view returns (bytes[] memory d) {
        bytes memory fundOpt = abi.encode(IMAGE_ID, RULES_HASH, REFERENCE_HASH);
        bytes memory subOpt = abi.encode(_envelope(32), _seal(1), bytes32(uint256(1)));
        d = new bytes[](6);
        d[0] = abi.encode(poster, solver, address(s.hook));
        d[1] = abi.encode(poster, BUDGET, bytes(""));
        d[2] = abi.encode(poster, fundOpt);
        d[3] = abi.encode(solver, sha256(_envelope(32)), subOpt);
        d[4] = abi.encode(address(s.hook), bytes32(uint256(1)), bytes(""));
        d[5] = abi.encode(poster, bytes32(0), bytes(""));
    }

    function _callers() internal view returns (address[] memory c) {
        c = new address[](6);
        c[0] = other;
        c[1] = poster;
        c[2] = solver;
        c[3] = admin;
        c[4] = treasury;
        c[5] = address(s.hook);
    }

    function test_S3_beforeActionFromNonCoreReverts() public {
        uint256 id = _fundedJob();
        bytes4[] memory sels = _selectors();
        bytes[] memory d = _payloads();
        address[] memory c = _callers();
        for (uint256 i; i < sels.length; i++) {
            for (uint256 j; j < c.length; j++) {
                SettlementHook h = s.hook;
                vm.expectRevert();
                vm.prank(c[j]);
                h.beforeAction(id, sels[i], d[i]);
            }
        }
    }

    function test_S3_afterActionFromNonCoreReverts() public {
        uint256 id = _fundedJob();
        bytes4[] memory sels = _selectors();
        bytes[] memory d = _payloads();
        address[] memory c = _callers();
        for (uint256 i; i < sels.length; i++) {
            for (uint256 j; j < c.length; j++) {
                SettlementHook h = s.hook;
                vm.expectRevert();
                vm.prank(c[j]);
                h.afterAction(id, sels[i], d[i]);
            }
        }
    }

    function test_S3_directAfterFundCannotForgeTerms() public {
        // A job that exists in the core but was never funded: a forged afterAction(fund) must not
        // create funded Terms.
        uint256 id = _createJob(s, solver, EXPIRY);
        bytes memory d = abi.encode(poster, abi.encode(IMAGE_ID, RULES_HASH, REFERENCE_HASH));
        bytes4 sel = Core.fund.selector;
        vm.expectRevert();
        vm.prank(other);
        s.hook.afterAction(id, sel, d);
        (,,,,,, bool funded) = s.hook.terms(id);
        assertFalse(funded, "terms forged");
    }

    function test_S3_directAfterSubmitCannotForgeSubmission() public {
        uint256 id = _fundedJob();
        bytes memory d = abi.encode(solver, bytes32(uint256(1)), abi.encode(bytes(""), bytes(""), bytes32(0)));
        bytes4 sel = Core.submit.selector;
        vm.expectRevert();
        vm.prank(other);
        s.hook.afterAction(id, sel, d);
        (,, bool acc) = s.hook.submissions(id);
        assertFalse(acc, "submission forged");
    }

    // ------------------------------------------------------------------ S4 createJob / setBudget / fund rules

    function test_S4_createJobWrongEvaluatorReverts() public {
        address h = address(s.hook);
        address[] memory evals = new address[](3);
        evals[0] = other;
        evals[1] = poster;
        evals[2] = solver;
        for (uint256 i; i < evals.length; i++) {
            address ev = evals[i];
            vm.expectRevert();
            vm.prank(poster);
            s.core.createJob(solver, ev, EXPIRY, "job", h);
        }
        assertEq(s.core.jobCounter(), 0, "job created");
    }

    function test_S4_createJobZeroProviderReverts() public {
        address h = address(s.hook);
        vm.expectRevert();
        vm.prank(poster);
        s.core.createJob(address(0), h, EXPIRY, "job", h);
        assertEq(s.core.jobCounter(), 0, "job created");
    }

    function test_S4_createJobCorrectEvaluatorWorks() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        assertEq(id, 1);
        assertEq(s.core.getJob(id).evaluator, address(s.hook));
        assertEq(s.core.getJob(id).hook, address(s.hook));
    }

    function test_S4_setBudgetZeroReverts() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.expectRevert();
        vm.prank(poster);
        s.core.setBudget(id, 0, "");
    }

    function test_S4_setBudgetNonEmptyOptParamsReverts() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.expectRevert();
        vm.prank(poster);
        s.core.setBudget(id, BUDGET, hex"01");
    }

    function test_S4_fundWithoutBudgetReverts() public {
        // Budget is zero: the core would fund a zero-budget job, the hook must refuse.
        uint256 id = _createJob(s, solver, EXPIRY);
        bytes memory opt = abi.encode(IMAGE_ID, RULES_HASH, REFERENCE_HASH);
        vm.expectRevert();
        vm.prank(poster);
        s.core.fund(id, opt);
        assertEq(_status(s, id), OPEN);
    }

    function test_S4_fundMalformedOptParamsReverts() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.prank(poster);
        s.core.setBudget(id, BUDGET, "");
        vm.prank(poster);
        IToken(s.token).approve(address(s.core), BUDGET);

        vm.expectRevert();
        vm.prank(poster);
        s.core.fund(id, "");

        bytes memory shortOpt = abi.encode(IMAGE_ID, RULES_HASH); // 64 bytes
        vm.expectRevert();
        vm.prank(poster);
        s.core.fund(id, shortOpt);

        assertEq(_status(s, id), OPEN);
        assertEq(_bal(s, address(s.core)), 0);
    }

    function test_S4_fundExpiryMarginBoundary() public {
        // Core minimum is 5 minutes. Hook requires expiry >= now + MIN_EXPIRY_MARGIN (600).
        uint256 tooShort = _createJob(s, solver, T0 + MARGIN - 1);
        bytes memory opt = abi.encode(IMAGE_ID, RULES_HASH, REFERENCE_HASH);
        vm.startPrank(poster);
        s.core.setBudget(tooShort, BUDGET, "");
        IToken(s.token).approve(address(s.core), BUDGET);
        vm.stopPrank();
        vm.expectRevert();
        vm.prank(poster);
        s.core.fund(tooShort, opt);
        assertEq(_status(s, tooShort), OPEN);

        // exactly the margin is accepted
        uint256 exact = _createJob(s, solver, T0 + MARGIN);
        vm.prank(poster);
        s.core.setBudget(exact, BUDGET, "");
        vm.prank(poster);
        s.core.fund(exact, opt);
        assertEq(_status(s, exact), FUNDED);
    }

    function test_S4_fundStoresTermsFromCore() public {
        uint256 id = _fundedJob();
        (bytes32 img, bytes32 rules, bytes32 ref, address prov, uint256 budget, uint64 expiry, bool funded) =
            s.hook.terms(id);
        assertEq(img, IMAGE_ID);
        assertEq(rules, RULES_HASH);
        assertEq(ref, REFERENCE_HASH);
        assertEq(prov, solver);
        assertEq(budget, BUDGET);
        assertEq(uint256(expiry), EXPIRY);
        assertTrue(funded);
    }

    function test_S4_unfundedOpenZeroBudgetSubmitReverts() public {
        // The core lets the provider submit on an Open job with budget zero. The hook must refuse:
        // no frozen Terms exist, so nothing can be proven.
        uint256 id = _createJob(s, solver, EXPIRY);
        bytes memory env = _envelope(64);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        _submitExpectRevert(s, id, env, seal, kc);
        (,, bool acc) = s.hook.submissions(id);
        assertFalse(acc);
        assertEq(_status(s, id), OPEN);
    }

    function test_S4_unfundedOpenWithBudgetSubmitReverts() public {
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.prank(poster);
        s.core.setBudget(id, BUDGET, "");
        bytes memory env = _envelope(64);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        _submitExpectRevert(s, id, env, seal, kc);
        assertEq(_status(s, id), OPEN);
    }

    function test_S4_nonProviderSubmitReverts() public {
        uint256 id = _fundedJob();
        bytes memory env = _envelope(64);
        (bytes memory seal, bytes32 kc) = _proof(s, id, env, KEY);
        bytes32 h = sha256(env);
        bytes memory opt = abi.encode(env, seal, kc);
        address[] memory cs = new address[](3);
        cs[0] = other;
        cs[1] = poster;
        cs[2] = solver2;
        for (uint256 i; i < cs.length; i++) {
            _submitRawExpectRevert(s, id, cs[i], h, opt);
        }
        _assertFundedNotSubmitted(s, id);
    }

    function test_S4_submitMalformedOptParamsReverts() public {
        uint256 id = _fundedJob();
        bytes32 h = sha256(_envelope(64));
        _submitRawExpectRevert(s, id, solver, h, "");
        _submitRawExpectRevert(s, id, solver, h, hex"deadbeef");
        _assertFundedNotSubmitted(s, id);
    }

    function test_S4_rejectInOpenStateByPosterAllowed() public {
        // Section 6: "reject, others: allow without state changes". The core lets the client reject
        // an Open job. No funds are locked in Open, so nothing can be stolen.
        uint256 id = _createJob(s, solver, EXPIRY);
        vm.prank(poster);
        s.core.reject(id, bytes32(0), "");
        assertEq(_status(s, id), REJECTED);
        assertEq(_bal(s, address(s.core)), 0);
    }
}
