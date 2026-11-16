// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
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

    function run() external returns (address verifier, address implementation, address core, address adapter) {
        require(vm.envOr("OPEN_CLAIM_LOCAL", false), "OPEN_CLAIM_LOCAL=1 required");
        require(block.chainid == ARC_CHAIN_ID, "Arc chain ID required");
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

        console.log("open-claim verifier", verifier);
        console.log("open-claim implementation", implementation);
        console.log("open-claim core", core);
        console.log("open-claim adapter", adapter);
    }
}
