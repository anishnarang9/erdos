// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {AgenticCommerce as Core} from "../../src/core/src/AgenticCommercePatched.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {RiscZeroGroth16Verifier} from "../../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {ControlID} from "../../src/verifier/groth16/ControlID.sol";
import {OpenClaimAdapter} from "../../src/OpenClaimAdapter.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// Checked-in real receipts at a synthetic domain. No fresh proof or live deployment.
/// vm.etch places adapter runtime at the fixture domain. Actual core funding and real verification execute.
contract OpenClaimRealReceiptTest is Test {
    address constant DOMAIN = 0x1111111111111111111111111111111111111111;
    address constant SOLVER = 0x2222222222222222222222222222222222222222;
    address constant BUYER = address(0xB0B);
    uint256 constant BUDGET = 1_000_000;
    Core internal core;
    MockUSDC internal token;
    OpenClaimAdapter internal adapter;
    RiscZeroGroth16Verifier internal verifier;
    uint64 internal expiry;
    bytes32 constant IMAGE = 0x7a32b4627f1582cf75136283e767e996f137c3cf5087c9c7a2381ebbb82ece11;
    bytes32 constant RULES = 0xddb14c426ad0aa12aa0734126522a27b38a10e32bd7b930a12c37575ffa4104e;
    bytes32 constant REFERENCE = 0xaa21c0b6ffa196eb88cb407d47551d6695f2624a81c57e499efae120cf687d95;
    bytes32 constant COMMITMENT = 0xf8a4c9208b1bc0bb2e400f5100d3359f81edaa5cb2f2eddeed4fc205a5afb954;
    bytes32 constant FAIL_COMMITMENT = 0x376b5bbd749519f1089599bfe1e67544ff38daadc35aa3bc4cbc72e39c1a894c;
    bytes constant ENVELOPE =
        hex"dfb244239c93b7ecef0e06870c27790f91c767017b9c143a3d083f7f9d7cb170e28ed9d6d1e3fbe4a15e226de408fac70356f9aa7f757ba426433c141beb0a66bf52cfe9a8d88b4bb3a9e803e7ae57a091b80c45663c78eededf13889dac96d70bce76a4";
    bytes constant SEAL =
        hex"e71e66201670a850d713d73ff070650cc2566731c3421f34e4d649fc8be98388ef043b342ff84e6571f14d61da9f64206de176d61e696dca8716c03113112ce270cb22021942934816b0568b17362035ae8399f84f3d5cb998f452546d121259876751e5236fc0d092cdc57d8209c74cf5e996739fcfc29546a711d2cacc4efb5e7611130ee7430268b6715018df6bfcb5a003b5c00ea2b96d369556769d28e2a092a3821adf08f124d82e37e085484ee2919adf5f9648872e72c09c0e19003524c01beb0e56d536af4ab5a75caef19126c7a36181b61f2a1934465659bbc9723e6247ad0edfb77f4e92719e9e10d6ecd825fbfaf2fe63de53a08e7ea33521585c4d0fe4";
    bytes constant JOURNAL =
        hex"0100000000000000000000000000000000000000000000000000000000004cef52111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000072222222222222222222222222222222222222222ddb14c426ad0aa12aa0734126522a27b38a10e32bd7b930a12c37575ffa4104eaa21c0b6ffa196eb88cb407d47551d6695f2624a81c57e499efae120cf687d9501b631ccb869a70e2db78a022b1a708b28542c8a531a42e5ffb578696fda747d34f8a4c9208b1bc0bb2e400f5100d3359f81edaa5cb2f2eddeed4fc205a5afb954";
    bytes constant FAIL_ENVELOPE =
        hex"281aa8cbac1f2bf1e9bb50fc9ad95b7f96b7fea77bc01bac340d2f47fe7bd306395c3ee06b6f0f863fa245a6f2a1d498e6db3cb5ca8e7a2d7a758effb1ff89a7d0ef7250906bca5147eb76839f3c7c4616d0b4b1e3b371b5a6cda841f03276a02d92acfdf6";
    bytes constant FAIL_SEAL =
        hex"e71e66202e3a58821f4fbafd5f29f1e14f07e6e78800d7e68b517f8ece958590918bd93e0de79329c52fd629bb0ac124969c27c5dfaeb9885950754cb50563232f45175d1d43bac09f0edf0bdda9d70d1aaf1bc52366b4933254eb7b1249e172a907e49402ecd368e782f4fd75e9d815da2d903c077fcec7ff93ca2d35df86e27d9e4f520350cff76b5535c6438b2dacaf9198a79b6b74ab2a72d358af77648777f186d60f81dc406761b3f1f04b62e786302a0cc3ae0e1d5941e72661473b7fd8b9d6840ee01f4a12604d3d836cd5da393cad4e4897081b7a449821f3195b7f3e763fbb113aea97da6c0c66b5f9706767c7a5ecfdfe94ab6c1b83bb48e7e722017e170d";

    function setUp() public {
        vm.chainId(5042002);
        vm.warp(1_800_000_000);
        expiry = uint64(block.timestamp + 3600);
        token = new MockUSDC();
        verifier = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID);
        Core implementation = new Core();
        core = Core(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(Core.initialize, (address(token), address(this), address(this)))
                )
            )
        );
        OpenClaimAdapter template = new OpenClaimAdapter(address(core), address(verifier), address(token));
        vm.etch(DOMAIN, address(template).code);
        adapter = OpenClaimAdapter(DOMAIN);
        token.mint(BUYER, BUDGET);
        vm.startPrank(BUYER);
        for (uint256 i = 1; i <= 7; i++) {
            assertEq(core.createJob(DOMAIN, DOMAIN, expiry, "synthetic real receipt", address(0)), i);
        }
        core.setBudget(7, BUDGET, "");
        token.approve(address(core), BUDGET);
        core.fund(7, "");
        adapter.register(7, IMAGE, RULES, REFERENCE, BUDGET, expiry);
        vm.stopPrank();
    }

    function test_checkedInReceiptAcceptsThroughActualCoreAndAdapter() public {
        (bytes memory journal, bytes32 digest) = adapter.expectedJournal(7, SOLVER, sha256(ENVELOPE), COMMITMENT);
        assertEq(journal, JOURNAL);
        assertEq(digest, sha256(JOURNAL));
        verifier.verify(SEAL, IMAGE, digest);
        vm.prank(SOLVER);
        adapter.claim(7, ENVELOPE, SEAL, COMMITMENT);
        (address winner, bytes32 envelopeHash, bytes32 keyCommitment, bool accepted) = adapter.submissions(7);
        assertEq(winner, SOLVER);
        assertEq(envelopeHash, sha256(ENVELOPE));
        assertEq(keyCommitment, COMMITMENT);
        assertTrue(accepted);
        assertEq(uint256(core.getJob(7).status), uint256(Core.JobStatus.Submitted));
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertEq(token.balanceOf(DOMAIN), 0);
        assertEq(token.balanceOf(SOLVER), 0);
    }

    function test_checkedInReceiptRejectsAnotherSolverWithoutReserving() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        adapter.claim(7, ENVELOPE, SEAL, COMMITMENT);
        _assertOpen();
    }

    function test_checkedInVerdictZeroReceiptCannotClaim() public {
        vm.prank(SOLVER);
        vm.expectRevert();
        adapter.claim(7, FAIL_ENVELOPE, FAIL_SEAL, FAIL_COMMITMENT);
        _assertOpen();
    }

    function test_checkedInReceiptRejectsChangedEnvelope() public {
        bytes memory changed = ENVELOPE;
        changed[0] = bytes1(uint8(changed[0]) ^ 1);
        vm.prank(SOLVER);
        vm.expectRevert();
        adapter.claim(7, changed, SEAL, COMMITMENT);
        _assertOpen();
    }

    function test_checkedInReceiptRejectsChangedKeyCommitment() public {
        vm.prank(SOLVER);
        vm.expectRevert();
        adapter.claim(7, ENVELOPE, SEAL, bytes32(uint256(COMMITMENT) ^ 1));
        _assertOpen();
    }

    function test_checkedInReceiptRejectsOtherChain() public {
        vm.chainId(5042003);
        vm.prank(SOLVER);
        vm.expectRevert();
        adapter.claim(7, ENVELOPE, SEAL, COMMITMENT);
        _assertOpen();
    }

    function _assertOpen() internal view {
        (address winner,,, bool accepted) = adapter.submissions(7);
        assertEq(winner, address(0));
        assertFalse(accepted);
        assertEq(uint256(core.getJob(7).status), uint256(Core.JobStatus.Funded));
        assertEq(token.balanceOf(address(core)), BUDGET);
        assertFalse(adapter.released(7));
    }
}
