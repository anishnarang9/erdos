// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {SettlementScript} from "./00_Config.s.sol";
import {AgenticCommerce} from "../src/core/src/AgenticCommercePatched.sol";
import {SettlementHook} from "../src/SettlementHook.sol";

/// @notice Read-only check of the live deployment against the manifest. Never broadcasts; run it
///         with `--rpc-url` and no signer after each live step.
///
///         Checks every manifest entry that is non-null. Set `SETTLEMENT_EXPECT_FROZEN=1` after step 5
///         to also require the freeze post-conditions (the deployer address comes from the manifest):
///         no address may hold ADMIN_ROLE or DEFAULT_ADMIN_ROLE, found by replaying the core's role
///         events with `eth_getLogs` from `.contracts.core.deployBlock` (needs `--rpc-url`).
///         Without it, the whitelist status is reported and never fails the run. A non-null manifest
///         address with no code on chain FAILS ("manifest address has no code: reset the entry or
///         rerun the step"), for example after a failed `--broadcast` that had written the manifest.
///
///         Once the core is deployed, it always replays the core's events (one `eth_getLogs` pass
///         over RoleGranted, RoleRevoked, HookWhitelistUpdated and Upgraded) and:
///         - reports the full admin-role history and the current holders (re-confirmed with hasRole);
///         - reports the full hook-whitelist history and FAILS if any hook other than the manifest
///           hook is still whitelisted after an event set it (hook 0x0, set by `initialize` with no
///           event, is allowed);
///         - FAILS if the proxy emitted more than one `Upgraded` event (any upgrade after the
///           constructor) or if that one event names another implementation than the manifest;
///         - computes keccak256 of the runtime code of verifier, core implementation, hook and core
///           proxy, and FAILS when `contracts.<name>.runtimeCodeHash` is set and differs (reported
///           only when the pin is absent or null).
///
///         `SETTLEMENT_WRITE_EVIDENCE=1` additionally writes all of the above into the manifest's
///         `evidence` object (see deployments/SCHEMA.md), after every check has passed. This is the
///         only manifest write in 06, and it uses `_manifestWriteUnbroadcast` on purpose.
///         Reverts with a message on the first failed check.
contract VerifyDeployment is SettlementScript {
    struct Addrs {
        address usdc;
        address verifier;
        address impl;
        address core;
        address hook;
        address deployer;
    }

    /// @dev Results of the core-log replay, kept for the report and the evidence block.
    struct History {
        RoleEvent[] roles;
        RoleHolder[] holders;
        WhitelistEvent[] whitelist;
        address[] whitelistedNow;
        UpgradeEvent[] upgrades;
        address implementationSlot;
        uint256 platformFeeBP;
        uint256 evaluatorFeeBP;
    }

    struct CodeHash {
        string name;
        address addr;
        bytes32 hash;
        uint256 size;
        bool pinned;
    }

    function run() external {
        _startRoleLogCapture();
        Config memory c = _loadConfig();
        _guardChain(c);
        Addrs memory a = Addrs({
            usdc: _resolveUsdc(c),
            verifier: _manifestAddress(".contracts.verifier.address"),
            impl: _manifestAddress(".contracts.coreImplementation.address"),
            core: _manifestAddress(".contracts.core.address"),
            hook: _manifestAddress(".contracts.hook.address"),
            deployer: _manifestAddress(".deployer")
        });

        require(a.usdc.code.length != 0, "USDC has no code");

        _checkContracts(c, a);

        History memory h;
        if (a.core != address(0)) h = _checkHistory(a);

        CodeHash[] memory codes = _checkCodeHashes(a);

        bool expectFrozen = vm.envOr("SETTLEMENT_EXPECT_FROZEN", false);
        if (!expectFrozen && a.core != address(0) && a.hook != address(0)) {
            if (AgenticCommerce(a.core).whitelistedHooks(a.hook)) {
                if (h.holders.length != 0) {
                    console.log("ok hook whitelisted (core NOT frozen: an address still holds an admin role)");
                } else {
                    console.log("ok hook whitelisted (no address holds an admin role)");
                }
            } else {
                console.log("note: hook not whitelisted yet (run step 05)");
            }
        }
        if (expectFrozen) {
            require(
                a.core != address(0) && a.hook != address(0) && a.deployer != address(0),
                "manifest incomplete for freeze check"
            );
            _checkFrozen(a.core, a.hook, a.deployer);
            console.log("ok frozen");
        }

        if (vm.envOr("SETTLEMENT_WRITE_EVIDENCE", false)) {
            require(a.core != address(0), "SETTLEMENT_WRITE_EVIDENCE needs a deployed core");
            _manifestWriteUnbroadcast(".evidence", evidenceJson(h, codes));
            console.log("evidence written to", _manifestPath());
        }
    }

    // ───────────────────────── Contract checks ─────────────────────────

    function _checkContracts(Config memory c, Addrs memory a) internal view {
        if (a.verifier != address(0)) {
            _requireCode("verifier", a.verifier);
            _requireRealVerifier(a.verifier);
            console.log("ok verifier", a.verifier);
        }
        if (a.impl != address(0)) {
            _requireCode("core implementation", a.impl);
            require(AgenticCommerce(a.impl).proxiableUUID() == ERC1967_IMPLEMENTATION_SLOT, "impl not UUPS");
            require(_implementationMatchesLocalBuild(a.impl), "implementation bytecode != local patched build");
            console.log("ok core implementation", a.impl);
        }
        if (a.core != address(0)) {
            _requireCode("core proxy", a.core);
            AgenticCommerce k = AgenticCommerce(a.core);
            require(_implementationSlot(a.core) == a.impl, "proxy implementation slot");
            require(address(k.paymentToken()) == a.usdc, "paymentToken");
            require(k.platformFeeBP() == 0 && k.evaluatorFeeBP() == 0, "fees not zero");
            console.log("ok core proxy", a.core);
        }
        if (a.hook != address(0)) {
            _requireCode("hook", a.hook);
            _requireRealVerifier(a.verifier);
            SettlementHook h = SettlementHook(a.hook);
            require(h.supportsInterface(IACP_HOOK_ID), "hook ERC-165");
            require(
                address(h.core()) == a.core && address(h.verifier()) == a.verifier && h.usdc() == a.usdc,
                "hook immutables"
            );
            require(h.MAX_ENVELOPE_BYTES() == c.maxEnvelopeBytes, "MAX_ENVELOPE_BYTES");
            require(h.MIN_EXPIRY_MARGIN() == c.minExpiryMargin, "MIN_EXPIRY_MARGIN");
            console.log("ok hook", a.hook);
        }
    }

    function _implementationSlot(address core) internal view returns (address) {
        return address(uint160(uint256(vm.load(core, ERC1967_IMPLEMENTATION_SLOT))));
    }

    // ───────────────────────── Event history ─────────────────────────

    function _checkHistory(Addrs memory a) internal returns (History memory h) {
        ReplayLog[] memory logs = _replayCoreLogs(a.core, _allTrackedTopics());
        AgenticCommerce k = AgenticCommerce(a.core);

        // (a) Admin roles: full history and current holders.
        h.roles = _roleEventsFrom(logs);
        _requireRoleReplayComplete(h.roles);
        _logRoleHistory(h.roles);
        h.holders = _roleHolders(a.core, h.roles, a.deployer);
        console.log("current admin-role holders:", h.holders.length);
        for (uint256 i = 0; i < h.holders.length; i++) {
            console.log(string.concat("  ", _roleName(h.holders[i].role), " ", vm.toString(h.holders[i].account)));
        }

        // (b) Hook whitelist: only the manifest hook (and 0x0) may be whitelisted now.
        h.whitelist = _whitelistEventsFrom(logs);
        _logWhitelistHistory(h.whitelist);
        h.whitelistedNow = _whitelistedNow(a.core, h.whitelist);
        for (uint256 i = 0; i < h.whitelistedNow.length; i++) {
            address w = h.whitelistedNow[i];
            if (w != a.hook && w != address(0)) {
                revert(string.concat("hook whitelist: ", vm.toString(w), " is whitelisted but is not the manifest hook"));
            }
        }
        console.log("ok hook whitelist history (no foreign hook whitelisted)");

        // (c) Upgrades: only the constructor's Upgraded event, naming the manifest implementation.
        h.upgrades = _upgradeEventsFrom(logs);
        _requireUpgradeReplayComplete(h.upgrades);
        _logUpgradeHistory(h.upgrades);
        if (h.upgrades.length > 1) {
            revert(
                string.concat(
                    "core proxy was upgraded after deployment: ", vm.toString(h.upgrades.length), " Upgraded events"
                )
            );
        }
        if (h.upgrades.length == 1) {
            require(h.upgrades[0].implementation == a.impl, "initial Upgraded event names another implementation than the manifest");
        }
        h.implementationSlot = _implementationSlot(a.core);
        require(h.implementationSlot == a.impl, "proxy implementation slot");
        console.log("ok upgrade history (initial implementation only)");

        // (d) Fees (already required to be zero by the contract checks).
        h.platformFeeBP = k.platformFeeBP();
        h.evaluatorFeeBP = k.evaluatorFeeBP();
        require(h.platformFeeBP == 0 && h.evaluatorFeeBP == 0, "fees not zero");
    }

    function _logWhitelistHistory(WhitelistEvent[] memory history) internal pure {
        console.log("HookWhitelistUpdated events replayed:", history.length);
        for (uint256 i = 0; i < history.length; i++) {
            WhitelistEvent memory e = history[i];
            console.log(
                string.concat(
                    "  hook ",
                    vm.toString(e.hook),
                    e.status ? " -> true" : " -> false",
                    _positionText(e.blockNumber, e.txHash, e.onChain)
                )
            );
        }
    }

    function _logUpgradeHistory(UpgradeEvent[] memory history) internal pure {
        console.log("Upgraded events replayed:", history.length);
        for (uint256 i = 0; i < history.length; i++) {
            UpgradeEvent memory e = history[i];
            console.log(
                string.concat(
                    "  implementation ",
                    vm.toString(e.implementation),
                    _positionText(e.blockNumber, e.txHash, e.onChain)
                )
            );
        }
    }

    // ───────────────────────── Runtime code hashes ─────────────────────────

    function _checkCodeHashes(Addrs memory a) internal view returns (CodeHash[] memory codes) {
        codes = new CodeHash[](4);
        codes[0] = _codeHash("verifier", a.verifier);
        codes[1] = _codeHash("coreImplementation", a.impl);
        codes[2] = _codeHash("hook", a.hook);
        codes[3] = _codeHash("core", a.core);
    }

    /// @dev keccak256 of the runtime code at `addr`, compared with `.contracts.<name>.runtimeCodeHash`
    ///      when that pin is present. A null address yields an empty entry (no check).
    function _codeHash(string memory name, address addr) internal view returns (CodeHash memory ch) {
        ch.name = name;
        ch.addr = addr;
        if (addr == address(0)) return ch;
        bytes memory code = addr.code;
        ch.hash = keccak256(code);
        ch.size = code.length;
        (bool present, bytes32 pin) = _manifestBytes32(string.concat(".contracts.", name, ".runtimeCodeHash"));
        ch.pinned = present;
        if (present) {
            if (pin != ch.hash) {
                revert(
                    string.concat(
                        name,
                        ": runtime code hash ",
                        vm.toString(ch.hash),
                        " != manifest runtimeCodeHash ",
                        vm.toString(pin)
                    )
                );
            }
            console.log(string.concat("ok ", name, " runtimeCodeHash ", vm.toString(ch.hash), " (", vm.toString(ch.size), " bytes)"));
        } else {
            console.log(
                string.concat(
                    "note: ", name, " runtimeCodeHash ", vm.toString(ch.hash), " (", vm.toString(ch.size), " bytes), no pin in manifest"
                )
            );
        }
    }

    // ───────────────────────── Evidence ─────────────────────────

    /// @notice The `evidence` object written under `SETTLEMENT_WRITE_EVIDENCE=1`.
    function evidenceJson(History memory h, CodeHash[] memory codes) internal view returns (string memory) {
        (uint256 fromBlock,, uint256 range,) = _replayWindow();
        string memory head = string.concat(
            '{"generatedBy":"script/06_Verify.s.sol","chainId":',
            vm.toString(block.chainid),
            ',"block":',
            vm.toString(block.number),
            ',"blockTimestamp":',
            vm.toString(block.timestamp),
            ',"replayFromBlock":',
            vm.toString(fromBlock),
            ',"maxLogBlockRange":',
            vm.toString(range)
        );
        string memory roles = string.concat(
            ',"roles":{"history":',
            _roleHistoryJson(h.roles),
            ',"currentHolders":',
            _roleHoldersJson(h.holders),
            ',"noAdminHolders":',
            h.holders.length == 0 ? "true" : "false",
            "}"
        );
        string memory wl = string.concat(
            ',"hookWhitelist":{"history":',
            _whitelistHistoryJson(h.whitelist),
            ',"whitelistedNow":',
            _addressArrayJson(h.whitelistedNow),
            "}"
        );
        string memory up = string.concat(
            ',"upgrades":{"history":',
            _upgradeHistoryJson(h.upgrades),
            ',"implementationSlot":',
            _q(vm.toString(h.implementationSlot)),
            "}"
        );
        string memory fees = string.concat(
            ',"fees":{"platformFeeBP":',
            vm.toString(h.platformFeeBP),
            ',"evaluatorFeeBP":',
            vm.toString(h.evaluatorFeeBP),
            "}"
        );
        return string.concat(head, roles, wl, up, fees, ',"runtimeCode":', _codesJson(codes), "}");
    }

    function _codesJson(CodeHash[] memory codes) internal pure returns (string memory json) {
        json = "{";
        for (uint256 i = 0; i < codes.length; i++) {
            CodeHash memory ch = codes[i];
            json = string.concat(json, i == 0 ? "" : ",", _q(ch.name), ":");
            if (ch.addr == address(0)) {
                json = string.concat(json, "null");
                continue;
            }
            json = string.concat(
                json,
                '{"address":',
                _q(vm.toString(ch.addr)),
                ',"runtimeCodeHash":',
                _q(vm.toString(ch.hash)),
                ',"runtimeCodeSize":',
                vm.toString(ch.size),
                ',"matchesManifestPin":',
                ch.pinned ? "true" : "null",
                "}"
            );
        }
        json = string.concat(json, "}");
    }
}
