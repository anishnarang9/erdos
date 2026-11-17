// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IACPHook} from "../../src/core/src/interfaces/IACPHook.sol";
import {MockRiscZeroVerifier} from "../../src/verifier/MockRiscZeroVerifier.sol";
import {OpenClaimAdapter} from "../../src/OpenClaimAdapter.sol";

/// Test-only token. Delta and callback modes exercise hostile token behavior.
contract OpenClaimAdversarialUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    address public deltaFrom;
    address public deltaTo;
    int256 public transferDelta;
    address public callbackTarget;
    uint8 public constant decimals = 6;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function setDelta(address from, address to, int256 delta) external {
        deltaFrom = from;
        deltaTo = to;
        transferDelta = delta;
    }

    function setCallback(address target) external {
        callbackTarget = target;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(!blocked[from] && !blocked[to], "blocked");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 received = amount;
        if (from == deltaFrom && to == deltaTo) {
            if (transferDelta < 0) received -= uint256(-transferDelta);
            else received += uint256(transferDelta);
        }
        balanceOf[to] += received;
        emit Transfer(from, to, received);
        if (to == callbackTarget) OpenClaimReentrantSolver(to).onPayout();
    }
}

contract OpenClaimReentrantSolver {
    OpenClaimAdapter internal adapter;
    OpenClaimAdversarialUSDC internal token;
    uint256 internal first;
    uint256 internal second;
    bytes32 internal key;
    uint256 public callbacks;
    bool public sameJobSucceeded;
    bool public otherJobSucceeded;

    constructor(OpenClaimAdapter adapter_, OpenClaimAdversarialUSDC token_) {
        adapter = adapter_;
        token = token_;
    }

    function claim(uint256 id, bytes calldata envelope, bytes calldata seal, bytes32 commitment) external {
        adapter.claim(id, envelope, seal, commitment);
    }

    function release(uint256 id, uint256 otherId, bytes32 key_) external {
        first = id;
        second = otherId;
        key = key_;
        adapter.release(id, key_);
    }

    function onPayout() external {
        require(msg.sender == address(token), "token only");
        callbacks++;
        (sameJobSucceeded,) = address(adapter).call(abi.encodeCall(OpenClaimAdapter.release, (first, key)));
        (otherJobSucceeded,) = address(adapter).call(abi.encodeCall(OpenClaimAdapter.release, (second, key)));
    }
}

contract OpenClaimNoopHook is IACPHook {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == 0x01ffc9a7;
    }
    function beforeAction(uint256, bytes4, bytes calldata) external {}
    function afterAction(uint256, bytes4, bytes calldata) external {}
}

