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
    uint256 constant MAX_ENVELOPE = 16412; // team cap: 16,384 bundle + 12 nonce + 16 tag

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
        _hookStepRejectsMockVerifierOnArc();
        _freezeRequiresNoOtherAdmin();
        _verifyChecksHistoryAndCodeHashes();
    }

    function _manifestPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/", TEST_MANIFEST);
    }

    function _template() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/deployments/arc-testnet.json"));
    }

    /// @dev The Arc manifest as a test manifest, minus what describes the LIVE contracts and would
    ///      not match the ones this test deploys: the runtime code-hash pins and the evidence block.
    function _writeTemplate() internal {
        vm.writeFile(_manifestPath(), _template());
        _clearPins();
        vm.writeJson("null", _manifestPath(), ".evidence");
    }

    function _clearPins() internal {
        vm.writeJson("null", _manifestPath(), ".contracts.verifier.runtimeCodeHash");
        vm.writeJson("null", _manifestPath(), ".contracts.coreImplementation.runtimeCodeHash");
        vm.writeJson("null", _manifestPath(), ".contracts.hook.runtimeCodeHash");
        vm.writeJson("null", _manifestPath(), ".contracts.core.runtimeCodeHash");
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
        assertEq(hook.MAX_ENVELOPE_BYTES(), MAX_ENVELOPE);
        assertEq(vm.parseJsonUint(vm.readFile("config/arc-testnet.json"), ".hook.maxEnvelopeBytes"), MAX_ENVELOPE);
        assertEq(hook.MIN_EXPIRY_MARGIN(), vm.parseJsonUint(vm.readFile("config/arc-testnet.json"), ".hook.minExpiryMarginSeconds"));

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
        _writeTemplate();

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

        // A manifest address with no code fails 06 loudly, and is not "already deployed" for 04.
        _put(".contracts.hook.address", address(0xBEEF));
        VerifyDeployment noCode = new VerifyDeployment();
        vm.expectRevert(bytes("hook: manifest address has no code: reset the entry or rerun the step"));
        noCode.run();
        address hookAgain = new DeployHook().run();
        assertTrue(hookAgain.code.length != 0);
        _put(".contracts.hook.address", hook);

        // Read-only verifier script passes before the freeze, and the frozen check fails before it.
        new VerifyDeployment().run();
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "true");
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert();
        v.run();

        // Whitelist-only: the hook is whitelisted, but nobody renounces anything.
        AgenticCommerce k = AgenticCommerce(core);
        assertFalse(k.whitelistedHooks(hook));
        vm.setEnv("SETTLEMENT_WHITELIST_ONLY", "true");
        new Freeze().run();
        assertTrue(k.whitelistedHooks(hook));
        assertTrue(k.whitelistedHooks(address(0)));
        assertTrue(k.hasRole(k.ADMIN_ROLE(), admin));
        assertTrue(k.hasRole(k.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(k.platformFeeBP(), 0);
        assertEq(k.evaluatorFeeBP(), 0);
        new Freeze().run(); // idempotent: whitelist already set is skipped, roles still held
        assertTrue(k.hasRole(k.ADMIN_ROLE(), admin));
        // 06 without EXPECT_FROZEN reports the whitelist and passes; with it, it still fails (not frozen).
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");
        new VerifyDeployment().run();
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "true");
        VerifyDeployment notFrozen = new VerifyDeployment();
        vm.expectRevert();
        notFrozen.run();
        // Default 05 (flag off) is the full freeze; it resumes from the whitelisted state.
        vm.setEnv("SETTLEMENT_WHITELIST_ONLY", "false");
        new Freeze().run();
        assertTrue(k.whitelistedHooks(hook));
        assertFalse(k.hasRole(k.ADMIN_ROLE(), admin));
        assertFalse(k.hasRole(k.DEFAULT_ADMIN_ROLE(), admin));
        // Whitelist-only after the freeze refuses instead of pretending the core is unfrozen.
        vm.setEnv("SETTLEMENT_WHITELIST_ONLY", "true");
        Freeze afterFreeze = new Freeze();
        vm.expectRevert(bytes("signer lacks an admin role: wrong account, or the core is already frozen"));
        afterFreeze.run();
        vm.setEnv("SETTLEMENT_WHITELIST_ONLY", "false");

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
        _writeTemplate();

        // The template may carry live addresses that have no code in this EVM: deploy a real verifier.
        _put(".contracts.verifier.address", new DeployVerifier().run());
        // An unrelated UUPS-looking contract is not the patched build.
        address bogus = address(new FakeUUPS());
        _put(".contracts.coreImplementation.address", bogus);
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert(bytes("implementation bytecode != local patched build"));
        v.run();
        vm.removeFile(_manifestPath());
    }

    function _hookStepRejectsMockVerifierOnArc() internal {
        vm.setEnv("SETTLEMENT_LOCAL", "false");
        vm.setEnv("SETTLEMENT_MANIFEST", _manifestPath());
        vm.chainId(5042002);
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        _writeTemplate();
        _put(".contracts.verifier.address", address(new MockRiscZeroVerifier()));
        address impl = new DeployCoreImpl().run();
        _put(".contracts.coreImplementation.address", impl);
        _put(".contracts.core.address", new DeployCoreProxy().run());
        DeployHook h = new DeployHook();
        vm.expectRevert();
        h.run();
        // 06_Verify refuses the same manifest.
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert();
        v.run();
        vm.removeFile(_manifestPath());
    }

    // ───────────── Freeze means NO admin, not only "the deployer renounced" ─────────────
    //
    // There is no RPC in this test, so the admin-role replay reads the session log buffer. Each
    // scenario calls `vm.recordLogs()` right before deploying a fresh core (`_freshCore`). A script
    // run drains the buffer, so each scenario runs at most one replaying script per buffer that must
    // see the grants (a later run only sees later events, which is still sound: holders are
    // re-confirmed with hasRole and the deployer is always a candidate).

    function _freezeRequiresNoOtherAdmin() internal {
        vm.setEnv("SETTLEMENT_LOCAL", "false");
        vm.setEnv("SETTLEMENT_MANIFEST", _manifestPath());
        vm.setEnv("SETTLEMENT_WHITELIST_ONLY", "false");
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");
        vm.setEnv("SETTLEMENT_ALLOW_REDEPLOY", "true"); // one fresh core and hook per scenario
        vm.chainId(5042002);
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        _writeTemplate();
        _put(".contracts.verifier.address", new DeployVerifier().run());
        _put(".contracts.coreImplementation.address", new DeployCoreImpl().run());

        bytes32 adminRole = keccak256("ADMIN_ROLE");
        bytes32 defaultAdmin = bytes32(0);
        _secondAdminBlocksFreeze(adminRole, "ADMIN_ROLE");
        _secondAdminBlocksFreeze(defaultAdmin, "DEFAULT_ADMIN_ROLE");
        _replayReportsHistoryAndHolders();
        _grantThenRevokeStillFreezes();
        _plainFreezeStillPasses();

        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");
        vm.setEnv("SETTLEMENT_ALLOW_REDEPLOY", "false");
        vm.removeFile(_manifestPath());
    }

    /// @dev The deployer grants `role` to a second address. (a) 05 refuses before renouncing.
    ///      (b) If the deployer renounces by hand anyway, 06 with EXPECT_FROZEN fails, although the
    ///      deployer itself holds no role (the old deployer-only check passed here).
    function _secondAdminBlocksFreeze(bytes32 role, string memory name) internal {
        address other = makeAddr(string.concat("second ", name));

        // (a) 05 refuses; nothing is renounced.
        (address core,, address admin) = _freshCore();
        AgenticCommerce k = AgenticCommerce(core);
        vm.prank(admin);
        k.grantRole(role, other);
        Freeze f = new Freeze();
        vm.expectRevert(
            bytes(
                string.concat(
                    "freeze refused: ",
                    vm.toString(other),
                    " also holds ",
                    name,
                    "; renouncing the signer's roles would not freeze the core. Revoke it first."
                )
            )
        );
        f.run();
        assertTrue(k.hasRole(k.ADMIN_ROLE(), admin));
        assertTrue(k.hasRole(k.DEFAULT_ADMIN_ROLE(), admin));

        // (b) Manual "freeze" that leaves the second admin in place.
        address hook;
        (core, hook, admin) = _freshCore();
        k = AgenticCommerce(core);
        vm.startPrank(admin);
        k.grantRole(role, other);
        k.setHookWhitelist(hook, true);
        k.renounceRole(k.ADMIN_ROLE(), admin);
        k.renounceRole(k.DEFAULT_ADMIN_ROLE(), admin);
        vm.stopPrank();
        assertFalse(k.hasRole(k.ADMIN_ROLE(), admin));
        assertFalse(k.hasRole(k.DEFAULT_ADMIN_ROLE(), admin));
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "true");
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert(bytes(string.concat(name, " still held by ", vm.toString(other), ": core not frozen")));
        v.run();
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");
    }

    /// @dev The helper itself: full grant/revoke history, current holders, former holders, JSON.
    function _replayReportsHistoryAndHolders() internal {
        address other = makeAddr("replay other");
        (address core,, address admin) = _freshCore();
        AgenticCommerce k = AgenticCommerce(core);
        vm.startPrank(admin);
        k.grantRole(k.ADMIN_ROLE(), other);
        k.grantRole(k.DEFAULT_ADMIN_ROLE(), other);
        k.revokeRole(k.ADMIN_ROLE(), other);
        vm.stopPrank();

        RoleReplayHarness h = new RoleReplayHarness();
        SettlementScript.RoleEvent[] memory ev = h.history(core);
        assertEq(ev.length, 5);
        // initialize(): DEFAULT_ADMIN_ROLE then ADMIN_ROLE to the admin.
        assertEq(ev[0].role, k.DEFAULT_ADMIN_ROLE());
        assertEq(ev[0].account, admin);
        assertTrue(ev[0].granted);
        assertEq(ev[1].role, k.ADMIN_ROLE());
        assertEq(ev[2].account, other);
        assertEq(ev[2].sender, admin);
        assertTrue(ev[2].granted);
        assertEq(ev[4].role, k.ADMIN_ROLE());
        assertEq(ev[4].account, other);
        assertFalse(ev[4].granted);
        assertFalse(ev[4].onChain); // session event: no block or tx hash yet
        // Drained events are kept by the script instance: a second read sees the same history.
        assertEq(h.history(core).length, 5);

        SettlementScript.RoleHolder[] memory hs = h.holders(core, ev, address(0));
        assertEq(hs.length, 3);
        assertTrue(_holds(hs, k.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(_holds(hs, k.ADMIN_ROLE(), admin));
        assertTrue(_holds(hs, k.DEFAULT_ADMIN_ROLE(), other));
        assertFalse(_holds(hs, k.ADMIN_ROLE(), other));

        address[] memory former = h.everHeld(ev);
        assertEq(former.length, 2);
        assertEq(former[0], admin);
        assertEq(former[1], other);

        string memory json = h.json(ev);
        assertEq(vm.parseJsonString(json, "$[4].event"), "RoleRevoked");
        assertEq(vm.parseJsonAddress(json, "$[2].account"), other);
    }

    /// @dev A second admin that was revoked again does not block the freeze, and is probed.
    function _grantThenRevokeStillFreezes() internal {
        address other = makeAddr("revoked admin");
        (address core,, address admin) = _freshCore();
        AgenticCommerce k = AgenticCommerce(core);
        vm.startPrank(admin);
        k.grantRole(k.ADMIN_ROLE(), other);
        k.grantRole(k.DEFAULT_ADMIN_ROLE(), other);
        k.revokeRole(k.ADMIN_ROLE(), other);
        k.revokeRole(k.DEFAULT_ADMIN_ROLE(), other);
        vm.stopPrank();
        new Freeze().run();
        assertFalse(k.hasRole(k.ADMIN_ROLE(), admin));
        assertFalse(k.hasRole(k.DEFAULT_ADMIN_ROLE(), admin));
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "true");
        new VerifyDeployment().run();
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");
    }

    function _plainFreezeStillPasses() internal {
        (address core, address hook, address admin) = _freshCore();
        AgenticCommerce k = AgenticCommerce(core);
        new Freeze().run();
        assertTrue(k.whitelistedHooks(hook));
        assertFalse(k.hasRole(k.ADMIN_ROLE(), admin));
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "true");
        new VerifyDeployment().run();
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");
    }

    /// @dev Starts log recording, then deploys a fresh core proxy and hook through steps 03 and 04.
    function _freshCore() internal returns (address core, address hook, address admin) {
        vm.recordLogs();
        core = new DeployCoreProxy().run();
        _put(".contracts.core.address", core);
        admin = _adminOf(core);
        _put(".deployer", admin);
        hook = new DeployHook().run();
        _put(".contracts.hook.address", hook);
    }

    function _holds(SettlementScript.RoleHolder[] memory hs, bytes32 role, address a) internal pure returns (bool) {
        for (uint256 i = 0; i < hs.length; i++) {
            if (hs[i].role == role && hs[i].account == a) return true;
        }
        return false;
    }

    // ───────────── 06: whitelist history, upgrade history, code-hash pins, evidence ─────────────
    //
    // Same session-log setup as above (`_freshCore` starts recording). A script run drains the
    // buffer even when it reverts (cheatcode state is not rolled back), so each scenario that must
    // see the full history gets its own fresh core and runs 06 once.

    function _verifyChecksHistoryAndCodeHashes() internal {
        vm.setEnv("SETTLEMENT_LOCAL", "false");
        vm.setEnv("SETTLEMENT_MANIFEST", _manifestPath());
        vm.setEnv("SETTLEMENT_WHITELIST_ONLY", "false");
        vm.setEnv("SETTLEMENT_EXPECT_FROZEN", "false");
        vm.setEnv("SETTLEMENT_WRITE_EVIDENCE", "false");
        vm.setEnv("SETTLEMENT_ALLOW_REDEPLOY", "true");
        vm.chainId(5042002);
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        _writeTemplate();
        _put(".contracts.verifier.address", new DeployVerifier().run());
        _put(".contracts.coreImplementation.address", new DeployCoreImpl().run());

        _extraWhitelistedHookFails();
        _upgradeFails();
        _codeHashPins();
        _evidenceWrite();

        vm.setEnv("SETTLEMENT_ALLOW_REDEPLOY", "false");
        vm.removeFile(_manifestPath());
    }

    /// @dev A second hook still whitelisted fails 06; one that was whitelisted and removed again
    ///      does not.
    function _extraWhitelistedHookFails() internal {
        address stray = makeAddr("stray hook");
        (address core, address hook, address admin) = _freshCore();
        AgenticCommerce k = AgenticCommerce(core);
        vm.startPrank(admin);
        k.setHookWhitelist(hook, true);
        k.setHookWhitelist(stray, true);
        vm.stopPrank();
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert(
            bytes(string.concat("hook whitelist: ", vm.toString(stray), " is whitelisted but is not the manifest hook"))
        );
        v.run();

        (core, hook, admin) = _freshCore();
        k = AgenticCommerce(core);
        vm.startPrank(admin);
        k.setHookWhitelist(hook, true);
        k.setHookWhitelist(stray, true);
        k.setHookWhitelist(stray, false);
        vm.stopPrank();
        new VerifyDeployment().run();
    }

    /// @dev Upgrading away and back leaves the slot equal to the manifest, but the extra Upgraded
    ///      events still fail 06.
    function _upgradeFails() internal {
        (address core,, address admin) = _freshCore();
        AgenticCommerce k = AgenticCommerce(core);
        address impl = address(uint160(uint256(vm.load(core, bytes32(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))));
        address impl2 = address(new AgenticCommerce());
        vm.startPrank(admin);
        k.upgradeToAndCall(impl2, "");
        k.upgradeToAndCall(impl, "");
        vm.stopPrank();
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert(bytes("core proxy was upgraded after deployment: 3 Upgraded events"));
        v.run();
    }

    /// @dev Correct pins pass; one wrong pin fails with both hashes in the message.
    function _codeHashPins() internal {
        (address core, address hook,) = _freshCore();
        address verifier = _get(".contracts.verifier.address");
        address impl = _get(".contracts.coreImplementation.address");
        _pin(".contracts.verifier.runtimeCodeHash", keccak256(verifier.code));
        _pin(".contracts.coreImplementation.runtimeCodeHash", keccak256(impl.code));
        _pin(".contracts.hook.runtimeCodeHash", keccak256(hook.code));
        _pin(".contracts.core.runtimeCodeHash", keccak256(core.code));
        new VerifyDeployment().run();

        bytes32 wrong = keccak256("not the verifier");
        _pin(".contracts.verifier.runtimeCodeHash", wrong);
        VerifyDeployment v = new VerifyDeployment();
        vm.expectRevert(
            bytes(
                string.concat(
                    "verifier: runtime code hash ",
                    vm.toString(keccak256(verifier.code)),
                    " != manifest runtimeCodeHash ",
                    vm.toString(wrong)
                )
            )
        );
        v.run();

        _pin(".contracts.verifier.runtimeCodeHash", keccak256(verifier.code));
        _pin(".contracts.core.runtimeCodeHash", wrong);
        v = new VerifyDeployment();
        vm.expectRevert(
            bytes(
                string.concat(
                    "core: runtime code hash ", vm.toString(keccak256(core.code)), " != manifest runtimeCodeHash ", vm.toString(wrong)
                )
            )
        );
        v.run();
        _clearPins();
    }

    /// @dev Without the flag 06 leaves the manifest byte for byte; with it, `evidence` holds the
    ///      replayed history, holders, fees and code hashes, and nothing else changes.
    function _evidenceWrite() internal {
        address other = makeAddr("evidence other");
        (address core, address hook, address admin) = _freshCore();
        AgenticCommerce k = AgenticCommerce(core);
        address verifier = _get(".contracts.verifier.address");
        address impl = _get(".contracts.coreImplementation.address");
        vm.startPrank(admin);
        k.setHookWhitelist(hook, true);
        k.grantRole(k.ADMIN_ROLE(), other);
        k.revokeRole(k.ADMIN_ROLE(), other);
        vm.stopPrank();
        _pin(".contracts.verifier.runtimeCodeHash", keccak256(verifier.code));

        // Without the flag: no write (this run drains the session logs, so the core is fresh below).
        string memory before = vm.readFile(_manifestPath());
        new VerifyDeployment().run();
        assertEq(vm.readFile(_manifestPath()), before);

        (core, hook, admin) = _freshCore();
        k = AgenticCommerce(core);
        vm.startPrank(admin);
        k.setHookWhitelist(hook, true);
        k.grantRole(k.ADMIN_ROLE(), other);
        k.revokeRole(k.ADMIN_ROLE(), other);
        vm.stopPrank();

        vm.setEnv("SETTLEMENT_WRITE_EVIDENCE", "true");
        new VerifyDeployment().run();
        vm.setEnv("SETTLEMENT_WRITE_EVIDENCE", "false");

        string memory m = vm.readFile(_manifestPath());
        assertEq(vm.parseJsonString(m, ".evidence.generatedBy"), "script/06_Verify.s.sol");
        assertEq(vm.parseJsonUint(m, ".evidence.chainId"), 5042002);
        assertEq(vm.parseJsonUint(m, ".evidence.block"), block.number);
        assertEq(vm.parseJsonUint(m, ".evidence.blockTimestamp"), block.timestamp);
        assertEq(vm.parseJsonUint(m, ".evidence.maxLogBlockRange"), 10000);
        assertTrue(vm.keyExistsJson(m, ".evidence.replayFromBlock"));
        // Roles: initialize's two grants, then grant and revoke of `other`.
        assertEq(vm.parseJsonString(m, ".evidence.roles.history[0].event"), "RoleGranted");
        assertEq(vm.parseJsonString(m, ".evidence.roles.history[0].role"), "DEFAULT_ADMIN_ROLE");
        assertEq(vm.parseJsonAddress(m, ".evidence.roles.history[0].account"), admin);
        assertEq(vm.parseJsonString(m, ".evidence.roles.history[1].role"), "ADMIN_ROLE");
        assertEq(vm.parseJsonAddress(m, ".evidence.roles.history[2].account"), other);
        assertEq(vm.parseJsonString(m, ".evidence.roles.history[3].event"), "RoleRevoked");
        assertFalse(vm.parseJsonBool(m, ".evidence.roles.history[3].onChain"));
        assertFalse(vm.keyExistsJson(m, ".evidence.roles.history[4]"));
        assertEq(vm.parseJsonAddress(m, ".evidence.roles.currentHolders[0].account"), admin);
        assertEq(vm.parseJsonAddress(m, ".evidence.roles.currentHolders[1].account"), admin);
        assertFalse(vm.keyExistsJson(m, ".evidence.roles.currentHolders[2]"));
        assertFalse(vm.parseJsonBool(m, ".evidence.roles.noAdminHolders"));
        // Whitelist and upgrades.
        assertEq(vm.parseJsonAddress(m, ".evidence.hookWhitelist.history[0].hook"), hook);
        assertTrue(vm.parseJsonBool(m, ".evidence.hookWhitelist.history[0].status"));
        assertFalse(vm.keyExistsJson(m, ".evidence.hookWhitelist.history[1]"));
        assertEq(vm.parseJsonAddress(m, ".evidence.hookWhitelist.whitelistedNow[0]"), hook);
        assertEq(vm.parseJsonAddress(m, ".evidence.upgrades.history[0].implementation"), impl);
        assertFalse(vm.keyExistsJson(m, ".evidence.upgrades.history[1]"));
        assertEq(vm.parseJsonAddress(m, ".evidence.upgrades.implementationSlot"), impl);
        // Fees and code hashes.
        assertEq(vm.parseJsonUint(m, ".evidence.fees.platformFeeBP"), 0);
        assertEq(vm.parseJsonUint(m, ".evidence.fees.evaluatorFeeBP"), 0);
        assertEq(vm.parseJsonAddress(m, ".evidence.runtimeCode.verifier.address"), verifier);
        assertEq(vm.parseJsonBytes32(m, ".evidence.runtimeCode.verifier.runtimeCodeHash"), keccak256(verifier.code));
        assertEq(vm.parseJsonUint(m, ".evidence.runtimeCode.verifier.runtimeCodeSize"), verifier.code.length);
        assertTrue(vm.parseJsonBool(m, ".evidence.runtimeCode.verifier.matchesManifestPin"));
        assertEq(vm.parseJsonBytes32(m, ".evidence.runtimeCode.coreImplementation.runtimeCodeHash"), keccak256(impl.code));
        assertEq(vm.parseJsonBytes32(m, ".evidence.runtimeCode.hook.runtimeCodeHash"), keccak256(hook.code));
        assertEq(vm.parseJsonBytes32(m, ".evidence.runtimeCode.core.runtimeCodeHash"), keccak256(core.code));
        assertEq(vm.parseJsonUint(m, ".evidence.runtimeCode.core.runtimeCodeSize"), core.code.length);
        // The rest of the manifest is untouched.
        assertEq(vm.parseJsonAddress(m, ".contracts.hook.address"), hook);
        assertEq(vm.parseJsonUint(m, ".schemaVersion"), 1);
        assertEq(vm.parseJsonUint(m, ".chain.maxLogBlockRange"), 10000);
        _clearPins();
    }

    // ───────────── helpers ─────────────

    function _get(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile(_manifestPath()), key);
    }

    function _pin(string memory key, bytes32 h) internal {
        vm.writeJson(string.concat('"', vm.toString(h), '"'), _manifestPath(), key);
    }

    function _put(string memory key, address a) internal {
        vm.writeJson(string.concat('"', vm.toString(a), '"'), _manifestPath(), key);
    }

    function _adminOf(address core) internal view returns (address) {
        // The step-3 treasury defaults to the signer, so it identifies the admin.
        return AgenticCommerce(core).platformTreasury();
    }
}

/// @dev Exposes the admin-role replay helpers of the shared script base.
contract RoleReplayHarness is SettlementScript {
    function history(address core) external returns (RoleEvent[] memory) {
        return _roleHistory(core);
    }

    function holders(address core, RoleEvent[] memory ev, address extra) external view returns (RoleHolder[] memory) {
        return _roleHolders(core, ev, extra);
    }

    function everHeld(RoleEvent[] memory ev) external pure returns (address[] memory) {
        return _everHeld(ev);
    }

    function json(RoleEvent[] memory ev) external pure returns (string memory) {
        return _roleHistoryJson(ev);
    }
}

contract FakeUUPS {
    function proxiableUUID() external pure returns (bytes32) {
        return 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    }
}
