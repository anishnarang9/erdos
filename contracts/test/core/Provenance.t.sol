// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// S2 (structural part): the patched core differs from Circle's pristine copy by exactly one line,
// and with the patch the Poster (client) sets the budget while the Solver (provider) cannot.
//
// forge-std is not vendored in this project (libs = []), so this file declares the few cheatcodes it
// needs and uses require-style assertions. Any failing check reverts, which fails the test.

import {AgenticCommerce as PristineCore} from "../../src/core/src/AgenticCommerce.sol";
import {AgenticCommerce as PatchedCore} from "../../src/core/src/AgenticCommercePatched.sol";
import {IACPHook} from "../../src/core/src/interfaces/IACPHook.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

interface Vm {
    function readFile(string calldata path) external view returns (string memory);
    function prank(address caller) external;
    function expectRevert(bytes4 selector) external;
}

contract ProvenanceTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant PRISTINE = "src/core/src/AgenticCommerce.sol";
    string internal constant PATCHED = "src/core/src/AgenticCommercePatched.sol";
    string internal constant PATCH = "src/core/setBudget-client-only.patch";
    string internal constant OLD_LINE = "        if (msg.sender != job.provider) revert Unauthorized();";
    string internal constant NEW_LINE = "        if (msg.sender != job.client) revert Unauthorized();";

    address internal constant TREASURY = address(0x7EA5);
    address internal constant ADMIN = address(0xAD);
    address internal constant CLIENT = address(0xC11E);
    address internal constant PROVIDER = address(0xB0B);
    address internal constant EVALUATOR = address(0xE7A1);

    // ---------------------------------------------------------------- helpers

    function _lines(string memory s) internal pure returns (string[] memory out) {
        bytes memory b = bytes(s);
        uint256 n = 1;
        for (uint256 i; i < b.length; i++) {
            if (b[i] == 0x0a) n++;
        }
        out = new string[](n);
        uint256 start;
        uint256 k;
        for (uint256 i; i <= b.length; i++) {
            if (i == b.length || b[i] == 0x0a) {
                bytes memory line = new bytes(i - start);
                for (uint256 j; j < line.length; j++) {
                    line[j] = b[start + j];
                }
                out[k++] = string(line);
                start = i + 1;
            }
        }
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _deploy(bool patched) internal returns (address proxy, MockUSDC usdc) {
        usdc = new MockUSDC();
        address impl = patched ? address(new PatchedCore()) : address(new PristineCore());
        proxy = address(
            new ERC1967Proxy(
                impl, abi.encodeCall(PatchedCore.initialize, (address(usdc), TREASURY, ADMIN))
            )
        );
    }

    // ---------------------------------------------------------------- S2: single-line patch

    function test_patchedSourceDiffersInExactlyOneLine() public view {
        string[] memory a = _lines(vm.readFile(PRISTINE));
        string[] memory b = _lines(vm.readFile(PATCHED));
        require(a.length == b.length, "line count differs");
        uint256 diffs;
        for (uint256 i; i < a.length; i++) {
            if (!_eq(a[i], b[i])) {
                diffs++;
                require(_eq(a[i], OLD_LINE), "pristine line is not the expected provider check");
                require(_eq(b[i], NEW_LINE), "patched line is not the expected client check");
            }
        }
        require(diffs == 1, "expected exactly one differing line");
    }

    function test_patchFileContainsOnlyThatChange() public view {
        string[] memory p = _lines(vm.readFile(PATCH));
        uint256 removed;
        uint256 added;
        for (uint256 i; i < p.length; i++) {
            bytes memory l = bytes(p[i]);
            if (l.length == 0) continue;
            bool header = l.length > 2 && l[1] == l[0] && l[2] == l[0];
            if (l[0] == "-" && !header) {
                removed++;
                require(_eq(p[i], string.concat("-", OLD_LINE)), "unexpected removed line");
            } else if (l[0] == "+" && !header) {
                added++;
                require(_eq(p[i], string.concat("+", NEW_LINE)), "unexpected added line");
            }
        }
        require(removed == 1 && added == 1, "patch must have exactly one -/+ pair");
    }

    // ---------------------------------------------------------------- S2: behavior

    function test_patchedCoreProviderCannotSetBudgetClientCan() public {
        (address proxy, MockUSDC usdc) = _deploy(true);
        PatchedCore core = PatchedCore(proxy);

        // initialize() wired the proxy as intended
        require(address(core.paymentToken()) == address(usdc), "token");
        require(core.platformTreasury() == TREASURY, "treasury");
        require(core.hasRole(core.DEFAULT_ADMIN_ROLE(), ADMIN), "default admin");
        require(core.hasRole(core.ADMIN_ROLE(), ADMIN), "admin role");
        require(core.whitelistedHooks(address(0)), "zero hook whitelisted");
        require(core.platformFeeBP() == 0 && core.evaluatorFeeBP() == 0, "fees default to zero");

        // the core allows a zero hook (whitelistedHooks[0] is true; no ERC-165 check for zero)
        vm.prank(CLIENT);
        uint256 jobId = core.createJob(PROVIDER, EVALUATOR, block.timestamp + 1 hours, "job", address(0));
        require(jobId == 1, "job id");

        // Solver (provider) is rejected
        vm.prank(PROVIDER);
        vm.expectRevert(PatchedCore.Unauthorized.selector);
        core.setBudget(jobId, 5_000_000, "");
        require(core.getJob(jobId).budget == 0, "budget must be unchanged");
        require(!core.jobHasBudget(jobId), "jobHasBudget must be unchanged");

        // A third party is rejected as well
        vm.prank(EVALUATOR);
        vm.expectRevert(PatchedCore.Unauthorized.selector);
        core.setBudget(jobId, 5_000_000, "");

        // Poster (client) succeeds
        vm.prank(CLIENT);
        core.setBudget(jobId, 5_000_000, "");
        PatchedCore.Job memory job = core.getJob(jobId);
        require(job.budget == 5_000_000, "budget set");
        require(core.jobHasBudget(jobId), "jobHasBudget");
        require(job.client == CLIENT && job.provider == PROVIDER, "parties");

        // and the Poster can fund exactly the bounty
        usdc.mint(CLIENT, 5_000_000);
        vm.prank(CLIENT);
        usdc.approve(proxy, 5_000_000);
        vm.prank(CLIENT);
        core.fund(jobId, "");
        require(uint8(core.getJob(jobId).status) == uint8(PatchedCore.JobStatus.Funded), "funded");
        require(usdc.balanceOf(proxy) == 5_000_000 && usdc.balanceOf(CLIENT) == 0, "escrow balance");
    }

    function test_pristineCoreIsTheOpposite() public {
        // Control: the unpatched core lets only the provider set the budget.
        (address proxy,) = _deploy(false);
        PristineCore core = PristineCore(proxy);
        vm.prank(CLIENT);
        uint256 jobId = core.createJob(PROVIDER, EVALUATOR, block.timestamp + 1 hours, "job", address(0));

        vm.prank(CLIENT);
        vm.expectRevert(PristineCore.Unauthorized.selector);
        core.setBudget(jobId, 5_000_000, "");

        vm.prank(PROVIDER);
        core.setBudget(jobId, 5_000_000, "");
        require(core.getJob(jobId).budget == 5_000_000, "provider set budget on pristine");
    }

    function test_patchedImplementationIsLockedAndSelectorsUnchanged() public {
        PatchedCore impl = new PatchedCore();
        vm.expectRevert(bytes4(0xf92ee8a9)); // InvalidInitialization()
        impl.initialize(address(1), address(2), address(3));
        require(PatchedCore.setBudget.selector == PristineCore.setBudget.selector, "selector");
        require(PatchedCore.createJob.selector == PristineCore.createJob.selector, "selector");
    }

    // ---------------------------------------------------------------- R5 cross-check

    function test_iacpHookInterfaceId() public pure {
        require(IACPHook.beforeAction.selector == 0xdc08fb1d, "beforeAction selector");
        require(IACPHook.afterAction.selector == 0xa3fe4783, "afterAction selector");
        require(type(IACPHook).interfaceId == 0x7ff6bc9e, "IACPHook interface id");
        require(
            type(IACPHook).interfaceId == (IACPHook.beforeAction.selector ^ IACPHook.afterAction.selector),
            "xor"
        );
    }

    function test_coreRejectsNonWhitelistedHook() public {
        (address proxy,) = _deploy(true);
        PatchedCore core = PatchedCore(proxy);
        vm.prank(CLIENT);
        vm.expectRevert(PatchedCore.HookNotWhitelisted.selector);
        core.createJob(PROVIDER, EVALUATOR, block.timestamp + 1 hours, "job", address(0xBEEF));
    }
}
