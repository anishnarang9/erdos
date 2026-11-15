// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettlementScript} from "../../script/00_Config.s.sol";
import {DeployLocal} from "../../script/DeployLocal.s.sol";
import {CreateTestJob} from "../../script/08_CreateTestJob.s.sol";
import {AgenticCommerce} from "../../src/core/src/AgenticCommercePatched.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SettlementHook} from "../../src/SettlementHook.sol";
import {ISettlementCore} from "../../src/interfaces/ISettlementCore.sol";
import {IProofVerifier} from "../../src/interfaces/IProofVerifier.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Local-mode harnesses. Overriding `_isLocal` and `_manifestPath` keeps this suite independent of
///      the process-wide `SETTLEMENT_LOCAL` and `SETTLEMENT_MANIFEST` variables that Deploy.t.sol
///      toggles while forge runs suites in parallel.
contract LocalDeployHarness is DeployLocal {
    string internal manifest;

    constructor(string memory m) {
        manifest = m;
    }

    function _isLocal() internal pure override returns (bool) {
        return true;
    }

    function _manifestPath() internal view override returns (string memory) {
        return manifest;
    }
}

contract LocalCreateTestJobHarness is CreateTestJob {
    string internal manifest;

    constructor(string memory m) {
        manifest = m;
    }

    function _isLocal() internal pure override returns (bool) {
        return true;
    }

    function _manifestPath() internal view override returns (string memory) {
        return manifest;
    }
}

