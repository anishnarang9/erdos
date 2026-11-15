// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettlementScript} from "../../script/00_Config.s.sol";
import {DeployVerifier} from "../../script/01_DeployVerifier.s.sol";
import {DeployCoreImpl} from "../../script/02_DeployCoreImpl.s.sol";
import {DeployCoreProxy} from "../../script/03_DeployCoreProxy.s.sol";
import {DeployHook} from "../../script/04_DeployHook.s.sol";
import {Freeze} from "../../script/05_Freeze.s.sol";
import {VerifyDeployment} from "../../script/06_Verify.s.sol";
import {DeployLocal} from "../../script/DeployLocal.s.sol";
import {AgenticCommerce} from "../../src/core/src/AgenticCommercePatched.sol";
import {RiscZeroGroth16Verifier} from "../../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {MockRiscZeroVerifier} from "../../src/verifier/MockRiscZeroVerifier.sol";
import {SettlementHook} from "../../src/SettlementHook.sol";
import {SettlementCodec} from "../../src/SettlementCodec.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Executes the deploy scripts in-process and asserts their post-conditions. This stands in
///         for a `--broadcast` run against anvil, which this session may not perform.
///
///         `vm.startBroadcast()` inside a test is not a real broadcast: the scripts run against the
///         test EVM, `_broadcasting()` is false, so they never write a manifest. Test 2 therefore
///         hands addresses from step to step by writing the manifest file by hand, exactly the
///         file the live scripts would write.
contract DeployScriptsTest is Test {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    string constant TEST_MANIFEST = "deployments/dryrun-test.json";

    /// @dev One test function, run in order: the scripts read process-wide environment variables
    ///      (`SETTLEMENT_*`) and a shared manifest file, and forge runs test functions in parallel,
    ///      so separate tests would race. Each section resets the state it touches.
    function test_deployScripts() public {
        _arcModeRefusesWrongChain();
        _localModeRefusesNonAnvilChain();
        vm.chainId(31337);
        _localSequenceDeploysFrozenSystemThatSettles();
        _verifyDetectsWrongImplementationBytecode();
        _arcModeStepByStepThroughManifest();
    }

    function _manifestPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/", TEST_MANIFEST);
    }

    function _template() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/deployments/arc-testnet.json"));
    }

    // ───────────── Local mode: DeployLocal, then a full job on the deployed contracts ─────────────

    function _localSequenceDeploysFrozenSystemThatSettles() internal {
        vm.chainId(31337);
        vm.setEnv("SETTLEMENT_LOCAL", "1");
        SettlementScript.Deployment memory d = new DeployLocal().run();

        AgenticCommerce core = AgenticCommerce(d.core);
        SettlementHook hook = SettlementHook(d.hook);

        // Post-conditions the script already asserted, re-checked from outside.
        assertTrue(core.whitelistedHooks(d.hook));
        assertFalse(core.hasRole(core.ADMIN_ROLE(), d.deployer));
        assertFalse(core.hasRole(core.DEFAULT_ADMIN_ROLE(), d.deployer));
        assertEq(core.platformFeeBP(), 0);
        assertEq(core.evaluatorFeeBP(), 0);
        assertEq(address(core.paymentToken()), d.usdc);
        assertTrue(hook.supportsInterface(0x7ff6bc9e));
        assertEq(hook.MAX_ENVELOPE_BYTES(), 16384);
        assertEq(hook.MIN_EXPIRY_MARGIN(), 120);

        // The frozen admin surface reverts for the former admin.
        vm.startPrank(d.deployer);
        vm.expectRevert();
        core.setHookWhitelist(address(0xdead), true);
        vm.expectRevert();
        core.setPlatformFee(1, d.deployer);
        vm.expectRevert();
        core.setEvaluatorFee(1);
        vm.expectRevert();
        core.upgradeToAndCall(address(0xdead), "");
        vm.stopPrank();

        _settle(d);
    }

    bytes32 constant IMAGE_ID = bytes32(uint256(0xabc));
    bytes32 constant RULES = bytes32(uint256(0x33));
    bytes32 constant REF = bytes32(uint256(0x44));
    bytes32 constant KEY = bytes32(uint256(0x55));

    /// @dev End to end on the deployed system: Poster funds, Solver submits and releases.
    function _settle(SettlementScript.Deployment memory d) internal {
        AgenticCommerce core = AgenticCommerce(d.core);
        SettlementHook hook = SettlementHook(d.hook);
        MockUSDC usdc = MockUSDC(d.usdc);
        address poster = makeAddr("poster");
        address solver = makeAddr("solver");
        usdc.mint(poster, 5e6);

        vm.prank(poster);
        uint256 jobId = core.createJob(solver, d.hook, block.timestamp + 900, "demo", d.hook);
        // Patched core: the Solver cannot set the price, the Poster can.
        vm.prank(solver);
        vm.expectRevert(AgenticCommerce.Unauthorized.selector);
        core.setBudget(jobId, 1e6, "");
        vm.startPrank(poster);
        core.setBudget(jobId, 1e6, "");
        usdc.approve(d.core, 1e6);
        core.fund(jobId, abi.encode(IMAGE_ID, RULES, REF));
        vm.stopPrank();

        bytes memory envelope = hex"c0ffee";
        bytes32 kc = SettlementCodec.keyCommitment(hook.contextOf(jobId), KEY);
        (, bytes32 digest) = hook.expectedJournal(jobId, sha256(envelope), kc);
        MockRiscZeroVerifier(d.verifier).expect(hex"0102", IMAGE_ID, digest);
        bytes32 envHash = sha256(envelope);
        bytes memory optParams = abi.encode(envelope, hex"0102", kc);
        vm.prank(solver);
        core.submit(jobId, envHash, optParams);
        vm.prank(solver);
        hook.release(jobId, KEY);
        assertEq(usdc.balanceOf(solver), 1e6);
        assertEq(usdc.balanceOf(d.core), 0);
    }

    function _localModeRefusesNonAnvilChain() internal {
        vm.setEnv("SETTLEMENT_LOCAL", "1");
        vm.chainId(5042002);
        DeployLocal s = new DeployLocal();
        vm.expectRevert(bytes("SETTLEMENT_LOCAL=1 requires chain ID 31337"));
        s.run();
    }

    function _arcModeRefusesWrongChain() internal {
        vm.setEnv("SETTLEMENT_LOCAL", "false");
        vm.chainId(1);
        DeployVerifier s = new DeployVerifier();
        vm.expectRevert(bytes("chain ID does not match config/arc-testnet.json chainId"));
        s.run();
    }

    // ───────────── Arc mode: scripts 01 to 05 one at a time through a manifest, then 06 ─────────────

    function _arcModeStepByStepThroughManifest() internal {
        vm.setEnv("SETTLEMENT_LOCAL", "false");
        vm.setEnv("SETTLEMENT_MANIFEST", _manifestPath());
        vm.chainId(5042002);
        vm.etch(ARC_USDC, address(new MockUSDC()).code); // stands in for Arc USDC (6 decimals)
        vm.writeFile(_manifestPath(), _template());

        address verifier = new DeployVerifier().run();
        assertEq(RiscZeroGroth16Verifier(verifier).SELECTOR(), bytes4(0xe71e6620));
        assertEq(RiscZeroGroth16Verifier(verifier).VERSION(), "3.1.0");
        _put(".contracts.verifier.address", verifier);

        address impl = new DeployCoreImpl().run();
        _put(".contracts.coreImplementation.address", impl);

        address core = new DeployCoreProxy().run();
        _put(".contracts.core.address", core);
        // The signer of the broadcast (the test's default sender) is the admin before the freeze.
        address admin = _adminOf(core);
        assertTrue(AgenticCommerce(core).hasRole(AgenticCommerce(core).DEFAULT_ADMIN_ROLE(), admin));
        _put(".deployer", admin);

        address hook = new DeployHook().run();
        assertEq(address(SettlementHook(hook).core()), core);
        assertEq(address(SettlementHook(hook).verifier()), verifier);
        _put(".contracts.hook.address", hook);

        // Read-only verifier script passes before the freeze, and the frozen check fails before it.
        new VerifyDeployment().run();
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "true");
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert();
        v.run();

        new Freeze().run();
        assertTrue(AgenticCommerce(core).whitelistedHooks(hook));

        // After the freeze: verify passes with the freeze check, and re-running 05 is a no-op check.
        new VerifyDeployment().run();
        new Freeze().run();
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");

        // Idempotence: a second run of any deploy step refuses while the manifest address has code.
        DeployVerifier again = new DeployVerifier();
        vm.expectRevert(bytes("already deployed; set SETTLEMENT_ALLOW_REDEPLOY=1 to override"));
        again.run();
        vm.setEnv("SETTLEMENT_ALLOW_REDEPLOY", "true");
        address second = new DeployVerifier().run();
        assertTrue(second != verifier);
        vm.setEnv("SETTLEMENT_ALLOW_REDEPLOY", "false");

        vm.removeFile(_manifestPath());
    }

    function _verifyDetectsWrongImplementationBytecode() internal {
        vm.setEnv("SETTLEMENT_LOCAL", "false");
        vm.setEnv("SETTLEMENT_MANIFEST", _manifestPath());
        vm.chainId(5042002);
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        vm.writeFile(_manifestPath(), _template());

        // An unrelated UUPS-looking contract is not the patched build.
        address bogus = address(new FakeUUPS());
        _put(".contracts.coreImplementation.address", bogus);
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert(bytes("implementation bytecode != local patched build"));
        v.run();
        vm.removeFile(_manifestPath());
    }

    // ───────────── helpers ─────────────

    function _put(string memory key, address a) internal {
        vm.writeJson(string.concat('"', vm.toString(a), '"'), _manifestPath(), key);
    }

    function _adminOf(address core) internal view returns (address) {
        // The step-3 treasury defaults to the signer, so it identifies the admin.
        return AgenticCommerce(core).platformTreasury();
    }
}

contract FakeUUPS {
    function proxiableUUID() external pure returns (bytes32) {
        return 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    }
}
