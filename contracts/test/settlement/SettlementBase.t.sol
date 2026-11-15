// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Shared deployment and an independent Section 7 wire-format encoder for the settlement tests (T4).
// Written from SETTLEMENT-IMPLEMENTATION.md only. It deliberately does not import the hook codec.

import {Test, console} from "forge-std/Test.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockRiscZeroVerifier} from "../../src/verifier/MockRiscZeroVerifier.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {SettlementHook} from "../../src/SettlementHook.sol";
import {ISettlementCore} from "../../src/interfaces/ISettlementCore.sol";
import {IProofVerifier} from "../../src/interfaces/IProofVerifier.sol";

interface IToken {
    function mint(address to, uint256 amount) external;
    function balanceOf(address who) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

abstract contract SettlementBase is Test {
    // ---- events (re-declared for expectEmit)
    event ProofAccepted(uint256 indexed jobId, bytes32 envelopeHash, bytes32 keyCommitment);
    event KeyReleased(uint256 indexed jobId, address indexed provider, bytes32 key, bytes32 envelopeHash);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobExpired(uint256 indexed jobId);

    // ---- job status values (core enum order)
    uint8 internal constant OPEN = 0;
    uint8 internal constant FUNDED = 1;
    uint8 internal constant SUBMITTED = 2;
    uint8 internal constant COMPLETED = 3;
    uint8 internal constant REJECTED = 4;
    uint8 internal constant EXPIRED = 5;

    // ---- parameters
    uint256 internal constant ARC_CHAIN_ID = 5042002;
    uint256 internal constant MAX_ENVELOPE = 16412;
    uint256 internal constant MARGIN = 600;
    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant EXPIRY = T0 + 1 days;
    uint256 internal constant BUDGET = 25e6;
    uint256 internal constant POSTER_FUNDS = 100e6;

    bytes32 internal constant IMAGE_ID = 0xc92414d80cdeb43ba0f4ff4882447c21f18b547d41ffa506a84da164e8e31f7d;
    bytes32 internal constant IMAGE_ID_B = 0x1111111111111111111111111111111111111111111111111111111111111112;
    bytes32 internal constant RULES_HASH = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 internal constant REFERENCE_HASH = 0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 internal constant KEY = 0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes32 internal constant KEY_B = 0x6666666666666666666666666666666666666666666666666666666666666666;

    struct Stack {
        address token;
        Core core;
        MockRiscZeroVerifier verifier;
        SettlementHook hook;
    }

    struct Bal {
        uint256 poster;
        uint256 solver;
        uint256 core;
        uint256 hook;
        uint256 treasury;
        uint256 other;
    }

    address internal poster;
    address internal solver;
    address internal solver2;
    address internal other;
    address internal admin;
    address internal treasury;

    Stack internal s;

    function setUp() public virtual {
        vm.chainId(ARC_CHAIN_ID);
        vm.warp(T0);
        poster = makeAddr("poster");
        solver = makeAddr("solver");
        solver2 = makeAddr("solver2");
        other = makeAddr("other");
        admin = makeAddr("admin");
        treasury = makeAddr("treasury");
        s = _deployStack(address(new MockUSDC()), address(new MockRiscZeroVerifier()));
    }

    // ------------------------------------------------------------------ deployment

    /// Deploys the patched core behind an ERC1967 proxy, the hook, whitelists the hook, renounces
    /// both admin roles (Section 4 step 5) and mints POSTER_FUNDS of `token` to the poster.
    function _deployStack(address token, address verifier_) internal returns (Stack memory k) {
        address impl = address(new Core());
        address proxy = address(new ERC1967Proxy(impl, abi.encodeCall(Core.initialize, (token, treasury, admin))));
        k.token = token;
        k.core = Core(proxy);
        k.verifier = MockRiscZeroVerifier(verifier_);
        k.hook = new SettlementHook(ISettlementCore(proxy), IProofVerifier(verifier_), token, MAX_ENVELOPE, MARGIN);
        bytes32 adminRole = k.core.ADMIN_ROLE();
        bytes32 defaultAdminRole = k.core.DEFAULT_ADMIN_ROLE();
        address h = address(k.hook);
        vm.startPrank(admin);
        k.core.setHookWhitelist(h, true);
        k.core.renounceRole(adminRole, admin);
        k.core.renounceRole(defaultAdminRole, admin);
        vm.stopPrank();
        IToken(token).mint(poster, POSTER_FUNDS);
    }

    // ------------------------------------------------------------------ Poster flow (four transactions)

    function _createJob(Stack memory k, address provider_, uint256 expiry_) internal returns (uint256 id) {
        address h = address(k.hook);
        vm.prank(poster);
        id = k.core.createJob(provider_, h, expiry_, "job", h);
    }

    /// setBudget, approve exactly the budget, fund (Poster transactions 2 to 4).
    function _budgetApproveFund(Stack memory k, uint256 id, uint256 budget_) internal {
        bytes memory opt = abi.encode(IMAGE_ID, RULES_HASH, REFERENCE_HASH);
        address c = address(k.core);
        vm.startPrank(poster);
        k.core.setBudget(id, budget_, "");
        IToken(k.token).approve(c, budget_);
        k.core.fund(id, opt);
        vm.stopPrank();
    }

    function _createAndFund(Stack memory k, address provider_, uint256 budget_, uint256 expiry_)
        internal
        returns (uint256 id)
    {
        id = _createJob(k, provider_, expiry_);
        _budgetApproveFund(k, id, budget_);
    }

    function _fundedJob() internal returns (uint256) {
        return _createAndFund(s, solver, BUDGET, EXPIRY);
    }

    // ------------------------------------------------------------------ independent Section 7 encoder

    /// context = 0x01 || chainId[32] || escrow[20] || jobId[32] || provider[20] || rules[32] || reference[32]
    function _context(uint256 chainId_, address escrow, uint256 jobId, address provider_, bytes32 rules, bytes32 ref)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes1(0x01), bytes32(chainId_), bytes20(escrow), bytes32(jobId), bytes20(provider_), rules, ref
        );
    }

    /// journal = context || verdict[1] || envelopeHash[32] || keyCommitment[32]
    function _journal(bytes memory ctx, uint8 verdict, bytes32 envelopeHash, bytes32 kc)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(ctx, bytes1(verdict), envelopeHash, kc);
    }

    /// keyCommitment = SHA256("UBC26/key/v1" || context || key[32])
    function _keyCommitment(bytes memory ctx, bytes32 key) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("UBC26/key/v1", ctx, key));
    }

    function _liveContext(Stack memory k, uint256 id, address provider_) internal view returns (bytes memory) {
        return _context(block.chainid, address(k.core), id, provider_, RULES_HASH, REFERENCE_HASH);
    }

    // ------------------------------------------------------------------ proofs and submission

    function _seal(uint256 salt) internal pure returns (bytes memory out) {
        out = bytes.concat(bytes4(0xe71e6620));
        for (uint256 i; i < 8; i++) {
            out = bytes.concat(out, keccak256(abi.encode(salt, i)));
        }
    }

    function _envelope(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) {
            b[i] = bytes1(uint8(i * 131 + 7));
        }
    }

    /// Registers ONLY this test file's own digest on the mock for the live job context, verdict 1.
    function _proof(Stack memory k, uint256 id, bytes memory env, bytes32 key)
        internal
        returns (bytes memory seal, bytes32 kc)
    {
        return _proofFor(k, id, solver, env, key);
    }

    function _proofFor(Stack memory k, uint256 id, address provider_, bytes memory env, bytes32 key)
        internal
        returns (bytes memory seal, bytes32 kc)
    {
        bytes memory ctx = _liveContext(k, id, provider_);
        kc = _keyCommitment(ctx, key);
        seal = _seal(uint256(keccak256(abi.encode(id, kc))));
        bytes32 digest = sha256(_journal(ctx, 1, sha256(env), kc));
        k.verifier.expect(seal, IMAGE_ID, digest);
    }

    function _submit(Stack memory k, uint256 id, bytes memory env, bytes memory seal, bytes32 kc) internal {
        bytes32 h = sha256(env);
        bytes memory opt = abi.encode(env, seal, kc);
        vm.prank(solver);
        k.core.submit(id, h, opt);
    }

    function _submitExpectRevert(Stack memory k, uint256 id, bytes memory env, bytes memory seal, bytes32 kc) internal {
        bytes32 h = sha256(env);
        bytes memory opt = abi.encode(env, seal, kc);
        vm.expectRevert();
        vm.prank(solver);
        k.core.submit(id, h, opt);
    }

    function _submitRawExpectRevert(Stack memory k, uint256 id, address caller, bytes32 deliverable, bytes memory opt)
        internal
    {
        vm.expectRevert();
        vm.prank(caller);
        k.core.submit(id, deliverable, opt);
    }

    /// Funds a job, registers its proof, submits it. Returns what is needed to release.
    function _submittedJob() internal returns (uint256 id, bytes memory env, bytes32 kc) {
        id = _fundedJob();
        env = _envelope(1024);
        bytes memory seal;
        (seal, kc) = _proof(s, id, env, KEY);
        _submit(s, id, env, seal, kc);
    }

    function _release(Stack memory k, uint256 id, bytes32 key) internal {
        vm.prank(solver);
        k.hook.release(id, key);
    }

    function _releaseExpectRevert(Stack memory k, uint256 id, address caller, bytes32 key) internal {
        vm.expectRevert();
        vm.prank(caller);
        k.hook.release(id, key);
    }

    // ------------------------------------------------------------------ state helpers

    function _status(Stack memory k, uint256 id) internal view returns (uint8) {
        return uint8(k.core.getJob(id).status);
    }

    function _bal(Stack memory k, address who) internal view returns (uint256) {
        return IToken(k.token).balanceOf(who);
    }

    function _snap(Stack memory k) internal view returns (Bal memory b) {
        b.poster = _bal(k, poster);
        b.solver = _bal(k, solver);
        b.core = _bal(k, address(k.core));
        b.hook = _bal(k, address(k.hook));
        b.treasury = _bal(k, treasury);
        b.other = _bal(k, other);
    }

    function _assertSame(Bal memory a, Bal memory b) internal pure {
        assertEq(a.poster, b.poster, "poster balance changed");
        assertEq(a.solver, b.solver, "solver balance changed");
        assertEq(a.core, b.core, "core balance changed");
        assertEq(a.hook, b.hook, "hook balance changed");
        assertEq(a.treasury, b.treasury, "treasury balance changed");
        assertEq(a.other, b.other, "other balance changed");
    }

    function _assertFundedNotSubmitted(Stack memory k, uint256 id) internal view {
        assertEq(uint256(_status(k, id)), FUNDED, "job should stay Funded");
        (bytes32 h, bytes32 kc, bool acc) = k.hook.submissions(id);
        assertEq(h, bytes32(0), "envelopeHash stored");
        assertEq(kc, bytes32(0), "keyCommitment stored");
        assertFalse(acc, "submission accepted");
        assertFalse(k.hook.released(id), "released set");
        assertTrue(_bal(k, address(k.core)) >= k.core.getJob(id).budget, "core escrow missing");
    }
}