/// @notice Runs `08_CreateTestJob.s.sol` in-process against a local-mode deployment (mock USDC and
///         mock verifier, frozen core) and asserts its pre-checks and post-conditions. `vm.startBroadcast()`
///         inside a test is not a real broadcast, so the manifest write is checked by writing the
///         script's own JSON to a copy of the manifest template.
///
///         One test function, run in order: sections share env variables and a manifest file.
contract CreateTestJobScriptTest is Test {
    string constant MANIFEST = "deployments/createtestjob-test.json";

    bytes32 constant IMAGE_ID = bytes32(uint256(0xabc));
    bytes32 constant RULES = bytes32(uint256(0x33));
    bytes32 constant REF = bytes32(uint256(0x44));

    SettlementScript.Deployment internal d;
    address internal poster;
    address internal provider = address(0x2222222222222222222222222222222222222222);

    function _mp() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/", MANIFEST);
    }

    function _put(string memory key, address a) internal {
        vm.writeJson(string.concat('"', vm.toString(a), '"'), _mp(), key);
    }

    function _env(address who, bytes32 image) internal {
        vm.setEnv("SETTLEMENT_TEST_PROVIDER", vm.toString(who));
        vm.setEnv("SETTLEMENT_TEST_IMAGE_ID", vm.toString(image));
        vm.setEnv("SETTLEMENT_TEST_RULES_HASH", vm.toString(RULES));
        vm.setEnv("SETTLEMENT_TEST_REFERENCE_HASH", vm.toString(REF));
    }

    function _point(address core, address hook, address deployer) internal {
        _put(".contracts.core.address", core);
        _put(".contracts.hook.address", hook);
        _put(".deployer", deployer);
    }

    function test_createTestJob() public {
        vm.chainId(31337);
        vm.writeFile(_mp(), vm.readFile(string.concat(vm.projectRoot(), "/deployments/arc-testnet.json")));

        d = new LocalDeployHarness(_mp()).run();
        _put(".usdc.address", d.usdc);
        _point(d.core, d.hook, d.deployer);
        _env(provider, IMAGE_ID);

        vm.startBroadcast();
        (, poster,) = vm.readCallers();
        vm.stopBroadcast();

        _refusals();
        _happyPath();
        _duplicateGuard();

        vm.removeFile(_mp());
    }

    // ───────────── refusals ─────────────

    function _refusals() internal {
        LocalCreateTestJobHarness s = new LocalCreateTestJobHarness(_mp());

        // Poster has no USDC yet.
        vm.expectRevert(bytes("poster USDC balance below the budget"));
        s.run();
        MockUSDC(d.usdc).mint(poster, 5e6);

        // Wrong chain.
        vm.chainId(1);
        vm.expectRevert(bytes("SETTLEMENT_LOCAL=1 requires chain ID 31337"));
        s.run();
        vm.chainId(31337);

        // Zero provider and zero image ID.
        _env(address(0), IMAGE_ID);
        vm.expectRevert(bytes("SETTLEMENT_TEST_PROVIDER is zero"));
        s.run();
        _env(provider, bytes32(0));
        vm.expectRevert(bytes("SETTLEMENT_TEST_IMAGE_ID is zero"));
        s.run();
        _env(provider, IMAGE_ID);

        // A hook that the core never whitelisted, on the frozen core.
        SettlementHook stray =
            new SettlementHook(ISettlementCore(d.core), IProofVerifier(d.verifier), d.usdc, 16412, 600);
        _put(".contracts.hook.address", address(stray));
        vm.expectRevert(bytes("hook is not whitelisted on the core"));
        s.run();

        // A core that still has its admin (not frozen): the whitelist is set, the admin role is held.
        address impl = address(new AgenticCommerce());
        AgenticCommerce core2 = AgenticCommerce(
            address(
                new ERC1967Proxy(
                    impl, abi.encodeCall(AgenticCommerce.initialize, (d.usdc, address(this), address(this)))
                )
            )
        );
        SettlementHook hook2 =
            new SettlementHook(ISettlementCore(address(core2)), IProofVerifier(d.verifier), d.usdc, 16412, 600);
        core2.setHookWhitelist(address(hook2), true);
        _point(address(core2), address(hook2), address(this));
        vm.expectRevert(bytes("core is not frozen: deployer still holds an admin role"));
        s.run();

        // Opt-in: SETTLEMENT_ALLOW_UNFROZEN=1 lets the same unfrozen core through (hook still whitelisted).
        vm.setEnv("SETTLEMENT_ALLOW_UNFROZEN", "true");
        CreateTestJob.TestJob memory tu = s.run();
        assertEq(tu.jobId, 1);
        assertEq(uint256(core2.getJob(1).status), uint256(AgenticCommerce.JobStatus.Funded));
        assertEq(MockUSDC(d.usdc).balanceOf(address(core2)), 1e6);
        // The manifest object records that the core was not frozen.
        vm.writeJson(s.manifestJson(tu, false), _mp(), ".testJob");
        assertFalse(vm.parseJsonBool(vm.readFile(_mp()), ".testJob.coreFrozen"));
        vm.writeJson("null", _mp(), ".testJob");
        // The override does not waive the whitelist: an unwhitelisted hook still reverts.
        core2.setHookWhitelist(address(hook2), false);
        vm.expectRevert(bytes("hook is not whitelisted on the core"));
        s.run();
        vm.setEnv("SETTLEMENT_ALLOW_UNFROZEN", "false");

        // Back to the frozen deployment.
        _point(d.core, d.hook, d.deployer);
    }

    // ───────────── the four Poster transactions ─────────────

    function _happyPath() internal {
        LocalCreateTestJobHarness s = new LocalCreateTestJobHarness(_mp());
        AgenticCommerce core = AgenticCommerce(d.core);
        SettlementHook hook = SettlementHook(d.hook);
        MockUSDC usdc = MockUSDC(d.usdc);
        uint256 posterBefore = usdc.balanceOf(poster);

        CreateTestJob.TestJob memory t = s.run();

        // Config: bountyUsdc "1.00" is 1e6 base units; expirySeconds is 900.
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/config/arc-testnet.json"));
        assertEq(vm.parseJsonString(cfg, ".demo.bountyUsdc"), "1.00");
        assertEq(t.budget, 1e6);
        assertEq(t.expiry, block.timestamp + vm.parseJsonUint(cfg, ".demo.expirySeconds"));

        assertEq(t.jobId, 1);
        assertEq(core.jobCounter(), 1);
        assertEq(t.poster, poster);
        assertEq(t.provider, provider);

        // Job is Funded with the right parties and amounts.
        AgenticCommerce.Job memory job = core.getJob(t.jobId);
        assertEq(uint256(job.status), uint256(AgenticCommerce.JobStatus.Funded));
        assertEq(job.client, poster);
        assertEq(job.provider, provider);
        assertEq(job.evaluator, d.hook);
        assertEq(job.hook, d.hook);
        assertEq(job.budget, 1e6);
        assertEq(job.expiredAt, t.expiry);

        _checkTerms(t);

        // Escrow holds the bounty and the Poster paid it.
        assertEq(usdc.balanceOf(d.core), 1e6);
        assertEq(usdc.balanceOf(poster), posterBefore - 1e6);

        // Context handed to the manifest equals the hook's own view (169 bytes).
        assertEq(t.context, hook.contextOf(t.jobId));
        assertEq(t.context.length, 169);

        _checkManifest(s, t);
    }

    function _checkTerms(CreateTestJob.TestJob memory t) internal view {
        (bytes32 img, bytes32 rules, bytes32 ref, address prov, uint256 budget, uint64 expiry, bool funded) =
            SettlementHook(d.hook).terms(t.jobId);
        assertEq(img, IMAGE_ID);
        assertEq(rules, RULES);
        assertEq(ref, REF);
        assertEq(prov, provider);
        assertEq(budget, 1e6);
        assertEq(uint256(expiry), t.expiry);
        assertTrue(funded);
    }

    function _checkManifest(LocalCreateTestJobHarness s, CreateTestJob.TestJob memory t) internal {
        // The manifest object parses back into the same values. `testJob` is absent from the template,
        // so this also checks that writeJson inserts the missing key.
        vm.writeJson(s.manifestJson(t, true), _mp(), ".testJob");
        assertTrue(vm.parseJsonBool(vm.readFile(_mp()), ".testJob.coreFrozen"));
        string memory m = vm.readFile(_mp());
        assertEq(vm.parseJsonUint(m, ".testJob.jobId"), t.jobId);
        assertEq(vm.parseJsonAddress(m, ".testJob.poster"), poster);
        assertEq(vm.parseJsonAddress(m, ".testJob.provider"), provider);
        assertEq(vm.parseJsonBytes32(m, ".testJob.imageId"), IMAGE_ID);
        assertEq(vm.parseJsonBytes32(m, ".testJob.rulesHash"), RULES);
        assertEq(vm.parseJsonBytes32(m, ".testJob.referenceHash"), REF);
        assertEq(vm.parseJsonUint(m, ".testJob.budget"), 1e6);
        assertEq(vm.parseJsonUint(m, ".testJob.expiry"), t.expiry);
        assertEq(vm.parseJsonBytes(m, ".testJob.context"), SettlementHook(d.hook).contextOf(t.jobId));
        assertEq(vm.parseJsonUint(m, ".testJob.createdBlock"), t.createdBlock);
        // Rest of the manifest is untouched.
        assertEq(vm.parseJsonAddress(m, ".contracts.hook.address"), d.hook);
    }

    // ───────────── one test job only ─────────────

    function _duplicateGuard() internal {
        LocalCreateTestJobHarness s = new LocalCreateTestJobHarness(_mp());
        MockUSDC(d.usdc).mint(poster, 1e6);

        vm.expectRevert(bytes("a test job is already recorded; set SETTLEMENT_ALLOW_NEW_TEST_JOB=1 to create another"));
        s.run();

        vm.setEnv("SETTLEMENT_ALLOW_NEW_TEST_JOB", "true");
        CreateTestJob.TestJob memory t2 = s.run();
        vm.setEnv("SETTLEMENT_ALLOW_NEW_TEST_JOB", "false");
        assertEq(t2.jobId, 2);
        assertEq(MockUSDC(d.usdc).balanceOf(d.core), 2e6);
    }
}
