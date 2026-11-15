// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgenticCommerce} from "../../src/core/src/AgenticCommercePatched.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockRiscZeroVerifier} from "../../src/verifier/MockRiscZeroVerifier.sol";
import {SettlementHook} from "../../src/SettlementHook.sol";
import {SettlementCodec} from "../../src/SettlementCodec.sol";
import {ISettlementCore} from "../../src/interfaces/ISettlementCore.sol";
import {IProofVerifier} from "../../src/interfaces/IProofVerifier.sol";

/// @notice Implementer's smoke test: one happy path and the codec fixture against the hook's own
///         codec. The independent spec-driven matrix (S3 to S15) lives in test/settlement/.
contract HookSmokeTest is Test {
    AgenticCommerce core;
    MockUSDC usdc;
    MockRiscZeroVerifier verifier;
    SettlementHook hook;

    address admin = makeAddr("admin");
    address poster = makeAddr("poster");
    address solver = makeAddr("solver");

    bytes32 constant IMAGE_ID = bytes32(uint256(0xabc));
    bytes32 constant RULES = bytes32(uint256(0x33));
    bytes32 constant REF = bytes32(uint256(0x44));
    bytes32 constant KEY = bytes32(uint256(0x55));

    function setUp() public {
        usdc = new MockUSDC();
        AgenticCommerce impl = new AgenticCommerce();
        core = AgenticCommerce(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(AgenticCommerce.initialize, (address(usdc), admin, admin))
                )
            )
        );
        verifier = new MockRiscZeroVerifier();
        hook = new SettlementHook(
            ISettlementCore(address(core)), IProofVerifier(address(verifier)), address(usdc), 16384, 120
        );
        vm.startPrank(admin);
        core.setHookWhitelist(address(hook), true);
        core.renounceRole(core.ADMIN_ROLE(), admin);
        core.renounceRole(core.DEFAULT_ADMIN_ROLE(), admin);
        vm.stopPrank();
        usdc.mint(poster, 10e6);
    }

    function test_codecFixture() public pure {
        bytes memory ctx = SettlementCodec.context(
            5042002, address(bytes20(hex"1111111111111111111111111111111111111111")), 7,
            address(bytes20(hex"2222222222222222222222222222222222222222")),
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444)
        );
        assertEq(ctx.length, 169);
        bytes32 kc = SettlementCodec.keyCommitment(
            ctx, bytes32(0x5555555555555555555555555555555555555555555555555555555555555555)
        );
        assertEq(kc, 0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d);
        bytes memory j =
            SettlementCodec.journal(ctx, 1, 0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6, kc);
        assertEq(j.length, 234);
        assertEq(sha256(j), 0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e);
    }

    function test_happyPath() public {
        vm.startPrank(poster);
        uint256 jobId = core.createJob(solver, address(hook), block.timestamp + 1 hours, "job", address(hook));
        core.setBudget(jobId, 1e6, "");
        usdc.approve(address(core), 1e6);
        core.fund(jobId, abi.encode(IMAGE_ID, RULES, REF));
        vm.stopPrank();

        bytes memory envelope = hex"deadbeef";
        bytes32 envHash = sha256(envelope);
        bytes32 kc = SettlementCodec.keyCommitment(hook.contextOf(jobId), KEY);
        (, bytes32 digest) = hook.expectedJournal(jobId, envHash, kc);
        bytes memory seal = hex"01";
        verifier.expect(seal, IMAGE_ID, digest);

        vm.prank(solver);
        core.submit(jobId, envHash, abi.encode(envelope, seal, kc));
        (,, bool accepted) = hook.submissions(jobId);
        assertTrue(accepted);

        vm.prank(solver);
        hook.release(jobId, KEY);
        assertEq(usdc.balanceOf(solver), 1e6);
        assertTrue(hook.released(jobId));
        assertEq(uint8(core.getJob(jobId).status), uint8(AgenticCommerce.JobStatus.Completed));
    }
}