/// Independent normative encoding. No SettlementCodec import or adapter-generated proof digests.
contract OpenClaimAdapterTest is Test {
    uint256 internal constant CHAIN = 5042002;
    uint256 internal constant NOW = 1_800_000_000;
    uint64 internal constant EXPIRY = uint64(NOW + 3600);
    uint256 internal constant BUDGET = 25_000_000;
    uint256 internal constant BUYER_FUNDS = 1e24;
    bytes32 internal constant IMAGE = bytes32(uint256(0x1234));
    bytes32 internal constant RULES = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 internal constant REFERENCE = 0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 internal constant KEY = 0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes internal constant ENVELOPE = hex"010203040506070809aabbccddeeff";
    Core internal core;
    OpenClaimAdversarialUSDC internal token;
    MockRiscZeroVerifier internal verifier;
    OpenClaimAdapter internal adapter;
    address internal buyer;
    address internal solver;
    address internal solver2;
    address internal outsider;
    address internal treasury;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobExpired(uint256 indexed jobId);
    event TermsRegistered(
        uint256 indexed jobId,
        address indexed buyer,
        bytes32 imageId,
        bytes32 rulesHash,
        bytes32 referenceHash,
        uint256 budget,
        uint64 expiry
    );
    event ClaimAccepted(
        uint256 indexed jobId, address indexed solver, bytes32 envelopeHash, bytes32 keyCommitment, bytes envelope
    );
    event KeyReleased(uint256 indexed jobId, address indexed solver, bytes32 key, bytes32 envelopeHash, uint256 amount);

    function setUp() public {
        vm.chainId(CHAIN);
        vm.warp(NOW);
        buyer = makeAddr("open buyer");
        solver = makeAddr("open solver one");
        solver2 = makeAddr("open solver two");
        outsider = makeAddr("open outsider");
        treasury = makeAddr("open treasury");
        _deploy(true);
    }

    function _deploy(bool freeze) internal {
        token = new OpenClaimAdversarialUSDC();
        verifier = new MockRiscZeroVerifier();
        core = Core(
            address(
                new ERC1967Proxy(
                    address(new Core()), abi.encodeCall(Core.initialize, (address(token), treasury, address(this)))
                )
            )
        );
        adapter = new OpenClaimAdapter(address(core), address(verifier), address(token));
        token.mint(buyer, BUYER_FUNDS);
        if (freeze) {
            core.renounceRole(core.ADMIN_ROLE(), address(this));
            core.renounceRole(core.DEFAULT_ADMIN_ROLE(), address(this));
        }
    }

    function _create(address provider, address evaluator, uint64 expiry, address hook) internal returns (uint256 id) {
        vm.prank(buyer);
        id = core.createJob(provider, evaluator, expiry, "approved open-claim job", hook);
    }

    function _fund(uint256 id, uint256 amount) internal {
        vm.startPrank(buyer);
        core.setBudget(id, amount, "");
        token.approve(address(core), amount);
        core.fund(id, "");
        vm.stopPrank();
    }

    function _funded(uint256 amount, uint64 expiry) internal returns (uint256 id) {
        id = _create(address(adapter), address(adapter), expiry, address(0));
        _fund(id, amount);
    }

    function _register(uint256 id, uint256 amount, uint64 expiry) internal {
        vm.prank(buyer);
        adapter.register(id, IMAGE, RULES, REFERENCE, amount, expiry);
    }

    function _job() internal returns (uint256 id) {
        id = _funded(BUDGET, EXPIRY);
        _register(id, BUDGET, EXPIRY);
    }

    function _context(uint256 chain, address domain, uint256 id, address candidate, bytes32 rules, bytes32 ref)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes1(0x01), bytes32(chain), bytes20(domain), bytes32(id), bytes20(candidate), rules, ref
        );
    }

    function _context(uint256 id, address candidate) internal view returns (bytes memory) {
        return _context(block.chainid, address(adapter), id, candidate, RULES, REFERENCE);
    }

    function _commitment(bytes memory context, bytes32 key) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("UBC26/key/v1", context, key));
    }

    function _journal(bytes memory context, uint8 verdict, bytes32 envelopeHash, bytes32 commitment)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(context, bytes1(verdict), envelopeHash, commitment);
    }

    function _proof(uint256 id, address candidate, bytes memory envelope, bytes32 key)
        internal
        returns (bytes memory seal, bytes32 commitment)
    {
        bytes memory context = _context(id, candidate);
        commitment = _commitment(context, key);
        bytes32 digest = sha256(_journal(context, 1, sha256(envelope), commitment));
        seal = abi.encodePacked(bytes4(0xe71e6620), digest);
        verifier.expect(seal, IMAGE, digest);
    }

    function _claim(uint256 id, address candidate) internal returns (bytes32 commitment) {
        bytes memory seal;
        (seal, commitment) = _proof(id, candidate, ENVELOPE, KEY);
        vm.prank(candidate);
        adapter.claim(id, ENVELOPE, seal, commitment);
    }

    function _assertUnreserved(uint256 id) internal view {
        (address winner, bytes32 envelopeHash, bytes32 commitment, bool accepted) = adapter.submissions(id);
        assertEq(winner, address(0));
        assertEq(envelopeHash, bytes32(0));
        assertEq(commitment, bytes32(0));
        assertFalse(accepted);
        assertFalse(adapter.released(id));
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Funded));
    }

    function _assertSubmitted(uint256 id, address candidate) internal view {
        (address winner, bytes32 envelopeHash, bytes32 commitment, bool accepted) = adapter.submissions(id);
        assertEq(winner, candidate);
        assertEq(envelopeHash, sha256(ENVELOPE));
        assertEq(commitment, _commitment(_context(id, candidate), KEY));
        assertTrue(accepted);
        assertFalse(adapter.released(id));
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Submitted));
    }

    function _expectRegisterRevert(uint256 id, uint256 amount, uint64 expiry) internal {
        vm.expectRevert();
        vm.prank(buyer);
        adapter.register(id, IMAGE, RULES, REFERENCE, amount, expiry);
    }

    function _assertOneEvent(
        Vm.Log[] memory logs,
        address emitter,
        bytes32 signature,
        bytes32 indexed1,
        bytes32 indexed2,
        bytes memory data
    ) internal pure {
        uint256 count;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != emitter || logs[i].topics[0] != signature) continue;
            count++;
            assertEq(logs[i].topics.length, 3);
            assertEq(logs[i].topics[1], indexed1);
            assertEq(logs[i].topics[2], indexed2);
            assertEq(logs[i].data, data);
        }
        assertEq(count, 1, "event must occur exactly once");
    }

    function _assertCoreCompletion(Vm.Log[] memory logs, uint256 id) internal view {
        uint256 count;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter != address(core)
                    || logs[i].topics[0] != keccak256("JobCompleted(uint256,address,bytes32)")
            ) continue;
            count++;
            assertEq(logs[i].topics.length, 3);
            assertEq(logs[i].topics[1], bytes32(id));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(adapter)))));
            // The normative API does not prescribe the core's reason value.
            assertEq(logs[i].data.length, 32);
        }
        assertEq(count, 1);
    }

    function test_constantsImmutableWiringAndFrozenCore() public view {
        assertEq(address(adapter.core()), address(core));
        assertEq(address(adapter.verifier()), address(verifier));
        assertEq(address(adapter.usdc()), address(token));
        assertEq(adapter.MAX_ENVELOPE_BYTES(), 16412);
        assertEq(adapter.MIN_EXPIRY_MARGIN(), 600);
        assertFalse(core.hasRole(core.ADMIN_ROLE(), address(this)));
        assertFalse(core.hasRole(core.DEFAULT_ADMIN_ROLE(), address(this)));
        assertEq(core.platformFeeBP(), 0);
        assertEq(core.evaluatorFeeBP(), 0);
    }

    function test_constructorRejectsAddressWithoutVerifierCode() public {
        vm.expectRevert();
        new OpenClaimAdapter(address(core), outsider, address(token));
    }

    function test_constructorRejectsInitialPlatformFee() public {
        _deploy(false);
        core.setPlatformFee(1, treasury);
        vm.expectRevert(OpenClaimAdapter.FeesEnabled.selector);
        new OpenClaimAdapter(address(core), address(verifier), address(token));
    }

    function test_constructorRejectsInitialEvaluatorFee() public {
        _deploy(false);
        core.setEvaluatorFee(1);
        vm.expectRevert(OpenClaimAdapter.FeesEnabled.selector);
        new OpenClaimAdapter(address(core), address(verifier), address(token));
    }

    function test_independentSyntheticWireVector() public pure {
        bytes memory context = _context(
            CHAIN,
            0x1111111111111111111111111111111111111111,
            7,
            0x2222222222222222222222222222222222222222,
            RULES,
            REFERENCE
        );
        assertEq(context.length, 169);
        bytes32 commitment = _commitment(context, KEY);
        assertEq(commitment, 0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d);
        bytes memory journal =
            _journal(context, 1, 0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6, commitment);
        assertEq(journal.length, 234);
        assertEq(sha256(journal), 0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e);
    }

    function test_exactFundingRegistrationStateBalancesAndEvents() public {
        vm.expectEmit(true, true, true, true, address(core));
        emit JobCreated(1, buyer, address(adapter), address(adapter), EXPIRY, address(0));
        uint256 id = _create(address(adapter), address(adapter), EXPIRY, address(0));
        vm.startPrank(buyer);
        vm.expectEmit(true, false, false, true, address(core));
        emit BudgetSet(id, BUDGET);
        core.setBudget(id, BUDGET, "");
        token.approve(address(core), BUDGET);
        vm.expectEmit(true, true, false, true, address(core));
        emit JobFunded(id, buyer, BUDGET);
        core.fund(id, "");
        vm.stopPrank();
        vm.expectEmit(true, true, false, true, address(adapter));
        emit TermsRegistered(id, buyer, IMAGE, RULES, REFERENCE, BUDGET, EXPIRY);
        _register(id, BUDGET, EXPIRY);
        (
            address registeredBuyer,
            bytes32 image,
            bytes32 rules,
            bytes32 ref,
            uint256 amount,
            uint64 expiry,
            bool registered
        ) = adapter.terms(id);
        assertEq(registeredBuyer, buyer);
        assertEq(image, IMAGE);
        assertEq(rules, RULES);
        assertEq(ref, REFERENCE);
        assertEq(amount, BUDGET);
        assertEq(expiry, EXPIRY);
        assertTrue(registered);
        assertEq(core.getJob(id).provider, address(adapter));
        assertEq(core.getJob(id).evaluator, address(adapter));
        assertEq(core.getJob(id).hook, address(0));
        assertEq(token.balanceOf(buyer), BUYER_FUNDS - BUDGET);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(token.allowance(buyer, address(core)), 0);
        _assertUnreserved(id);
    }

    function test_registerRejectsWrongBuyer() public {
        uint256 id = _funded(BUDGET, EXPIRY);
        vm.expectRevert();
        vm.prank(outsider);
        adapter.register(id, IMAGE, RULES, REFERENCE, BUDGET, EXPIRY);
        (,,,,,, bool registered) = adapter.terms(id);
        assertFalse(registered);
        assertEq(token.balanceOf(address(core)), BUDGET);
    }

    function test_registerRejectsDuplicateAndCannotReplaceCommitments() public {
        uint256 id = _job();
        vm.expectRevert();
        vm.prank(buyer);
        adapter.register(id, bytes32(uint256(99)), bytes32(uint256(98)), REFERENCE, BUDGET, EXPIRY);
        (, bytes32 image, bytes32 rules,,,, bool registered) = adapter.terms(id);
        assertEq(image, IMAGE);
        assertEq(rules, RULES);
        assertTrue(registered);
    }

    function test_registerRejectsWrongBudgetAndExpiry() public {
        uint256 id = _funded(BUDGET, EXPIRY);
        _expectRegisterRevert(id, BUDGET + 1, EXPIRY);
        _expectRegisterRevert(id, BUDGET - 1, EXPIRY);
        _expectRegisterRevert(id, BUDGET, EXPIRY + 1);
        _expectRegisterRevert(id, BUDGET, EXPIRY - 1);
        _register(id, BUDGET, EXPIRY);
        _assertUnreserved(id);
    }

    function test_registerRejectsUnfundedZeroBudgetAndMissingJob() public {
        uint256 id = _create(address(adapter), address(adapter), EXPIRY, address(0));
        vm.prank(buyer);
        core.setBudget(id, BUDGET, "");
        _expectRegisterRevert(id, BUDGET, EXPIRY);
        uint256 zeroId = _funded(0, EXPIRY);
        _expectRegisterRevert(zeroId, 0, EXPIRY);
        _expectRegisterRevert(987654321, BUDGET, EXPIRY);
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Open));
        assertEq(token.balanceOf(address(core)), 0);
    }

    function test_registerRejectsWrongProviderAndEvaluator() public {
        uint256 wrongProvider = _create(solver, address(adapter), EXPIRY, address(0));
        _fund(wrongProvider, BUDGET);
        _expectRegisterRevert(wrongProvider, BUDGET, EXPIRY);
        uint256 wrongEvaluator = _create(address(adapter), outsider, EXPIRY, address(0));
        _fund(wrongEvaluator, BUDGET);
        _expectRegisterRevert(wrongEvaluator, BUDGET, EXPIRY);
        assertEq(token.balanceOf(address(core)), 2 * BUDGET);
    }

    function test_registerRejectsNonzeroHook() public {
        _deploy(false);
        OpenClaimNoopHook hook = new OpenClaimNoopHook();
        core.setHookWhitelist(address(hook), true);
        uint256 id = _create(address(adapter), address(adapter), EXPIRY, address(hook));
        _fund(id, BUDGET);
        _expectRegisterRevert(id, BUDGET, EXPIRY);
        assertEq(token.balanceOf(address(core)), BUDGET);
    }

    function test_wrongPaymentTokenCannotRegister() public {
        OpenClaimAdversarialUSDC wrongToken = new OpenClaimAdversarialUSDC();
        try new OpenClaimAdapter(address(core), address(verifier), address(wrongToken)) returns (OpenClaimAdapter bad) {
            uint256 id = _create(address(bad), address(bad), EXPIRY, address(0));
            _fund(id, BUDGET);
            vm.expectRevert();
            vm.prank(buyer);
            bad.register(id, IMAGE, RULES, REFERENCE, BUDGET, EXPIRY);
        } catch { /* Constructor rejection also enforces the token invariant. */ }
    }

    function test_registerRejectsBothFeeTypes() public {
        _deploy(false);
        uint256 id = _funded(BUDGET, EXPIRY);
        core.setPlatformFee(1, treasury);
        _expectRegisterRevert(id, BUDGET, EXPIRY);
        core.setPlatformFee(0, treasury);
        core.setEvaluatorFee(1);
        _expectRegisterRevert(id, BUDGET, EXPIRY);
        core.setEvaluatorFee(0);
        _register(id, BUDGET, EXPIRY);
        _assertUnreserved(id);
    }

    function test_registrationMarginIncludesExactly600Seconds() public {
        uint256 id = _funded(BUDGET, EXPIRY);
        vm.warp(EXPIRY - 600);
        _register(id, BUDGET, EXPIRY);
        _assertUnreserved(id);
    }

    function test_registrationMarginRejects599SecondsAndExpired() public {
        uint256 id = _funded(BUDGET, EXPIRY);
        vm.warp(EXPIRY - 599);
        _expectRegisterRevert(id, BUDGET, EXPIRY);
        vm.warp(EXPIRY);
        _expectRegisterRevert(id, BUDGET, EXPIRY);
        assertEq(token.balanceOf(address(core)), BUDGET);
    }

    function test_failedFundingCannotCreateRegisteredTerms() public {
        uint256 id = _create(address(adapter), address(adapter), EXPIRY, address(0));
        vm.startPrank(buyer);
        core.setBudget(id, BUDGET, "");
        token.approve(address(core), BUDGET - 1);
        vm.expectRevert();
        core.fund(id, "");
        vm.stopPrank();
        _expectRegisterRevert(id, BUDGET, EXPIRY);
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Open));
        assertEq(token.balanceOf(buyer), BUYER_FUNDS);
        assertEq(token.balanceOf(address(core)), 0);
    }

    function test_contextAndJournalMatchIndependentEncoding() public {
        uint256 id = _job();
        bytes memory context = _context(id, solver);
        assertEq(adapter.contextOf(id, solver), context);
        bytes32 commitment = _commitment(context, KEY);
        (bytes memory journal, bytes32 digest) = adapter.expectedJournal(id, solver, sha256(ENVELOPE), commitment);
        assertEq(context.length, 169);
        assertEq(journal.length, 234);
        assertEq(journal, _journal(context, 1, sha256(ENVELOPE), commitment));
        assertEq(digest, sha256(journal));
        assertNotEq(adapter.contextOf(id, solver2), context);
    }

    function test_invalidFirstProofLeavesUnreservedThenFirstValidSolverWins() public {
        uint256 id = _job();
        (bytes memory seal, bytes32 commitment) = _proof(id, solver, ENVELOPE, KEY);
        vm.expectRevert();
        vm.prank(solver2);
        adapter.claim(id, ENVELOPE, seal, commitment);
        _assertUnreserved(id);
        assertEq(token.balanceOf(address(core)), BUDGET);
        (bytes memory secondSeal, bytes32 secondCommitment) = _proof(id, solver2, ENVELOPE, KEY);
        vm.recordLogs();
        vm.prank(solver2);
        adapter.claim(id, ENVELOPE, secondSeal, secondCommitment);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _assertOneEvent(
            logs,
            address(adapter),
            keccak256("ClaimAccepted(uint256,address,bytes32,bytes32,bytes)"),
            bytes32(id),
            bytes32(uint256(uint160(solver2))),
            abi.encode(sha256(ENVELOPE), secondCommitment, ENVELOPE)
        );
        _assertOneEvent(
            logs,
            address(core),
            keccak256("JobSubmitted(uint256,address,bytes32)"),
            bytes32(id),
            bytes32(uint256(uint160(address(adapter)))),
            abi.encode(sha256(ENVELOPE))
        );
        _assertSubmitted(id, solver2);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        _assertSubmitted(id, solver2);
        vm.prank(solver2);
        adapter.release(id, KEY);
        assertEq(token.balanceOf(solver2), BUDGET);
        assertEq(token.balanceOf(solver), 0);
    }

    function test_proofRejectsEveryIndependentBindingMutation() public {
        uint256 id = _job();
        bytes32 commitment = _commitment(_context(id, solver), KEY);
        for (uint8 field; field < 11; field++) {
            bytes memory context = _context(
                field == 0 ? CHAIN + 1 : CHAIN,
                field == 1 ? outsider : (field == 10 ? address(core) : address(adapter)),
                field == 2 ? id + 1 : id,
                field == 3 ? solver2 : solver,
                field == 4 ? bytes32(uint256(RULES) ^ 1) : RULES,
                field == 5 ? bytes32(uint256(REFERENCE) ^ 1) : REFERENCE
            );
            bytes32 envelopeHash = sha256(ENVELOPE);
            bytes32 proofCommitment = commitment;
            if (field == 7) envelopeHash = bytes32(uint256(envelopeHash) ^ 1);
            if (field == 8) proofCommitment = bytes32(uint256(commitment) ^ 1);
            bytes32 digest = sha256(_journal(context, field == 9 ? 0 : 1, envelopeHash, proofCommitment));
            bytes memory seal = abi.encodePacked(field, digest);
            verifier.expect(seal, field == 6 ? bytes32(uint256(IMAGE) ^ 1) : IMAGE, digest);
            vm.expectRevert();
            vm.prank(solver);
            adapter.claim(id, ENVELOPE, seal, commitment);
            _assertUnreserved(id);
            assertEq(token.balanceOf(address(core)), BUDGET);
            assertEq(token.balanceOf(address(adapter)), 0);
            assertEq(token.balanceOf(solver), 0);
        }
        _claim(id, solver);
        _assertSubmitted(id, solver);
    }

    function test_claimRejectsUnregisteredHooklessJob() public {
        uint256 id = _funded(BUDGET, EXPIRY);
        (bytes memory seal, bytes32 commitment) = _proof(id, solver, ENVELOPE, KEY);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        _assertUnreserved(id);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        assertEq(token.balanceOf(address(core)), BUDGET);
    }

    function test_claimRejectsOversizedEnvelopeButAcceptsExactCap() public {
        uint256 id = _job();
        bytes memory large = new bytes(16413);
        (bytes memory seal, bytes32 commitment) = _proof(id, solver, large, KEY);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, large, seal, commitment);
        _assertUnreserved(id);
        bytes memory exact = new bytes(16412);
        (seal, commitment) = _proof(id, solver, exact, KEY);
        vm.prank(solver);
        adapter.claim(id, exact, seal, commitment);
        (address winner, bytes32 envelopeHash,, bool accepted) = adapter.submissions(id);
        assertEq(winner, solver);
        assertEq(envelopeHash, sha256(exact));
        assertTrue(accepted);
    }

    function test_feeMutationRejectsClaimWithoutReservation() public {
        _deploy(false);
        uint256 id = _job();
        (bytes memory seal, bytes32 commitment) = _proof(id, solver, ENVELOPE, KEY);
        core.setPlatformFee(1, treasury);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        _assertUnreserved(id);
        core.setPlatformFee(0, treasury);
        core.setEvaluatorFee(1);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        _assertUnreserved(id);
        assertEq(token.balanceOf(address(core)), BUDGET);
    }

    function test_wrongSolverOrKeyCannotReleaseOrMoveFunds() public {
        uint256 id = _job();
        _claim(id, solver);
        vm.expectRevert();
        vm.prank(solver2);
        adapter.release(id, KEY);
        vm.expectRevert();
        vm.prank(buyer);
        adapter.release(id, KEY);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, bytes32(uint256(KEY) ^ 1));
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(solver), 0);
    }

    function test_exactReleaseSinglePaymentEventsAndDuplicateCalls() public {
        uint256 id = _job();
        bytes32 commitment = _claim(id, solver);
        vm.recordLogs();
        vm.prank(solver);
        adapter.release(id, KEY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 adapterTopic = bytes32(uint256(uint160(address(adapter))));
        bytes32 solverTopic = bytes32(uint256(uint160(solver)));
        _assertCoreCompletion(logs, id);
        _assertOneEvent(
            logs,
            address(core),
            keccak256("PaymentReleased(uint256,address,uint256)"),
            bytes32(id),
            adapterTopic,
            abi.encode(BUDGET)
        );
        _assertOneEvent(
            logs,
            address(adapter),
            keccak256("KeyReleased(uint256,address,bytes32,bytes32,uint256)"),
            bytes32(id),
            solverTopic,
            abi.encode(KEY, sha256(ENVELOPE), BUDGET)
        );
        uint256 payouts;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(token) && logs[i].topics.length == 3
                    && logs[i].topics[0] == keccak256("Transfer(address,address,uint256)")
                    && logs[i].topics[1] == adapterTopic && logs[i].topics[2] == solverTopic
            ) {
                assertEq(logs[i].data, abi.encode(BUDGET));
                payouts++;
            }
        }
        assertEq(payouts, 1, "solver receives exactly one transfer");
        assertTrue(adapter.released(id));
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Completed));
        assertEq(token.balanceOf(solver), BUDGET);
        assertEq(token.balanceOf(address(core)), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS - BUDGET);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        (bytes memory seal,) = _proof(id, solver, ENVELOPE, KEY);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        assertEq(token.balanceOf(solver), BUDGET);
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Completed));
    }

    function test_duplicateClaimCannotChangeAcceptedProof() public {
        uint256 id = _job();
        bytes32 commitment = _claim(id, solver);
        (bytes memory seal,) = _proof(id, solver, ENVELOPE, KEY);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        _assertSubmitted(id, solver);
    }

    function test_blockedSolverPayoutRollsBackCoreKeyAndPayment() public {
        uint256 id = _job();
        _claim(id, solver);
        token.setBlocked(solver, true);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(solver), 0);
        token.setBlocked(solver, false);
        vm.prank(solver);
        adapter.release(id, KEY);
        assertEq(token.balanceOf(solver), BUDGET);
    }

    function test_failedCoreTransferRollsBackRelease() public {
        uint256 id = _job();
        _claim(id, solver);
        token.setBlocked(address(adapter), true);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(solver), 0);
    }

    function test_shortOrExcessCorePaymentRejectsDespiteAdapterTopUp() public {
        uint256 id = _job();
        uint256 otherId = _job();
        _claim(id, solver);
        token.mint(address(adapter), BUDGET * 4);
        token.setDelta(address(core), address(adapter), -1);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        _assertUnreserved(otherId);
        assertEq(token.balanceOf(address(core)), BUDGET * 2);
        assertEq(token.balanceOf(address(adapter)), BUDGET * 4);
        assertEq(token.balanceOf(solver), 0);
        token.setDelta(address(core), address(adapter), 1);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET * 2);
        assertEq(token.balanceOf(address(adapter)), BUDGET * 4);
    }

    function test_shortOrExcessSolverPaymentRollsBackDespiteAdapterTopUp() public {
        uint256 id = _job();
        uint256 otherBudget = BUDGET + 7;
        uint256 otherId = _funded(otherBudget, EXPIRY);
        _register(otherId, otherBudget, EXPIRY);
        _claim(id, solver);
        token.mint(address(adapter), BUDGET * 4);
        token.setDelta(address(adapter), solver, -1);
        vm.expectRevert(OpenClaimAdapter.WrongPaymentAmount.selector);
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        _assertUnreserved(otherId);
        assertEq(token.balanceOf(address(core)), BUDGET + otherBudget);
        assertEq(token.balanceOf(address(adapter)), BUDGET * 4);
        assertEq(token.balanceOf(solver), 0);
        token.setDelta(address(adapter), solver, 1);
        vm.expectRevert(OpenClaimAdapter.WrongPaymentAmount.selector);
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        _assertUnreserved(otherId);
        assertEq(token.balanceOf(address(core)), BUDGET + otherBudget);
        assertEq(token.balanceOf(address(adapter)), BUDGET * 4);
        assertEq(token.balanceOf(solver), 0);
    }

    function test_topUpAndUnrelatedJobRemainIntactAfterExactRelease() public {
        uint256 id = _job();
        uint256 otherBudget = BUDGET + 7;
        uint256 otherId = _funded(otherBudget, EXPIRY);
        _register(otherId, otherBudget, EXPIRY);
        _claim(id, solver);
        token.mint(address(adapter), 12345);
        vm.prank(solver);
        adapter.release(id, KEY);
        assertEq(token.balanceOf(solver), BUDGET);
        assertEq(token.balanceOf(address(adapter)), 12345);
        assertEq(token.balanceOf(address(core)), otherBudget);
        _assertUnreserved(otherId);
        _claim(otherId, solver2);
        vm.prank(solver2);
        adapter.release(otherId, KEY);
        assertEq(token.balanceOf(solver2), otherBudget);
        assertEq(token.balanceOf(address(adapter)), 12345);
        assertEq(token.balanceOf(address(core)), 0);
    }

    function test_feeMutationCannotUseDonationsToMaskShortPayment() public {
        _deploy(false);
        uint256 id = _job();
        _claim(id, solver);
        token.mint(address(adapter), BUDGET);
        core.setPlatformFee(100, treasury);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(address(adapter)), BUDGET);
        assertEq(token.balanceOf(treasury), 0);
        core.setPlatformFee(0, treasury);
        core.setEvaluatorFee(100);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(address(adapter)), BUDGET);
    }

    function test_reentrantSolverCannotPayTwiceOrReleaseAnotherJob() public {
        OpenClaimReentrantSolver attacker = new OpenClaimReentrantSolver(adapter, token);
        uint256 id = _job();
        uint256 otherId = _job();
        (bytes memory seal, bytes32 commitment) = _proof(id, address(attacker), ENVELOPE, KEY);
        attacker.claim(id, ENVELOPE, seal, commitment);
        (seal, commitment) = _proof(otherId, address(attacker), ENVELOPE, KEY);
        attacker.claim(otherId, ENVELOPE, seal, commitment);
        token.setCallback(address(attacker));
        attacker.release(id, otherId, KEY);
        assertEq(attacker.callbacks(), 1);
        assertFalse(attacker.sameJobSucceeded());
        assertFalse(attacker.otherJobSucceeded());
        assertTrue(adapter.released(id));
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Completed));
        _assertSubmitted(otherId, address(attacker));
        assertEq(token.balanceOf(address(attacker)), BUDGET);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(address(adapter)), 0);
    }

    function test_claimAndReleaseAtLastSecondBeforeExpiry() public {
        uint256 id = _job();
        vm.warp(EXPIRY - 1);
        _claim(id, solver);
        vm.expectRevert();
        vm.prank(outsider);
        core.claimRefund(id);
        vm.prank(solver);
        adapter.release(id, KEY);
        assertTrue(adapter.released(id));
        assertEq(token.balanceOf(solver), BUDGET);
    }

    function test_atExpiryClaimRejectsAndPermissionlessFundedRefundIsExact() public {
        uint256 id = _job();
        (bytes memory seal, bytes32 commitment) = _proof(id, solver, ENVELOPE, KEY);
        vm.warp(EXPIRY);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        _assertUnreserved(id);
        _refund(id);
        vm.expectRevert();
        vm.prank(outsider);
        core.claimRefund(id);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS);
    }

    function test_atExpiryReleaseRejectsAndPermissionlessSubmittedRefundIsExact() public {
        uint256 id = _job();
        _claim(id, solver);
        vm.warp(EXPIRY);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _assertSubmitted(id, solver);
        _refund(id);
        (address winner,,, bool accepted) = adapter.submissions(id);
        assertEq(winner, solver);
        assertTrue(accepted, "records remain historical after core refund");
        assertFalse(adapter.released(id));
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS);
    }

    function test_unregisteredFundedJobStillRefundsDirectlyToBuyer() public {
        uint256 id = _funded(BUDGET, EXPIRY);
        vm.warp(EXPIRY);
        _refund(id);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS);
        (,,,,,, bool registered) = adapter.terms(id);
        assertFalse(registered);
    }

    function _refund(uint256 id) internal {
        vm.expectEmit(true, true, false, true, address(core));
        emit Refunded(id, buyer, BUDGET);
        vm.expectEmit(true, false, false, true, address(core));
        emit JobExpired(id);
        vm.prank(outsider);
        core.claimRefund(id);
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Expired));
        assertEq(token.balanceOf(address(core)), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(solver), 0);
        assertEq(token.balanceOf(solver2), 0);
    }

    function test_failedRefundRollsBackCoreStatusAndBalances() public {
        uint256 id = _job();
        _claim(id, solver);
        vm.warp(EXPIRY);
        token.setBlocked(buyer, true);
        vm.expectRevert();
        vm.prank(outsider);
        core.claimRefund(id);
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS - BUDGET);
        token.setBlocked(buyer, false);
        _refund(id);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS);
    }

    function test_directCoreCallsCannotBypassAdapter() public {
        uint256 id = _job();
        bytes32 envelopeHash = sha256(ENVELOPE);
        address[4] memory callers = [buyer, solver, outsider, address(this)];
        for (uint256 i; i < callers.length; i++) {
            vm.expectRevert();
            vm.prank(callers[i]);
            core.submit(id, envelopeHash, "");
            vm.expectRevert();
            vm.prank(callers[i]);
            core.reject(id, bytes32(0), "");
        }
        _assertUnreserved(id);
        _claim(id, solver);
        for (uint256 i; i < callers.length; i++) {
            vm.expectRevert();
            vm.prank(callers[i]);
            core.complete(id, bytes32(0), "");
            vm.expectRevert();
            vm.prank(callers[i]);
            core.reject(id, bytes32(0), "");
        }
        _assertSubmitted(id, solver);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(solver), 0);
    }

    function testFuzz_exactPayoutForAmountIdentityAndKey(uint96 rawAmount, address candidate, bytes32 key) public {
        uint256 amount = bound(uint256(rawAmount), 1, 1e18);
        vm.assume(
            candidate != address(0) && candidate != buyer && candidate != address(adapter) && candidate != address(core)
                && candidate != address(token) && candidate != treasury
        );
        uint256 id = _funded(amount, EXPIRY);
        _register(id, amount, EXPIRY);
        uint256 priorBalance = token.balanceOf(candidate);
        (bytes memory seal, bytes32 commitment) = _proof(id, candidate, ENVELOPE, key);
        vm.prank(candidate);
        adapter.claim(id, ENVELOPE, seal, commitment);
        vm.prank(candidate);
        adapter.release(id, key);
        assertEq(token.balanceOf(candidate), priorBalance + amount);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS - amount);
        assertEq(token.balanceOf(address(core)), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertTrue(adapter.released(id));
        assertEq(uint256(core.getJob(id).status), uint256(Core.JobStatus.Completed));
    }

    function testFuzz_expiryBoundaryClosesClaimAndRelease(uint32 rawDelay, bool submitted) public {
        uint256 id = _job();
        (bytes memory seal, bytes32 commitment) = _proof(id, solver, ENVELOPE, KEY);
        if (submitted) {
            vm.prank(solver);
            adapter.claim(id, ENVELOPE, seal, commitment);
        }
        uint256 delay = bound(uint256(rawDelay), 0, 30 days);
        vm.warp(uint256(EXPIRY) + delay);
        vm.expectRevert();
        vm.prank(solver);
        adapter.claim(id, ENVELOPE, seal, commitment);
        vm.expectRevert();
        vm.prank(solver);
        adapter.release(id, KEY);
        _refund(id);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS);
    }

    function testFuzz_registrationMargin(uint16 rawRemaining) public {
        uint256 remaining = bound(uint256(rawRemaining), 301, 3600);
        uint64 expiry = uint64(NOW + remaining);
        uint256 id = _funded(BUDGET, expiry);
        if (remaining < 600) {
            _expectRegisterRevert(id, BUDGET, expiry);
            (,,,,,, bool registered) = adapter.terms(id);
            assertFalse(registered);
        } else {
            _register(id, BUDGET, expiry);
            (,,,,,, bool registered) = adapter.terms(id);
            assertTrue(registered);
        }
        _assertUnreserved(id);
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(buyer), BUYER_FUNDS - BUDGET);
    }
}
