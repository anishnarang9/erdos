// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {RiscZeroGroth16Verifier, SelectorMismatch} from "../../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {ControlID} from "../../src/verifier/groth16/ControlID.sol";
import {VerificationFailed} from "../../src/verifier/IRiscZeroVerifier.sol";
import {TestReceipt} from "../verifier/TestReceiptV3_1.sol";

/// @notice Evidence that the pinned RISC Zero v3.1.0 Groth16 verifier works on live Arc.
///
///         This deploys the verifier INTO A FORK of live Arc Testnet state (nothing is broadcast), so the
///         real Arc BN254 (0x06, 0x07, 0x08) and sha256 (0x02) precompiles execute. It is not a deployed
///         contract: see research/ARC-VERIFIER.md for what a live deployment adds.
///
///         Skips itself unless the chain ID is 5042002, so the local suite stays green. Run:
///           arc-forge test --network arc --fork-url https://rpc.testnet.arc.io \
///             --fork-block-number <N> --match-path 'test/fork/*' -vv
contract ArcVerifierForkTest is Test {
    uint256 internal constant ARC_CHAIN_ID = 5042002;
    uint256 internal constant GAS_CAP = 3_000_000;

    RiscZeroGroth16Verifier internal verifier;
    bytes32 internal journalDigest;

    function setUp() public {
        if (block.chainid != ARC_CHAIN_ID) {
            vm.skip(true);
            return;
        }
        verifier = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID);
        journalDigest = sha256(TestReceipt.JOURNAL);
    }

    function test_forkBlockAndChain() public view {
        console.log("chainid", block.chainid);
        console.log("fork block", block.number);
        assertEq(block.chainid, ARC_CHAIN_ID);
    }

    function test_selectorVersionAndControlIds() public view {
        assertEq(verifier.SELECTOR(), bytes4(0xe71e6620), "SELECTOR");
        assertEq(verifier.VERSION(), "3.1.0", "VERSION");
        assertEq(verifier.BN254_CONTROL_ID(), ControlID.BN254_CONTROL_ID, "BN254_CONTROL_ID");
        assertEq(TestReceipt.SEAL.length, 260, "seal length");
        assertEq(bytes4(TestReceipt.SEAL), verifier.SELECTOR(), "receipt selector");
        console.log("PASS SELECTOR 0xe71e6620, VERSION 3.1.0");
    }

    function test_validReceiptVerifiesOnArcPrecompiles() public view {
        bytes memory seal = TestReceipt.SEAL;
        bytes32 imageId = TestReceipt.IMAGE_ID;
        uint256 g = gasleft();
        verifier.verify(seal, imageId, journalDigest);
        console.log("PASS valid receipt verifies; verify() gas (external call incl. overhead)", g - gasleft());
    }

    function test_flippedJournalByteReverts() public {
        bytes memory journal = TestReceipt.JOURNAL;
        for (uint256 i = 0; i < journal.length; i++) {
            bytes memory mutated = abi.encodePacked(journal);
            mutated[i] = bytes1(uint8(mutated[i]) ^ 0x01);
            bytes32 digest = sha256(mutated); // before expectRevert: sha256 is a call
            vm.expectRevert(VerificationFailed.selector);
            verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, digest);
        }
        console.log("PASS flipped journal byte reverts VerificationFailed (all positions):", journal.length);
    }

    function test_changedImageIdReverts() public {
        vm.expectRevert(VerificationFailed.selector);
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID ^ bytes32(uint256(1)), journalDigest);
        console.log("PASS changed image ID reverts VerificationFailed");
    }

    /// A tampered point is off the curve, so a BN254 precompile call fails and burns all the gas it was
    /// forwarded. The explicit gas cap keeps that bounded. The verifier still ends in VerificationFailed.
    function test_flippedProofByteReverts() public {
        uint256[4] memory offsets = [uint256(4), 36, 132, 259];
        for (uint256 k = 0; k < offsets.length; k++) {
            bytes memory seal = abi.encodePacked(TestReceipt.SEAL);
            seal[offsets[k]] = bytes1(uint8(seal[offsets[k]]) ^ 0x01);
            uint256 g = gasleft();
            try verifier.verify{gas: GAS_CAP}(seal, TestReceipt.IMAGE_ID, journalDigest) {
                revert("tampered seal verified");
            } catch (bytes memory err) {
                assertEq(bytes4(err), VerificationFailed.selector, "expected VerificationFailed");
            }
            console.log("PASS flipped proof byte reverts VerificationFailed; offset", offsets[k]);
            console.log("   gas used (cap 3000000)", g - gasleft());
        }
    }

    function test_changedSelectorByteReverts() public {
        for (uint256 i = 0; i < 4; i++) {
            bytes memory seal = abi.encodePacked(TestReceipt.SEAL);
            seal[i] = bytes1(uint8(seal[i]) ^ 0x01);
            vm.expectRevert(abi.encodeWithSelector(SelectorMismatch.selector, bytes4(seal), verifier.SELECTOR()));
            verifier.verify(seal, TestReceipt.IMAGE_ID, journalDigest);
        }
        console.log("PASS changed selector byte reverts SelectorMismatch (all 4 bytes)");
    }
}
