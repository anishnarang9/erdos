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

    /// @dev Reverts if `existing` is already deployed on this chain and no override is set.
    function _refuseRedeploy(string memory what, address existing) internal view {
        if (existing != address(0) && existing.code.length != 0 && !_allowRedeploy()) {
            console.log(what, "already deployed at", existing);
            revert("already deployed; set SETTLEMENT_ALLOW_REDEPLOY=1 to override");
        }
    }

    function _requireCode(string memory what, address a) internal view {
        require(a != address(0) && a.code.length != 0, string.concat(what, ": no code at manifest address"));
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

    /// @dev Whitelists the hook, then renounces ADMIN_ROLE and DEFAULT_ADMIN_ROLE. Re-running after
    ///      a complete freeze only repeats the post-condition checks. Partial states resume.
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

        vm.startBroadcast();
        if (!wl) c.setHookWhitelist(hook, true);
        if (isAdmin) c.renounceRole(ADMIN_ROLE, deployer);
        if (isDefaultAdmin) c.renounceRole(DEFAULT_ADMIN_ROLE, deployer);
        vm.stopBroadcast();

        _checkFrozen(core, hook, deployer);

        _manifestWrite(".contracts.core.frozen", "true");
        _manifestWrite(".status", _q("frozen"));
        console.log("frozen: hook whitelisted, deployer roles renounced");
    }

    /// @dev Post-conditions of the freeze. Uses `vm.prank` and so must not run during a broadcast.
    function _checkFrozen(address core, address hook, address deployer) internal {
        AgenticCommerce c = AgenticCommerce(core);
        require(c.whitelistedHooks(hook), "hook not whitelisted");
        require(c.whitelistedHooks(address(0)), "zero hook lost its whitelist");
        require(!c.hasRole(ADMIN_ROLE, deployer), "deployer still has ADMIN_ROLE");
        require(!c.hasRole(DEFAULT_ADMIN_ROLE, deployer), "deployer still has DEFAULT_ADMIN_ROLE");
        require(c.platformFeeBP() == 0 && c.evaluatorFeeBP() == 0, "fees not zero");

        _expectUnauthorized(core, deployer, abi.encodeCall(AgenticCommerce.setHookWhitelist, (hook, false)));
        _expectUnauthorized(core, deployer, abi.encodeCall(AgenticCommerce.setPlatformFee, (1, deployer)));
        _expectUnauthorized(core, deployer, abi.encodeCall(AgenticCommerce.setEvaluatorFee, (1)));
        _expectUnauthorized(core, deployer, abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(1), bytes("")));
    }

    function _expectUnauthorized(address core, address caller, bytes memory callData) private {
        vm.prank(caller);
        (bool ok, bytes memory ret) = core.call(callData);
        require(!ok, "admin call succeeded after freeze");
        require(ret.length >= 4 && bytes4(ret) == ACCESS_CONTROL_UNAUTHORIZED, "admin call reverted for another reason");
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
