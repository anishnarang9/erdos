// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {AgenticCommerce} from "../src/core/src/AgenticCommercePatched.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {RiscZeroGroth16Verifier} from "../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {ControlID} from "../src/verifier/groth16/ControlID.sol";
import {MockRiscZeroVerifier} from "../src/verifier/MockRiscZeroVerifier.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {SettlementHook} from "../src/SettlementHook.sol";
import {ISettlementCore} from "../src/interfaces/ISettlementCore.sol";
import {IProofVerifier} from "../src/interfaces/IProofVerifier.sol";

/// @title SettlementScript
/// @notice Shared base for the settlement deploy scripts (SETTLEMENT-IMPLEMENTATION.md Section 8).
///
/// What lives here: configuration loading, the chain-ID guard, manifest read and write, and one
/// internal function per deployment step (each with its post-condition checks). The numbered
/// scripts (01 to 05) are thin wrappers that run one step against `deployments/<network>.json`;
/// `DeployAll.s.sol` runs every step in one simulation or one local broadcast.
///
/// Safety rules, enforced in code:
/// - Every script aborts unless `block.chainid` equals `chainId` in `config/arc-testnet.json`.
///   The only exception is local mode (`SETTLEMENT_LOCAL=1`), which accepts chain 31337 only and
///   deploys `MockUSDC` and `MockRiscZeroVerifier` instead of Arc USDC and the Groth16 verifier.
/// - No script reads or accepts a private key. The signer comes from the forge command line
///   (`--account <keystore>` for Arc, `--unlocked --sender <addr>` for anvil).
/// - The manifest is written only when the script runs with `--broadcast`. Dry runs never write.
/// - A step refuses to redeploy when the manifest already holds an address with code on the
///   current chain, unless `SETTLEMENT_ALLOW_REDEPLOY=1`.
///
/// Broadcast hygiene: external calls made while broadcasting become transactions, so every read
/// happens before `vm.startBroadcast()` and every post-condition check after `vm.stopBroadcast()`.
/// Post-conditions therefore run against the simulated state that the broadcast will replay. Run
/// `06_Verify.s.sol` after each live step to check the real chain state.
abstract contract SettlementScript is Script {
    // ───────────────────────── Constants ─────────────────────────

    uint256 internal constant LOCAL_CHAIN_ID = 31337;
    bytes32 internal constant ERC1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes4 internal constant IACP_HOOK_ID = 0x7ff6bc9e;
    bytes4 internal constant ERC165_ID = 0x01ffc9a7;
    bytes4 internal constant RISC0_V3_1_SELECTOR = 0xe71e6620;
    /// @dev OpenZeppelin AccessControl `AccessControlUnauthorizedAccount(address,bytes32)`.
    bytes4 internal constant ACCESS_CONTROL_UNAUTHORIZED = 0xe2517d3f;
    /// @dev OpenZeppelin IAccessControl events; all three arguments are indexed (topics 1 to 3).
    bytes32 internal constant ROLE_GRANTED_TOPIC = keccak256("RoleGranted(bytes32,address,address)");
    bytes32 internal constant ROLE_REVOKED_TOPIC = keccak256("RoleRevoked(bytes32,address,address)");
    /// @dev AgenticCommerce `HookWhitelistUpdated(address indexed hook, bool status)`.
    bytes32 internal constant HOOK_WHITELIST_UPDATED_TOPIC = keccak256("HookWhitelistUpdated(address,bool)");
    /// @dev ERC1967 `Upgraded(address indexed implementation)`, emitted by the proxy constructor and
    ///      by every `upgradeToAndCall`.
    bytes32 internal constant UPGRADED_TOPIC = keccak256("Upgraded(address)");
    uint256 internal constant DEFAULT_MAX_LOG_BLOCK_RANGE = 10000;

    // ───────────────────────── Types ─────────────────────────

    struct Config {
        uint256 chainId;
        address usdc;
        uint256 usdcDecimals;
        uint256 maxEnvelopeBytes;
        uint256 minExpiryMargin;
        uint256 coreMinExpirySeconds;
    }

    /// @dev Addresses handed from step to step.
    struct Deployment {
        address usdc;
        address verifier;
        address coreImpl;
        address core;
        address hook;
        address deployer;
    }

    /// @dev One RoleGranted or RoleRevoked event for ADMIN_ROLE or DEFAULT_ADMIN_ROLE on the core.
    ///      `onChain` events come from `eth_getLogs` and carry block, tx hash and log index. Session
    ///      events were emitted in this forge process (simulation or test EVM) and are not on chain
    ///      yet: their block, tx hash and log index are zero.
    struct RoleEvent {
        bytes32 role;
        address account;
        address sender;
        bool granted;
        uint256 blockNumber;
        bytes32 txHash;
        uint256 logIndex;
        bool onChain;
    }

    struct RoleHolder {
        bytes32 role;
        address account;
    }

    /// @dev One `HookWhitelistUpdated` event on the core. Same `onChain` convention as `RoleEvent`.
    struct WhitelistEvent {
        address hook;
        bool status;
        uint256 blockNumber;
        bytes32 txHash;
        uint256 logIndex;
        bool onChain;
    }

    /// @dev One ERC1967 `Upgraded` event on the core proxy. Same `onChain` convention as `RoleEvent`.
    struct UpgradeEvent {
        address implementation;
        uint256 blockNumber;
        bytes32 txHash;
        uint256 logIndex;
        bool onChain;
    }

    /// @dev A raw log from the core-log replay, before decoding.
    struct ReplayLog {
        bytes32[] topics;
        bytes data;
        uint256 blockNumber;
        bytes32 txHash;
        uint256 logIndex;
        bool onChain;
    }

    /// @dev Tracked session logs (role, whitelist and upgrade topics) drained from the cheatcode log
    ///      buffer. `vm.getRecordedLogs()` empties the buffer on every read, so drained logs are kept
    ///      here for the rest of this script run.
    struct SessionLog {
        address emitter;
        bytes32[] topics;
        bytes data;
    }

    SessionLog[] internal _sessionLogs;

    // ───────────────────────── Configuration ─────────────────────────

    function _loadConfig() internal view returns (Config memory c) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/arc-testnet.json"));
        c.chainId = vm.parseJsonUint(json, ".chainId");
        c.usdc = vm.parseJsonAddress(json, ".usdc");
        c.usdcDecimals = vm.parseJsonUint(json, ".usdcDecimals");
        c.maxEnvelopeBytes = vm.parseJsonUint(json, ".hook.maxEnvelopeBytes");
        c.minExpiryMargin = vm.parseJsonUint(json, ".hook.minExpiryMarginSeconds");
        c.coreMinExpirySeconds = vm.parseJsonUint(json, ".coreMinExpirySeconds");
    }

    function _isLocal() internal view virtual returns (bool) {
        return vm.envOr("SETTLEMENT_LOCAL", false);
    }

    /// @notice Abort unless the live chain is the configured one (or anvil in explicit local mode).
    function _guardChain(Config memory c) internal view {
        if (_isLocal()) {
            require(block.chainid == LOCAL_CHAIN_ID, "SETTLEMENT_LOCAL=1 requires chain ID 31337");
        } else {
            require(block.chainid == c.chainId, "chain ID does not match config/arc-testnet.json chainId");
        }
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
    }

    function _allowRedeploy() internal view returns (bool) {
        return vm.envOr("SETTLEMENT_ALLOW_REDEPLOY", false);
    }

    /// @dev Address that signs the broadcast, as set by `--account`, `--sender` or `--private-key`.
    ///      Must be called while a broadcast is active.
    function _broadcaster() internal returns (address deployer) {
        (, deployer,) = vm.readCallers();
    }

    // ───────────────────────── Manifest ─────────────────────────

    function _manifestPath() internal view virtual returns (string memory) {
        string memory name = _isLocal() ? "local" : "arc-testnet";
        return vm.envOr("SETTLEMENT_MANIFEST", string.concat(vm.projectRoot(), "/deployments/", name, ".json"));
    }

    /// @dev Address stored at `key` (for example ".contracts.core.address"), or zero for null or
    ///      a missing file or key.
    function _manifestAddress(string memory key) internal view returns (address) {
        string memory path = _manifestPath();
        if (!vm.exists(path)) return address(0);
        string memory json = vm.readFile(path);
        if (!vm.keyExistsJson(json, key)) return address(0);
        return abi.decode(vm.parseJson(json, key), (address));
    }

    /// @dev Write `value` (a JSON literal) at `key`. Only when broadcasting. In local mode the
    ///      manifest is created from the Arc template on first write.
    function _manifestWrite(string memory key, string memory value) internal {
        if (!_broadcasting()) return;
        string memory path = _manifestPath();
        if (!vm.exists(path)) {
            require(_isLocal(), "manifest missing; expected deployments/arc-testnet.json");
            vm.writeFile(path, vm.readFile(string.concat(vm.projectRoot(), "/deployments/arc-testnet.json")));
        }
        vm.writeJson(value, path, key);
    }

    function _manifestWriteAddress(string memory key, address a) internal {
        _manifestWrite(key, _q(vm.toString(a)));
    }

    function _q(string memory s) internal pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    /// @dev A manifest address with no code on the current chain counts as NOT deployed (a failed
    ///      `--broadcast` can leave the entry behind, because scripts write the manifest during
    ///      simulation). Reverts if `existing` is already deployed on this chain and no override is set.
    function _refuseRedeploy(string memory what, address existing) internal view {
        if (existing != address(0) && existing.code.length != 0 && !_allowRedeploy()) {
            console.log(what, "already deployed at", existing);
            revert("already deployed; set SETTLEMENT_ALLOW_REDEPLOY=1 to override");
        }
    }

    function _requireCode(string memory what, address a) internal view {
        require(
            a != address(0) && a.code.length != 0,
            string.concat(what, ": manifest address has no code: reset the entry or rerun the step")
        );
    }

    function _treasury(address deployer) internal view returns (address t) {
        t = vm.envOr("SETTLEMENT_TREASURY", deployer);
        require(t != address(0), "treasury must be nonzero");
    }

    // ───────────────────────── Step 0: USDC (local mode only) ─────────────────────────

    /// @dev Returns the payment token: the configured Arc USDC, or in local mode a fresh MockUSDC.
    ///      On Arc it also checks that the address has code and reports 6 decimals.
    function _stepUsdc(Config memory c) internal returns (address usdc) {
        if (_isLocal()) {
            vm.startBroadcast();
            usdc = address(new MockUSDC());
            vm.stopBroadcast();
            require(MockUSDC(usdc).decimals() == 6, "mock USDC decimals");
            _manifestWriteAddress(".usdc.address", usdc);
        } else {
            usdc = c.usdc;
            require(usdc.code.length != 0, "configured USDC has no code on this chain");
            (bool ok, bytes memory ret) = usdc.staticcall(abi.encodeWithSignature("decimals()"));
            require(ok && ret.length == 32 && abi.decode(ret, (uint256)) == c.usdcDecimals, "USDC decimals mismatch");
        }
    }

    function _resolveUsdc(Config memory c) internal view returns (address usdc) {
        if (_isLocal()) {
            usdc = _manifestAddress(".usdc.address");
            _requireCode("local USDC", usdc);
        } else {
            usdc = c.usdc;
        }
    }

    /// @dev On any non-local chain the verifier must be the real Groth16 verifier. A hook frozen with
    ///      a permissive mock verifier would be permanently exploitable, so this reverts on anything
    ///      that does not expose the v3.1.0 SELECTOR, VERSION and BN254 control ID.
    function _requireRealVerifier(address verifier) internal view {
        if (_isLocal()) return;
        _requireCode("verifier", verifier);
        RiscZeroGroth16Verifier v = RiscZeroGroth16Verifier(verifier);
        require(v.SELECTOR() == RISC0_V3_1_SELECTOR, "verifier SELECTOR != 0xe71e6620");
        require(keccak256(bytes(v.VERSION())) == keccak256("3.1.0"), "verifier VERSION != 3.1.0");
        require(v.BN254_CONTROL_ID() == ControlID.BN254_CONTROL_ID, "verifier BN254_CONTROL_ID mismatch");
    }

    // ───────────────────────── Step 1: verifier ─────────────────────────

    function _stepVerifier() internal returns (address verifier) {
        _refuseRedeploy("verifier", _manifestAddress(".contracts.verifier.address"));
        vm.startBroadcast();
        address deployer = _broadcaster();
        verifier = _isLocal()
            ? address(new MockRiscZeroVerifier())
            : address(new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID));
        vm.stopBroadcast();

        require(verifier.code.length != 0, "verifier not deployed");
        _requireRealVerifier(verifier);

        _manifestWriteAddress(".contracts.verifier.address", verifier);
        _manifestWriteAddress(".contracts.verifier.deployer", deployer);
        _manifestWrite(".contracts.verifier.deployBlock", vm.toString(block.number));
        _manifestWrite(".status", _q("partial"));
        console.log("verifier", verifier);
    }

    // ───────────────────────── Step 2: core implementation ─────────────────────────

    function _stepCoreImpl() internal returns (address impl) {
        _refuseRedeploy("core implementation", _manifestAddress(".contracts.coreImplementation.address"));
        vm.startBroadcast();
        address deployer = _broadcaster();
        impl = address(new AgenticCommerce());
        vm.stopBroadcast();

        require(impl.code.length != 0, "core implementation not deployed");
        require(AgenticCommerce(impl).proxiableUUID() == ERC1967_IMPLEMENTATION_SLOT, "implementation is not UUPS");
        // The constructor calls _disableInitializers(): initializing the bare implementation must revert.
        vm.expectRevert();
        AgenticCommerce(impl).initialize(address(1), address(1), address(1));
        // `setBudget` is the patched one: only the client may call it. A call from a stranger on a
        // nonexistent job reverts InvalidJob first, so the behavioural proof lives in the tests.

        _manifestWriteAddress(".contracts.coreImplementation.address", impl);
        _manifestWriteAddress(".contracts.coreImplementation.deployer", deployer);
        _manifestWrite(".contracts.coreImplementation.deployBlock", vm.toString(block.number));
        _manifestWrite(".status", _q("partial"));
        console.log("core implementation", impl);
    }

    // ───────────────────────── Step 3: core proxy ─────────────────────────

    function _stepCoreProxy(address impl, address usdc) internal returns (address proxy) {
        _requireCode("core implementation", impl);
        _refuseRedeploy("core proxy", _manifestAddress(".contracts.core.address"));
        vm.startBroadcast();
        address deployer = _broadcaster();
        address treasury = _treasury(deployer);
        proxy = address(
            new ERC1967Proxy(impl, abi.encodeCall(AgenticCommerce.initialize, (usdc, treasury, deployer)))
        );
        vm.stopBroadcast();

        AgenticCommerce core = AgenticCommerce(proxy);
        require(address(uint160(uint256(vm.load(proxy, ERC1967_IMPLEMENTATION_SLOT)))) == impl, "implementation slot");
        require(core.platformFeeBP() == 0, "platform fee not zero");
        require(core.evaluatorFeeBP() == 0, "evaluator fee not zero");
        require(address(core.paymentToken()) == usdc, "paymentToken != USDC");
        require(core.platformTreasury() == treasury, "treasury");
        require(core.hasRole(DEFAULT_ADMIN_ROLE, deployer), "deployer lacks DEFAULT_ADMIN_ROLE");
        require(core.hasRole(ADMIN_ROLE, deployer), "deployer lacks ADMIN_ROLE");
        require(core.jobCounter() == 0, "jobCounter not zero");
        require(core.whitelistedHooks(address(0)), "zero hook not whitelisted");

        _manifestWriteAddress(".contracts.core.address", proxy);
        _manifestWriteAddress(".contracts.core.implementation", impl);
        _manifestWriteAddress(".contracts.core.deployer", deployer);
        _manifestWriteAddress(".contracts.core.treasury", treasury);
        _manifestWriteAddress(".deployer", deployer);
        _manifestWrite(".contracts.core.deployBlock", vm.toString(block.number));
        _manifestWrite(".status", _q("partial"));
        console.log("core proxy", proxy);
    }

    // ───────────────────────── Step 4: hook ─────────────────────────

    function _stepHook(Config memory c, address core, address verifier, address usdc) internal returns (address hook) {
        _requireCode("core proxy", core);
        _requireRealVerifier(verifier);
        _refuseRedeploy("hook", _manifestAddress(".contracts.hook.address"));
        require(address(AgenticCommerce(core).paymentToken()) == usdc, "core paymentToken != USDC");
        vm.startBroadcast();
        address deployer = _broadcaster();
        hook = address(
            new SettlementHook(
                ISettlementCore(core), IProofVerifier(verifier), usdc, c.maxEnvelopeBytes, c.minExpiryMargin
            )
        );
        vm.stopBroadcast();

        SettlementHook h = SettlementHook(hook);
        require(h.supportsInterface(IACP_HOOK_ID), "hook lacks IACPHook (0x7ff6bc9e)");
        require(h.supportsInterface(ERC165_ID), "hook lacks ERC-165");
        require(!h.supportsInterface(0xffffffff), "hook claims 0xffffffff");
        require(address(h.core()) == core, "hook.core");
        require(address(h.verifier()) == verifier, "hook.verifier");
        require(h.usdc() == usdc, "hook.usdc");
        require(h.MAX_ENVELOPE_BYTES() == c.maxEnvelopeBytes, "hook.MAX_ENVELOPE_BYTES");
        require(h.MIN_EXPIRY_MARGIN() == c.minExpiryMargin, "hook.MIN_EXPIRY_MARGIN");

        _manifestWriteAddress(".contracts.hook.address", hook);
        _manifestWriteAddress(".contracts.hook.deployer", deployer);
        _manifestWrite(".contracts.hook.deployBlock", vm.toString(block.number));
        _manifestWrite(".status", _q("partial"));
        console.log("hook", hook);
    }

    // ───────────────────────── Step 5: whitelist and freeze ─────────────────────────

    /// @dev Non-irreversible variant of step 5 (`SETTLEMENT_WHITELIST_ONLY=1`): whitelists the hook and
    ///      renounces NOTHING, so the deployer keeps both admin roles and the core is NOT frozen.
    ///      Idempotent: an already whitelisted hook is skipped. Refuses when the signer no longer holds
    ///      both roles (a frozen core cannot be un-frozen, and this path must not claim it is).
    function _stepWhitelistOnly(address core, address hook) internal {
        _requireCode("core proxy", core);
        _requireCode("hook", hook);
        AgenticCommerce c = AgenticCommerce(core);

        vm.startBroadcast();
        address deployer = _broadcaster();
        vm.stopBroadcast();

        require(
            c.hasRole(ADMIN_ROLE, deployer) && c.hasRole(DEFAULT_ADMIN_ROLE, deployer),
            "signer lacks an admin role: wrong account, or the core is already frozen"
        );
        bool wl = c.whitelistedHooks(hook);

        vm.startBroadcast();
        if (!wl) c.setHookWhitelist(hook, true);
        vm.stopBroadcast();

        require(c.whitelistedHooks(hook), "hook not whitelisted");
        require(c.whitelistedHooks(address(0)), "zero hook lost its whitelist");
        require(c.platformFeeBP() == 0 && c.evaluatorFeeBP() == 0, "fees not zero");
        require(
            c.hasRole(ADMIN_ROLE, deployer) && c.hasRole(DEFAULT_ADMIN_ROLE, deployer),
            "deployer lost an admin role during whitelist-only"
        );

        _manifestWrite(".contracts.core.hookWhitelisted", "true");
        _manifestWrite(".contracts.core.frozen", "false");
        _manifestWrite(".status", _q("whitelisted"));
        console.log("hook whitelisted; deployer still holds ADMIN_ROLE and DEFAULT_ADMIN_ROLE");
        console.log("WARNING: the core is NOT frozen. The deployer can still change fees, whitelist and upgrade.");
        console.log("WARNING: re-run 05_Freeze WITHOUT SETTLEMENT_WHITELIST_ONLY to renounce both roles later.");
    }

    /// @dev Whitelists the hook (unless already whitelisted), then renounces ADMIN_ROLE and
    ///      DEFAULT_ADMIN_ROLE. Re-running after a complete freeze only repeats the post-condition
    ///      checks. Partial states resume, including a hook already whitelisted by `_stepWhitelistOnly`.
    function _stepFreeze(address core, address hook) internal {
        _requireCode("core proxy", core);
        _requireCode("hook", hook);
        AgenticCommerce c = AgenticCommerce(core);

        // Reads happen before the broadcast starts. The deployer is whoever signs the broadcast.
        vm.startBroadcast();
        address deployer = _broadcaster();
        vm.stopBroadcast();

        bool wl = c.whitelistedHooks(hook);
        bool isAdmin = c.hasRole(ADMIN_ROLE, deployer);
        bool isDefaultAdmin = c.hasRole(DEFAULT_ADMIN_ROLE, deployer);
        if (!wl) require(isAdmin, "signer lacks ADMIN_ROLE and hook is not whitelisted; wrong account?");

        // Renouncing only removes the signer. If anyone else holds a role the core would stay
        // administrable, so refuse before broadcasting anything.
        RoleHolder[] memory holders = _roleHolders(core, _roleHistory(core), deployer);
        for (uint256 i = 0; i < holders.length; i++) {
            if (holders[i].account != deployer) {
                revert(
                    string.concat(
                        "freeze refused: ",
                        vm.toString(holders[i].account),
                        " also holds ",
                        _roleName(holders[i].role),
                        "; renouncing the signer's roles would not freeze the core. Revoke it first."
                    )
                );
            }
        }

        vm.startBroadcast();
        if (!wl) c.setHookWhitelist(hook, true);
        if (isAdmin) c.renounceRole(ADMIN_ROLE, deployer);
        if (isDefaultAdmin) c.renounceRole(DEFAULT_ADMIN_ROLE, deployer);
        vm.stopBroadcast();

        _checkFrozen(core, hook, deployer);

        _manifestWrite(".contracts.core.hookWhitelisted", "true");
        _manifestWrite(".contracts.core.frozen", "true");
        _manifestWrite(".status", _q("frozen"));
        console.log("frozen: hook whitelisted, deployer roles renounced");
    }

    /// @dev Post-conditions of the freeze. Uses `vm.prank` and so must not run during a broadcast.
    ///      Frozen means NOBODY holds ADMIN_ROLE or DEFAULT_ADMIN_ROLE (from the role-event replay,
    ///      re-confirmed with `hasRole`), not only the deployer.
    function _checkFrozen(address core, address hook, address deployer) internal {
        AgenticCommerce c = AgenticCommerce(core);
        require(c.whitelistedHooks(hook), "hook not whitelisted");
        require(c.whitelistedHooks(address(0)), "zero hook lost its whitelist");

        RoleEvent[] memory history = _roleHistory(core);
        _logRoleHistory(history);
        RoleHolder[] memory holders = _roleHolders(core, history, deployer);
        if (holders.length != 0) {
            revert(
                string.concat(
                    _roleName(holders[0].role), " still held by ", vm.toString(holders[0].account), ": core not frozen"
                )
            );
        }
        // No admin-changing entry point exists in the core; these pin that assumption.
        require(c.getRoleAdmin(ADMIN_ROLE) == DEFAULT_ADMIN_ROLE, "getRoleAdmin(ADMIN_ROLE) != DEFAULT_ADMIN_ROLE");
        require(
            c.getRoleAdmin(DEFAULT_ADMIN_ROLE) == DEFAULT_ADMIN_ROLE,
            "getRoleAdmin(DEFAULT_ADMIN_ROLE) != DEFAULT_ADMIN_ROLE"
        );
        require(!c.hasRole(ADMIN_ROLE, deployer), "deployer still has ADMIN_ROLE");
        require(!c.hasRole(DEFAULT_ADMIN_ROLE, deployer), "deployer still has DEFAULT_ADMIN_ROLE");
        require(c.platformFeeBP() == 0 && c.evaluatorFeeBP() == 0, "fees not zero");

        _probeAdminSurface(core, hook, deployer);
        address[] memory former = _everHeld(history);
        for (uint256 i = 0; i < former.length; i++) {
            if (former[i] != deployer) _probeAdminSurface(core, hook, former[i]);
        }
    }

    function _probeAdminSurface(address core, address hook, address caller) private {
        _expectUnauthorized(core, caller, abi.encodeCall(AgenticCommerce.setHookWhitelist, (hook, false)));
        _expectUnauthorized(core, caller, abi.encodeCall(AgenticCommerce.setPlatformFee, (1, caller)));
        _expectUnauthorized(core, caller, abi.encodeCall(AgenticCommerce.setEvaluatorFee, (1)));
        _expectUnauthorized(core, caller, abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(1), bytes("")));
    }

    function _expectUnauthorized(address core, address caller, bytes memory callData) private {
        vm.prank(caller);
        (bool ok, bytes memory ret) = core.call(callData);
        require(!ok, "admin call succeeded after freeze");
        require(ret.length >= 4 && bytes4(ret) == ACCESS_CONTROL_UNAUTHORIZED, "admin call reverted for another reason");
    }

    // ───────────────────────── Core-log replay ─────────────────────────
    //
    // The core uses plain AccessControlUpgradeable (not enumerable), and its hook whitelist is a
    // plain mapping, so who holds a role, which hooks are whitelisted and which implementations the
    // proxy ever pointed to are rebuilt from the core's events: RoleGranted / RoleRevoked,
    // HookWhitelistUpdated and ERC1967 Upgraded. Every state change behind those three questions
    // emits one of these events (the only exception: `initialize` whitelists hook 0x0 without an
    // event). The replay therefore only has to be COMPLETE (see every event); answers about the
    // present are re-confirmed against current (possibly simulated) state with `hasRole` and
    // `whitelistedHooks`, so missing later events or extra events can never hide a live holder.
    //
    // Two sources, merged:
    // 1. On chain: `vm.eth_getLogs` over [core deployBlock, block.number], chunked to the manifest's
    //    `.chain.maxLogBlockRange`, one query per event signature per chunk, each chunk sorted by
    //    (block, log index). Needs an RPC (forge script --rpc-url, or a fork). On Arc this is
    //    mandatory: a failed query reverts.
    // 2. Session: logs emitted inside this forge process, read with `vm.getRecordedLogs()`. Script
    //    entry points call `_startRoleLogCapture()`; a test calls `vm.recordLogs()` itself before it
    //    deploys the core. This covers state the chain has not seen yet: a simulation, a DeployLocal
    //    run, or a forge test with no RPC.

    /// @dev Start recording logs for the session source. In forge test the test owns the log
    ///      buffer (`vm.recordLogs()` would discard what it recorded), so this is a no-op there.
    function _startRoleLogCapture() internal {
        if (!vm.isContext(VmSafe.ForgeContext.TestGroup)) vm.recordLogs();
    }

    /// @notice Block window of the on-chain replay. `tolerant` (local mode or forge test) lets a
    ///         missing deployBlock or a missing RPC fall back to the session source alone.
    function _replayWindow()
        internal
        view
        returns (uint256 fromBlock, uint256 head, uint256 range, bool tolerant)
    {
        tolerant = _isLocal() || vm.isContext(VmSafe.ForgeContext.TestGroup);
        head = block.number;
        if (_isLocal()) {
            // Anvil chains are short, and a manifest from an earlier anvil session may be stale.
            fromBlock = 0;
        } else {
            fromBlock = _manifestUintOr(".contracts.core.deployBlock", type(uint256).max);
            require(
                fromBlock != type(uint256).max || tolerant,
                "manifest .contracts.core.deployBlock missing: needed for the core-log replay"
            );
            require(fromBlock <= head || tolerant, "manifest .contracts.core.deployBlock is after the current block");
        }
        range = _manifestUintOr(".chain.maxLogBlockRange", DEFAULT_MAX_LOG_BLOCK_RANGE);
        require(range != 0, "maxLogBlockRange is zero");
    }

    /// @notice Every log of `core` whose topic 0 is in `topic0s`: on-chain logs in chain order, then
    ///         session logs in emission order.
    function _replayCoreLogs(address core, bytes32[] memory topic0s) internal returns (ReplayLog[] memory logs) {
        (uint256 fromBlock, uint256 head, uint256 range, bool tolerant) = _replayWindow();
        ReplayLog[] memory onChain;
        if (fromBlock <= head) onChain = _onChainLogs(core, topic0s, fromBlock, head, range, tolerant);
        logs = _concatLogs(onChain, _sessionLogsOf(core, topic0s));
    }

    /// @notice The four tracked topics: RoleGranted, RoleRevoked, HookWhitelistUpdated, Upgraded.
    function _allTrackedTopics() internal pure returns (bytes32[] memory t) {
        t = new bytes32[](4);
        t[0] = ROLE_GRANTED_TOPIC;
        t[1] = ROLE_REVOKED_TOPIC;
        t[2] = HOOK_WHITELIST_UPDATED_TOPIC;
        t[3] = UPGRADED_TOPIC;
    }

    /// @notice Every ADMIN_ROLE and DEFAULT_ADMIN_ROLE grant and revoke on `core`: on-chain events in
    ///         chain order, then session events in emission order.
    function _roleHistory(address core) internal returns (RoleEvent[] memory events) {
        bytes32[] memory t = new bytes32[](2);
        t[0] = ROLE_GRANTED_TOPIC;
        t[1] = ROLE_REVOKED_TOPIC;
        events = _roleEventsFrom(_replayCoreLogs(core, t));
        _requireRoleReplayComplete(events);
    }

    /// @notice Completeness: the initializer grants both roles, so a replay that started at or before
    ///         the deploy block must contain both grants. Skipped in forge test, where the test decides
    ///         what is recorded and an RPC fork does not hold the test's own core.
    function _requireRoleReplayComplete(RoleEvent[] memory events) internal view {
        if (vm.isContext(VmSafe.ForgeContext.TestGroup)) return;
        require(
            _hasGrant(events, DEFAULT_ADMIN_ROLE) && _hasGrant(events, ADMIN_ROLE),
            "admin-role replay is incomplete: initial grants not found (wrong deployBlock, RPC log gap, or no RPC)"
        );
    }

    /// @notice Completeness for upgrades: the ERC1967Proxy constructor emits `Upgraded(initial impl)`,
    ///         so a complete replay holds at least one. Skipped in forge test (as above).
    function _requireUpgradeReplayComplete(UpgradeEvent[] memory events) internal view {
        if (vm.isContext(VmSafe.ForgeContext.TestGroup)) return;
        require(
            events.length != 0,
            "upgrade replay is incomplete: the proxy constructor's Upgraded event was not found (wrong deployBlock, RPC log gap, or no RPC)"
        );
    }

    // ── decoders ──

    function _roleEventsFrom(ReplayLog[] memory logs) internal pure returns (RoleEvent[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (_isRoleLog(logs[i])) n++;
        }
        out = new RoleEvent[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            ReplayLog memory l = logs[i];
            if (!_isRoleLog(l)) continue;
            out[n++] = RoleEvent({
                role: l.topics[1],
                account: address(uint160(uint256(l.topics[2]))),
                sender: address(uint160(uint256(l.topics[3]))),
                granted: l.topics[0] == ROLE_GRANTED_TOPIC,
                blockNumber: l.blockNumber,
                txHash: l.txHash,
                logIndex: l.logIndex,
                onChain: l.onChain
            });
        }
    }

    function _whitelistEventsFrom(ReplayLog[] memory logs) internal pure returns (WhitelistEvent[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (_isWhitelistLog(logs[i])) n++;
        }
        out = new WhitelistEvent[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            ReplayLog memory l = logs[i];
            if (!_isWhitelistLog(l)) continue;
            out[n++] = WhitelistEvent({
                hook: address(uint160(uint256(l.topics[1]))),
                status: abi.decode(l.data, (bool)),
                blockNumber: l.blockNumber,
                txHash: l.txHash,
                logIndex: l.logIndex,
                onChain: l.onChain
            });
        }
    }

    function _upgradeEventsFrom(ReplayLog[] memory logs) internal pure returns (UpgradeEvent[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (_isUpgradeLog(logs[i])) n++;
        }
        out = new UpgradeEvent[](n);
        n = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            ReplayLog memory l = logs[i];
            if (!_isUpgradeLog(l)) continue;
            out[n++] = UpgradeEvent({
                implementation: address(uint160(uint256(l.topics[1]))),
                blockNumber: l.blockNumber,
                txHash: l.txHash,
                logIndex: l.logIndex,
                onChain: l.onChain
            });
        }
    }

    function _isRoleLog(ReplayLog memory l) private pure returns (bool) {
        return l.topics.length == 4 && (l.topics[0] == ROLE_GRANTED_TOPIC || l.topics[0] == ROLE_REVOKED_TOPIC)
            && (l.topics[1] == ADMIN_ROLE || l.topics[1] == DEFAULT_ADMIN_ROLE);
    }

    function _isWhitelistLog(ReplayLog memory l) private pure returns (bool) {
        return l.topics.length == 2 && l.topics[0] == HOOK_WHITELIST_UPDATED_TOPIC && l.data.length == 32;
    }

    function _isUpgradeLog(ReplayLog memory l) private pure returns (bool) {
        return l.topics.length == 2 && l.topics[0] == UPGRADED_TOPIC;
    }

    // ── current state from history ──

    /// @notice Accounts that hold ADMIN_ROLE or DEFAULT_ADMIN_ROLE right now: every account granted
    ///         a role in `history` (plus `extra` for both roles, if nonzero), kept only if `hasRole`
    ///         confirms it. One entry per (role, account).
    function _roleHolders(address core, RoleEvent[] memory history, address extra)
        internal
        view
        returns (RoleHolder[] memory holders)
    {
        AgenticCommerce c = AgenticCommerce(core);
        RoleHolder[] memory tmp = new RoleHolder[](history.length + 2);
        uint256 n;
        for (uint256 i = 0; i < history.length + 2; i++) {
            bytes32 role;
            address account;
            if (i < history.length) {
                if (!history[i].granted) continue;
                (role, account) = (history[i].role, history[i].account);
            } else {
                if (extra == address(0)) continue;
                (role, account) = (i == history.length ? ADMIN_ROLE : DEFAULT_ADMIN_ROLE, extra);
            }
            if (!c.hasRole(role, account)) continue;
            bool seen;
            for (uint256 j = 0; j < n; j++) {
                if (tmp[j].role == role && tmp[j].account == account) seen = true;
            }
            if (!seen) tmp[n++] = RoleHolder(role, account);
        }
        holders = new RoleHolder[](n);
        for (uint256 i = 0; i < n; i++) holders[i] = tmp[i];
    }

    /// @notice Distinct accounts that were ever granted either role in `history`.
    function _everHeld(RoleEvent[] memory history) internal pure returns (address[] memory accounts) {
        address[] memory tmp = new address[](history.length);
        uint256 n;
        for (uint256 i = 0; i < history.length; i++) {
            if (!history[i].granted) continue;
            bool seen;
            for (uint256 j = 0; j < n; j++) {
                if (tmp[j] == history[i].account) seen = true;
            }
            if (!seen) tmp[n++] = history[i].account;
        }
        accounts = new address[](n);
        for (uint256 i = 0; i < n; i++) accounts[i] = tmp[i];
    }

    /// @notice Distinct hooks that some event whitelisted (status true) and that `whitelistedHooks`
    ///         still reports as whitelisted. Hook 0x0 appears only if an event names it.
    function _whitelistedNow(address core, WhitelistEvent[] memory history)
        internal
        view
        returns (address[] memory hooks)
    {
        AgenticCommerce c = AgenticCommerce(core);
        address[] memory tmp = new address[](history.length);
        uint256 n;
        for (uint256 i = 0; i < history.length; i++) {
            address h = history[i].hook;
            if (!history[i].status || !c.whitelistedHooks(h)) continue;
            bool seen;
            for (uint256 j = 0; j < n; j++) {
                if (tmp[j] == h) seen = true;
            }
            if (!seen) tmp[n++] = h;
        }
        hooks = new address[](n);
        for (uint256 i = 0; i < n; i++) hooks[i] = tmp[i];
    }

    // ── JSON and logging ──

    /// @notice `history` as a JSON array, for an evidence file or the manifest.
    function _roleHistoryJson(RoleEvent[] memory history) internal pure returns (string memory json) {
        json = "[";
        for (uint256 i = 0; i < history.length; i++) {
            RoleEvent memory e = history[i];
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                '{"event":"',
                e.granted ? "RoleGranted" : "RoleRevoked",
                '","role":"',
                _roleName(e.role),
                '","account":"',
                vm.toString(e.account),
                '","sender":"',
                vm.toString(e.sender),
                '",',
                _positionJson(e.blockNumber, e.txHash, e.logIndex, e.onChain),
                "}"
            );
        }
        json = string.concat(json, "]");
    }

    function _roleHoldersJson(RoleHolder[] memory holders) internal pure returns (string memory json) {
        json = "[";
        for (uint256 i = 0; i < holders.length; i++) {
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                '{"role":"',
                _roleName(holders[i].role),
                '","account":"',
                vm.toString(holders[i].account),
                '"}'
            );
        }
        json = string.concat(json, "]");
    }

    function _whitelistHistoryJson(WhitelistEvent[] memory history) internal pure returns (string memory json) {
        json = "[";
        for (uint256 i = 0; i < history.length; i++) {
            WhitelistEvent memory e = history[i];
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                '{"hook":"',
                vm.toString(e.hook),
                '","status":',
                e.status ? "true" : "false",
                ",",
                _positionJson(e.blockNumber, e.txHash, e.logIndex, e.onChain),
                "}"
            );
        }
        json = string.concat(json, "]");
    }

    function _upgradeHistoryJson(UpgradeEvent[] memory history) internal pure returns (string memory json) {
        json = "[";
        for (uint256 i = 0; i < history.length; i++) {
            UpgradeEvent memory e = history[i];
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                '{"implementation":"',
                vm.toString(e.implementation),
                '",',
                _positionJson(e.blockNumber, e.txHash, e.logIndex, e.onChain),
                "}"
            );
        }
        json = string.concat(json, "]");
    }

    function _addressArrayJson(address[] memory a) internal pure returns (string memory json) {
        json = "[";
        for (uint256 i = 0; i < a.length; i++) {
            json = string.concat(json, i == 0 ? "" : ",", _q(vm.toString(a[i])));
        }
        json = string.concat(json, "]");
    }

    /// @dev `"onChain":..,"block":..,"tx":"..","logIndex":..` (no braces).
    function _positionJson(uint256 blockNumber, bytes32 txHash, uint256 logIndex, bool onChain)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            '"onChain":',
            onChain ? "true" : "false",
            ',"block":',
            vm.toString(blockNumber),
            ',"tx":"',
            vm.toString(txHash),
            '","logIndex":',
            vm.toString(logIndex)
        );
    }

    function _positionText(uint256 blockNumber, bytes32 txHash, bool onChain) internal pure returns (string memory) {
        return onChain
            ? string.concat(" block ", vm.toString(blockNumber), " tx ", vm.toString(txHash))
            : " (session, not on chain)";
    }

    function _logRoleHistory(RoleEvent[] memory history) internal pure {
        console.log("admin-role events replayed:", history.length);
        for (uint256 i = 0; i < history.length; i++) {
            RoleEvent memory e = history[i];
            console.log(
                string.concat(
                    e.granted ? "  RoleGranted " : "  RoleRevoked ",
                    _roleName(e.role),
                    " account ",
                    vm.toString(e.account),
                    " sender ",
                    vm.toString(e.sender),
                    _positionText(e.blockNumber, e.txHash, e.onChain)
                )
            );
        }
    }

    function _roleName(bytes32 role) internal pure returns (string memory) {
        if (role == ADMIN_ROLE) return "ADMIN_ROLE";
        if (role == DEFAULT_ADMIN_ROLE) return "DEFAULT_ADMIN_ROLE";
        return vm.toString(role);
    }

    function _hasGrant(RoleEvent[] memory history, bytes32 role) private pure returns (bool) {
        for (uint256 i = 0; i < history.length; i++) {
            if (history[i].granted && history[i].role == role) return true;
        }
        return false;
    }

    // ── sources ──

    /// @dev Chunked `eth_getLogs`. When `tolerant` (local mode or forge test) and the very first
    ///      query fails, there is no RPC: return nothing and rely on the session source. Any other
    ///      failure reverts, so a live run never silently skips a block range.
    function _onChainLogs(
        address core,
        bytes32[] memory topic0s,
        uint256 fromBlock,
        uint256 toBlock,
        uint256 range,
        bool tolerant
    ) private returns (ReplayLog[] memory out) {
        bool first = true;
        for (uint256 start = fromBlock; start <= toBlock; start += range) {
            uint256 end = start + range - 1;
            if (end > toBlock) end = toBlock;
            (bool noRpc, ReplayLog[] memory chunk) = _fetchChunk(core, topic0s, start, end, first && tolerant);
            if (noRpc) return out; // no RPC at all
            first = false;
            _sortByPosition(chunk);
            out = _concatLogs(out, chunk);
            if (end == toBlock) break; // also guards `start += range` overflow at the top of the range
        }
    }

    /// @dev All `topic0s` logs on [start, end]. `noRpc` is true only when `allowNoRpc` and the very
    ///      first query failed; any other failure reverts.
    function _fetchChunk(address core, bytes32[] memory topic0s, uint256 start, uint256 end, bool allowNoRpc)
        private
        returns (bool noRpc, ReplayLog[] memory chunk)
    {
        for (uint256 t = 0; t < topic0s.length; t++) {
            (bool ok, ReplayLog[] memory part) = _fetchLogs(core, start, end, topic0s[t]);
            if (!ok) {
                if (allowNoRpc && t == 0) return (true, chunk);
                revert(
                    string.concat(
                        "eth_getLogs failed for blocks ", vm.toString(start), "-", vm.toString(end), " (need --rpc-url)"
                    )
                );
            }
            chunk = _concatLogs(chunk, part);
        }
    }

    /// @dev One `eth_getLogs` query for `topic0` on [start, end]. `ok` is false when the cheatcode
    ///      fails (no RPC, RPC error, range rejected).
    function _fetchLogs(address core, uint256 start, uint256 end, bytes32 topic0)
        private
        returns (bool ok, ReplayLog[] memory out)
    {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = topic0;
        try vm.eth_getLogs(start, end, core, topics) returns (VmSafe.EthGetLogs[] memory logs) {
            ok = true;
            uint256 n;
            for (uint256 i = 0; i < logs.length; i++) {
                if (_keepOnChain(logs[i], core, topic0)) n++;
            }
            out = new ReplayLog[](n);
            n = 0;
            for (uint256 i = 0; i < logs.length; i++) {
                VmSafe.EthGetLogs memory l = logs[i];
                if (!_keepOnChain(l, core, topic0)) continue;
                out[n++] = ReplayLog(l.topics, l.data, l.blockNumber, l.transactionHash, l.logIndex, true);
            }
        } catch {
            ok = false;
        }
    }

    function _keepOnChain(VmSafe.EthGetLogs memory l, address core, bytes32 topic0) private pure returns (bool) {
        return !l.removed && l.emitter == core && l.topics.length != 0 && l.topics[0] == topic0;
    }

    /// @dev Drains the cheatcode log buffer into `_sessionLogs` (tracked topics only), then returns
    ///      the stored logs of `core` whose topic 0 is in `topic0s`. Draining keeps them for later
    ///      calls in this run.
    function _sessionLogsOf(address core, bytes32[] memory topic0s) private returns (ReplayLog[] memory out) {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bytes32[] memory tracked = _allTrackedTopics();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || !_contains(tracked, logs[i].topics[0])) continue;
            _sessionLogs.push(SessionLog({emitter: logs[i].emitter, topics: logs[i].topics, data: logs[i].data}));
        }
        uint256 n;
        for (uint256 i = 0; i < _sessionLogs.length; i++) {
            if (_sessionLogs[i].emitter == core && _contains(topic0s, _sessionLogs[i].topics[0])) n++;
        }
        out = new ReplayLog[](n);
        n = 0;
        for (uint256 i = 0; i < _sessionLogs.length; i++) {
            SessionLog memory s = _sessionLogs[i];
            if (s.emitter != core || !_contains(topic0s, s.topics[0])) continue;
            out[n++] = ReplayLog(s.topics, s.data, 0, bytes32(0), 0, false);
        }
    }

    function _contains(bytes32[] memory set, bytes32 x) private pure returns (bool) {
        for (uint256 i = 0; i < set.length; i++) {
            if (set[i] == x) return true;
        }
        return false;
    }

    function _concatLogs(ReplayLog[] memory a, ReplayLog[] memory b) private pure returns (ReplayLog[] memory c) {
        if (b.length == 0) return a;
        if (a.length == 0) return b;
        c = new ReplayLog[](a.length + b.length);
        for (uint256 i = 0; i < a.length; i++) c[i] = a[i];
        for (uint256 i = 0; i < b.length; i++) c[a.length + i] = b[i];
    }

    /// @dev Insertion sort by (block, log index). Chunks are small.
    function _sortByPosition(ReplayLog[] memory a) private pure {
        for (uint256 i = 1; i < a.length; i++) {
            ReplayLog memory k = a[i];
            uint256 j = i;
            while (
                j > 0
                    && (a[j - 1].blockNumber > k.blockNumber
                        || (a[j - 1].blockNumber == k.blockNumber && a[j - 1].logIndex > k.logIndex))
            ) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = k;
        }
    }

    // ───────────────────────── Manifest helpers for read-only scripts ─────────────────────────

    /// @notice Bytes32 at `key` in the manifest. `present` is false when the file or key is missing
    ///         or the value is not a bytes32 (for example null).
    function _manifestBytes32(string memory key) internal view returns (bool present, bytes32 v) {
        string memory path = _manifestPath();
        if (!vm.exists(path)) return (false, bytes32(0));
        string memory json = vm.readFile(path);
        if (!vm.keyExistsJson(json, key)) return (false, bytes32(0));
        try vm.parseJsonBytes32(json, key) returns (bytes32 x) {
            return (true, x);
        } catch {
            return (false, bytes32(0));
        }
    }

    /// @notice Deliberate exception to the broadcast-only rule of `_manifestWrite`: writes `value` at
    ///         `key` WITHOUT a broadcast. Only for read-only scripts that never broadcast (06), and
    ///         only behind an explicit opt-in flag checked by the caller (`SETTLEMENT_WRITE_EVIDENCE`).
    ///         Refuses during a broadcast (where `_manifestWrite` is the right helper) and when the
    ///         manifest file does not exist (it never creates one).
    function _manifestWriteUnbroadcast(string memory key, string memory value) internal {
        require(!_broadcasting(), "_manifestWriteUnbroadcast must not run during a broadcast; use _manifestWrite");
        string memory path = _manifestPath();
        require(vm.exists(path), "manifest missing: refusing to create one from a read-only script");
        vm.writeJson(value, path, key);
    }

    /// @dev Unsigned integer at `key` in the manifest, or `dflt` when the file, key or value is
    ///      missing or not a number (for example null).
    function _manifestUintOr(string memory key, uint256 dflt) internal view returns (uint256) {
        string memory path = _manifestPath();
        if (!vm.exists(path)) return dflt;
        string memory json = vm.readFile(path);
        if (!vm.keyExistsJson(json, key)) return dflt;
        try vm.parseJsonUint(json, key) returns (uint256 v) {
            return v;
        } catch {
            return dflt;
        }
    }

    // ───────────────────────── Verification helpers (read-only) ─────────────────────────

    /// @dev Compares on-chain runtime code with the locally compiled patched core, ignoring what
    ///      legitimately differs:
    ///      - the UUPS `__self` immutable, the implementation's own address inlined as a 20-byte
    ///        PUSH20 operand (zeroed here; the artifact has zeros);
    ///      - the trailing CBOR metadata (its hash differs between a contract embedded in a script
    ///        and the standalone artifact, as measured locally; same masking as test/core/Provenance).
    function _implementationMatchesLocalBuild(address impl) internal view returns (bool) {
        bytes memory onchain = impl.code;
        bytes memory local = vm.getDeployedCode("src/core/src/AgenticCommercePatched.sol:AgenticCommerce");
        if (onchain.length != local.length || onchain.length < 2) return false;
        uint256 n = onchain.length;
        uint256 metaLen = (uint256(uint8(onchain[n - 2])) << 8) | uint256(uint8(onchain[n - 1]));
        if (metaLen + 2 >= n) return false;
        uint256 end = n - 2 - metaLen;
        uint256 pattern = uint256(uint160(impl));
        for (uint256 i = 0; i + 20 <= end; i++) {
            uint256 word;
            assembly {
                word := shr(96, mload(add(add(onchain, 32), i)))
            }
            if (word == pattern) {
                for (uint256 j = 0; j < 20; j++) {
                    onchain[i + j] = 0;
                }
                i += 19;
            }
        }
        return _hashPrefix(onchain, end) == _hashPrefix(local, end);
    }

    function _hashPrefix(bytes memory b, uint256 len) private pure returns (bytes32 h) {
        assembly {
            h := keccak256(add(b, 32), len)
        }
    }
}
