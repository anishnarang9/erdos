// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {SettlementScript} from "./00_Config.s.sol";
import {AgenticCommerce} from "../src/core/src/AgenticCommercePatched.sol";
import {SettlementHook} from "../src/SettlementHook.sol";

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Step 8 (after the freeze). The Poster creates and funds ONE test job on the deployed
///         core through the four Poster transactions of SETTLEMENT-IMPLEMENTATION.md Section 10:
///         `createJob`, `setBudget`, USDC `approve(core, budget)`, `fund`.
///
///         Inputs (environment, so no value is baked into the repository):
///           SETTLEMENT_TEST_PROVIDER        address that will act as the Solver (provider)
///           SETTLEMENT_TEST_IMAGE_ID        bytes32 guest image ID the proof must be for
///           SETTLEMENT_TEST_RULES_HASH      bytes32
///           SETTLEMENT_TEST_REFERENCE_HASH  bytes32
///         Config: `demo.bountyUsdc` (decimal string, at most 6 decimals) and `demo.expirySeconds`
///         from `config/arc-testnet.json`. Addresses come from the manifest. The Poster is whoever
///         signs the broadcast (`--account <keystore>`); it needs at least `bountyUsdc` plus gas in USDC.
///
///         Pre-checks (revert with a message before anything is sent): chain guard; hook whitelisted
///         on the core and the manifest deployer holds neither admin role (frozen); hook is wired to
///         this core and USDC; `expirySeconds >= hook.MIN_EXPIRY_MARGIN() + coreMinExpirySeconds`;
///         Poster USDC balance covers the budget; no test job already recorded in the manifest
///         (`SETTLEMENT_ALLOW_NEW_TEST_JOB=1` overrides).
///         Post-checks (on the simulated state the broadcast replays): job Funded with the right
///         client, provider, evaluator, hook, budget and expiry; `hook.terms(jobId)` equals the three
///         inputs, provider, budget and expiry and is `funded`; the core's USDC balance rose by the budget.
///         Under `--broadcast` only, writes a `testJob` object into the manifest. Transaction hashes
///         are not known inside a script; they are in `broadcast/08_CreateTestJob.s.sol/<chainId>/run-latest.json`.
///
///         Race note: the job ID is the core's `jobCounter + 1` at simulation time and is baked into
///         the later transactions. If someone else creates a job on the (public) core in between,
///         `setBudget` reverts `Unauthorized` and nothing is funded; re-run.
contract CreateTestJob is SettlementScript {
    struct Inputs {
        address core;
        address hook;
        address usdc;
        address provider;
        bytes32 imageId;
        bytes32 rulesHash;
        bytes32 referenceHash;
        uint256 budget;
        uint256 expirySeconds;
    }

    struct TestJob {
        uint256 jobId;
        address poster;
        address provider;
        bytes32 imageId;
        bytes32 rulesHash;
        bytes32 referenceHash;
        uint256 budget;
        uint256 expiry;
        bytes context;
        uint256 createdBlock;
    }

    string internal constant DESCRIPTION = "UBC-26 settlement test job";

    function run() external returns (TestJob memory t) {
        Config memory c = _loadConfig();
        _guardChain(c);
        Inputs memory i = _inputs();

        // The Poster is the broadcast signer. Reads happen before the broadcast starts.
        vm.startBroadcast();
        address poster = _broadcaster();
        vm.stopBroadcast();

        _preChecks(c, i, poster);

        uint256 coreBefore = IERC20Minimal(i.usdc).balanceOf(i.core);
        t = _execute(i, poster);
        _postChecks(i, t, coreBefore);

        _manifestWrite(".testJob", manifestJson(t));
        console.log("test job funded, jobId", t.jobId);
        console.log("poster", t.poster);
        console.log("expiry", t.expiry);
    }

    // ───────────────────────── Inputs ─────────────────────────

    function _inputs() internal view returns (Inputs memory i) {
        Config memory c = _loadConfig();
        i.core = _manifestAddress(".contracts.core.address");
        i.hook = _manifestAddress(".contracts.hook.address");
        _requireCode("core proxy", i.core);
        _requireCode("hook", i.hook);
        i.usdc = _resolveUsdc(c);
        i.provider = vm.envAddress("SETTLEMENT_TEST_PROVIDER");
        i.imageId = vm.envBytes32("SETTLEMENT_TEST_IMAGE_ID");
        i.rulesHash = vm.envBytes32("SETTLEMENT_TEST_RULES_HASH");
        i.referenceHash = vm.envBytes32("SETTLEMENT_TEST_REFERENCE_HASH");
        require(i.provider != address(0), "SETTLEMENT_TEST_PROVIDER is zero");
        require(i.imageId != bytes32(0), "SETTLEMENT_TEST_IMAGE_ID is zero");

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/arc-testnet.json"));
        i.budget = _parseUsdc(vm.parseJsonString(json, ".demo.bountyUsdc"));
        i.expirySeconds = vm.parseJsonUint(json, ".demo.expirySeconds");
    }

    /// @dev Decimal string ("1.00", "0.5", "25") to 6-decimal base units. At most 6 fractional digits.
    function _parseUsdc(string memory s) internal pure returns (uint256 units) {
        bytes memory b = bytes(s);
        require(b.length != 0, "empty bounty");
        bool seenDot;
        uint256 frac;
        uint256 digits;
        for (uint256 k = 0; k < b.length; k++) {
            bytes1 ch = b[k];
            if (ch == ".") {
                require(!seenDot, "bounty has two decimal points");
                seenDot = true;
            } else {
                require(ch >= "0" && ch <= "9", "bounty has a non-digit");
                digits++;
                if (seenDot) {
                    frac++;
                    require(frac <= 6, "bounty has more than 6 decimals");
                }
                units = units * 10 + uint8(ch) - 48;
            }
        }
        require(digits != 0, "bounty has no digits");
        for (uint256 k = frac; k < 6; k++) {
            units *= 10;
        }
        require(units > 0, "bounty is zero");
    }

    // ───────────────────────── Pre-checks ─────────────────────────

    function _preChecks(Config memory c, Inputs memory i, address poster) internal view {
        AgenticCommerce core = AgenticCommerce(i.core);
        SettlementHook hook = SettlementHook(i.hook);

        require(core.whitelistedHooks(i.hook), "hook is not whitelisted on the core");
        address deployer = _manifestAddress(".deployer");
        require(deployer != address(0), "manifest .deployer missing");
        require(
            !core.hasRole(ADMIN_ROLE, deployer) && !core.hasRole(DEFAULT_ADMIN_ROLE, deployer),
            "core is not frozen: deployer still holds an admin role"
        );
        require(address(hook.core()) == i.core, "hook.core != manifest core");
        require(hook.usdc() == i.usdc, "hook.usdc != USDC");
        require(address(core.paymentToken()) == i.usdc, "core paymentToken != USDC");
        require(hook.supportsInterface(IACP_HOOK_ID), "hook lacks IACPHook");

        uint256 needed = hook.MIN_EXPIRY_MARGIN() + c.coreMinExpirySeconds;
        // expiry = now + expirySeconds must be >= now + hook margin + core minimum (300 s).
        require(i.expirySeconds >= needed, "demo.expirySeconds < hook MIN_EXPIRY_MARGIN + core minimum expiry");
        uint256 bal = IERC20Minimal(i.usdc).balanceOf(poster);
        require(bal >= i.budget, "poster USDC balance below the budget");
        console.log("poster USDC balance (6 decimals)", bal);

        if (!vm.envOr("SETTLEMENT_ALLOW_NEW_TEST_JOB", false)) {
            string memory path = _manifestPath();
            if (vm.exists(path)) {
                string memory json = vm.readFile(path);
                if (vm.keyExistsJson(json, ".testJob.jobId")) {
                    require(
                        vm.parseJsonUint(json, ".testJob.jobId") == 0,
                        "a test job is already recorded; set SETTLEMENT_ALLOW_NEW_TEST_JOB=1 to create another"
                    );
                }
            }
        }
    }

    // ───────────────────────── The four Poster transactions ─────────────────────────

    function _execute(Inputs memory i, address poster) internal returns (TestJob memory t) {
        AgenticCommerce core = AgenticCommerce(i.core);
        uint256 expiry = block.timestamp + i.expirySeconds;

        vm.startBroadcast();
        uint256 jobId = core.createJob(i.provider, i.hook, expiry, DESCRIPTION, i.hook);
        core.setBudget(jobId, i.budget, "");
        IERC20Minimal(i.usdc).approve(i.core, i.budget);
        core.fund(jobId, abi.encode(i.imageId, i.rulesHash, i.referenceHash));
        vm.stopBroadcast();

        t.jobId = jobId;
        t.poster = poster;
        t.provider = i.provider;
        t.imageId = i.imageId;
        t.rulesHash = i.rulesHash;
        t.referenceHash = i.referenceHash;
        t.budget = i.budget;
        t.expiry = expiry;
        t.createdBlock = block.number;
        t.context = SettlementHook(i.hook).contextOf(jobId);
    }

    // ───────────────────────── Post-checks ─────────────────────────

    function _postChecks(Inputs memory i, TestJob memory t, uint256 coreBefore) internal view {
        AgenticCommerce.Job memory job = AgenticCommerce(i.core).getJob(t.jobId);
        require(job.id == t.jobId, "job id");
        require(job.status == AgenticCommerce.JobStatus.Funded, "job is not Funded");
        require(job.client == t.poster, "job.client != poster");
        require(job.provider == t.provider, "job.provider");
        require(job.evaluator == i.hook && job.hook == i.hook, "job evaluator/hook != hook");
        require(job.budget == t.budget, "job.budget");
        require(job.expiredAt == t.expiry, "job.expiredAt");

        (bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash, address provider, uint256 budget, uint64 expiry, bool funded)
        = SettlementHook(i.hook).terms(t.jobId);
        require(funded, "terms not funded");
        require(imageId == t.imageId && rulesHash == t.rulesHash && referenceHash == t.referenceHash, "terms hashes");
        require(provider == t.provider && budget == t.budget && uint256(expiry) == t.expiry, "terms provider/budget/expiry");
        require(t.context.length == 169, "context length");

        require(IERC20Minimal(i.usdc).balanceOf(i.core) == coreBefore + t.budget, "core USDC balance did not rise by the budget");
    }

    // ───────────────────────── Manifest ─────────────────────────

    /// @notice The `testJob` object written to the manifest. Public so tests can check the encoding.
    function manifestJson(TestJob memory t) public pure returns (string memory) {
        return string.concat(
            '{"jobId":', vm.toString(t.jobId),
            ',"poster":', _q(vm.toString(t.poster)),
            ',"provider":', _q(vm.toString(t.provider)),
            ',"imageId":', _q(vm.toString(t.imageId)),
            ',"rulesHash":', _q(vm.toString(t.rulesHash)),
            ',"referenceHash":', _q(vm.toString(t.referenceHash)),
            ',"budget":', vm.toString(t.budget),
            ',"budgetDecimals":6',
            ',"expiry":', vm.toString(t.expiry),
            ',"context":', _q(vm.toString(t.context)),
            ',"createdBlock":', vm.toString(t.createdBlock),
            ',"txHashes":null',
            ',"txHashesSource":"broadcast/08_CreateTestJob.s.sol/<chainId>/run-latest.json"}'
        );
    }
}
