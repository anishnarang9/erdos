// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AgenticCommerce as Core} from "../src/core/src/AgenticCommercePatched.sol";
import {OpenClaimAdapter} from "../src/OpenClaimAdapter.sol";
import {RiscZeroGroth16Verifier} from "../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {ControlID} from "../src/verifier/groth16/ControlID.sol";

interface ILocalUSDC {
    function decimals() external view returns (uint8);
    function name() external view returns (string memory);
}

/// @notice Deploy the open-claim stack only on a fresh forkless local Arc node.
/// @dev Use Arc Anvil's native USDC predeploy. The deployed verifier is the real
///      RISC Zero 3.1.0 verifier. No key is read by this script.
contract DeployOpenClaimLocal is Script {
    uint256 internal constant ARC_CHAIN_ID = 5_042_002;
    address internal constant NATIVE_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant LIVE_CORE = 0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8;

    // vm.rpc ABI-encodes object fields in alphabetical order. These types match
    // the pinned Arc Anvil v1.7.1 response. Null fork fields encode as bytes32(0).
    // A different response schema fails closed during decoding.
    struct NodeEnvironment {
        bytes baseFee;
        uint256 chainId;
        bytes gasLimit;
        bytes gasPrice;
    }

    struct NodeForkConfig {
        bytes32 forkBlockNumber;
        bytes32 forkRetryBackoff;
        bytes32 forkUrl;
    }

    struct NodeInfo {
        bytes32 currentBlockHash;
        bytes currentBlockNumber;
        uint256 currentBlockTimestamp;
        NodeEnvironment environment;
        NodeForkConfig forkConfig;
        string hardFork;
        string network;
        string transactionOrder;
    }

    function run() external returns (address verifier, address implementation, address core, address adapter) {
        require(vm.envOr("OPEN_CLAIM_LOCAL", false), "OPEN_CLAIM_LOCAL=1 required");
        require(block.chainid == ARC_CHAIN_ID, "Arc chain ID required");
        _guardLocalRpc();
        require(block.number < 10_000, "fresh local node required");
        require(LIVE_CORE.code.length == 0, "live core exists; refusing deployment");
        require(NATIVE_USDC.code.length != 0, "local native USDC predeploy missing");
        require(ILocalUSDC(NATIVE_USDC).decimals() == 6, "USDC decimals mismatch");
        require(keccak256(bytes(ILocalUSDC(NATIVE_USDC).name())) == keccak256("USDC"), "Arc USDC required");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        require(deployer != address(0), "sender required");
        verifier = address(new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID));
        implementation = address(new Core());
        core = address(
            new ERC1967Proxy(implementation, abi.encodeCall(Core.initialize, (NATIVE_USDC, deployer, deployer)))
        );
        adapter = address(new OpenClaimAdapter(core, verifier, NATIVE_USDC));
        Core(core).renounceRole(Core(core).ADMIN_ROLE(), deployer);
        Core(core).renounceRole(Core(core).DEFAULT_ADMIN_ROLE(), deployer);
        vm.stopBroadcast();

        require(Core(core).platformFeeBP() == 0 && Core(core).evaluatorFeeBP() == 0, "nonzero fees");
        require(!Core(core).hasRole(Core(core).ADMIN_ROLE(), deployer), "admin remains");
        require(!Core(core).hasRole(Core(core).DEFAULT_ADMIN_ROLE(), deployer), "default admin remains");
        require(address(OpenClaimAdapter(adapter).core()) == core, "adapter core mismatch");
        require(address(OpenClaimAdapter(adapter).verifier()) == verifier, "adapter verifier mismatch");
        require(address(OpenClaimAdapter(adapter).usdc()) == NATIVE_USDC, "adapter token mismatch");

        _writeManifest(verifier, implementation, core, adapter);
        console.log("open-claim verifier", verifier);
        console.log("open-claim implementation", implementation);
        console.log("open-claim core", core);
        console.log("open-claim adapter", adapter);
    }

    /// @dev Inspect the active RPC. An opt-in or chain ID alone cannot identify a local node.
    function _guardLocalRpc() internal {
        bytes memory client = bytes(abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        require(client.length >= 6 && bytes6(client) == bytes6("anvil/"), "active RPC must be Anvil");
        bytes memory encodedInfo = vm.rpc("anvil_nodeInfo", "[]");
        // A non-null fork URL changes the fork tuple from static to dynamic.
        // Check its fixed header before decoding dynamic strings and arrays.
        bytes32[8] memory header = abi.decode(encodedInfo, (bytes32[8]));
        require(
            header[0] == bytes32(uint256(32)) && header[5] == bytes32(0) && header[6] == bytes32(0)
                && header[7] == bytes32(0),
            "forkless Anvil required"
        );
        NodeInfo memory info = abi.decode(encodedInfo, (NodeInfo));
        require(info.environment.chainId == ARC_CHAIN_ID, "RPC chain ID mismatch");
        require(keccak256(bytes(info.network)) == keccak256("arc"), "Arc Anvil required");
        require(
            info.forkConfig.forkUrl == bytes32(0) && info.forkConfig.forkBlockNumber == bytes32(0)
                && info.forkConfig.forkRetryBackoff == bytes32(0),
            "forkless Anvil required"
        );
    }

    /// @dev Forge writes this during simulation, before any broadcast receipts exist.
    ///      Keep transaction hashes and deployment blocks null until independent confirmation.
    function _writeManifest(address verifier, address implementation, address core, address adapter) internal {
        string memory path = string.concat(vm.projectRoot(), "/deployments/open-claim-local.json");
        vm.writeFile(
            path,
            string.concat(
                '{"schemaVersion":1,"interfaceVersion":"open-claim-v1","network":"local-arc",',
                '"status":"simulated","executionMode":"simulated","chainId":5042002,',
                '"usdc":{"address":"0x3600000000000000000000000000000000000000","decimals":6},',
                '"core":{},"coreImplementationRuntimeCodeHash":null,"verifier":{},"adapter":{},',
                '"policy":{"provider":"adapter","evaluator":"adapter",',
                '"hook":"0x0000000000000000000000000000000000000000","platformFeeBP":0,"evaluatorFeeBP":0,',
                '"minRegistrationExpiryMarginSeconds":600,"maxEnvelopeBytes":16412,"contextEscrow":"adapter",',
                '"contextProvider":"actual solver and payout address","wireVersion":1,',
                '"releaseBeforeExpiry":true,"refundAtOrAfterExpiry":true,',
                '"bountyFunding":"buyer approves and funds authentic core directly",',
                '"x402":"separate API operation fee; direct bounty funding unproven"},',
                '"abis":{"core":"abi/AgenticCommerce.json","adapter":"abi/OpenClaimAdapter.json",',
                '"verifier":"abi/IRiscZeroVerifier.json"},',
                '"evidence":{"adapterDeployed":false,"freshFundedProof":false,"liveArcExchange":false,',
                '"note":"Script simulation checked wiring, code hashes, zero fees and role renunciation. ',
                'Broadcast receipts and independent chain verification remain required."}}'
            )
        );

        vm.serializeAddress("openClaimCore", "address", core);
        vm.serializeAddress("openClaimCore", "implementation", implementation);
        vm.serializeBytes32("openClaimCore", "runtimeCodeHash", core.codehash);
        string memory coreJson = vm.serializeBool("openClaimCore", "frozen", true);
        vm.writeJson(coreJson, path, ".core");
        vm.writeJson("null", path, ".core.deployBlock");
        vm.writeJson(
            string.concat('"', vm.toString(implementation.codehash), '"'), path, ".coreImplementationRuntimeCodeHash"
        );

        vm.serializeAddress("openClaimVerifier", "address", verifier);
        vm.serializeBytes32("openClaimVerifier", "runtimeCodeHash", verifier.codehash);
        vm.serializeString("openClaimVerifier", "version", "3.1.0");
        string memory verifierJson = vm.serializeString("openClaimVerifier", "selector", "0xe71e6620");
        vm.writeJson(verifierJson, path, ".verifier");

        vm.serializeAddress("openClaimAdapter", "address", adapter);
        vm.serializeBytes32("openClaimAdapter", "runtimeCodeHash", adapter.codehash);
        vm.serializeString("openClaimAdapter", "contract", "src/OpenClaimAdapter.sol:OpenClaimAdapter");
        string memory adapterJson = vm.serializeString("openClaimAdapter", "abi", "abi/OpenClaimAdapter.json");
        vm.writeJson(adapterJson, path, ".adapter");
        vm.writeJson("null", path, ".adapter.deployTx");
        vm.writeJson("null", path, ".adapter.deployBlock");

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson('"broadcast-pending-confirmation"', path, ".status");
            vm.writeJson('"broadcast-requested"', path, ".executionMode");
        }
    }
}
