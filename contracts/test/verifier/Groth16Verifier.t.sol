// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// S16: upstream TestReceiptV3_1 on the real RiscZeroGroth16Verifier, plus the mock verifier.
// forge-std is not vendored in this repo (foundry.toml `libs = []`), so this file declares the few
// cheatcodes it needs and logs through the Hardhat console address.

import {RiscZeroGroth16Verifier, SelectorMismatch} from "../../src/verifier/groth16/RiscZeroGroth16Verifier.sol";
import {ControlID} from "../../src/verifier/groth16/ControlID.sol";
import {
    IRiscZeroVerifier,
    Receipt,
    ReceiptClaim,
    ReceiptClaimLib,
    VerificationFailed
} from "../../src/verifier/IRiscZeroVerifier.sol";
import {MockRiscZeroVerifier} from "../../src/verifier/MockRiscZeroVerifier.sol";
import {TestReceipt} from "./TestReceiptV3_1.sol";

interface Vm {
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
}

contract Groth16VerifierTest {
    using ReceiptClaimLib for ReceiptClaim;

    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    RiscZeroGroth16Verifier internal verifier;
    bytes32 internal journalDigest;

    function setUp() public {
        verifier = new RiscZeroGroth16Verifier(ControlID.CONTROL_ROOT, ControlID.BN254_CONTROL_ID);
        journalDigest = sha256(TestReceipt.JOURNAL);
    }

    function _log(string memory label, uint256 value) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", label, value));
        ok;
    }

    function _eq(bool cond, string memory why) internal pure {
        require(cond, why);
    }

    // ---------------------------------------------------------------- real verifier

    function testSelectorAndVersion() external view {
        _eq(verifier.SELECTOR() == bytes4(0xe71e6620), "selector");
        _eq(keccak256(bytes(verifier.VERSION())) == keccak256("3.1.0"), "version");
        _eq(verifier.BN254_CONTROL_ID() == ControlID.BN254_CONTROL_ID, "bn254 control id");
        _eq(TestReceipt.SEAL.length == 260, "seal length");
        _eq(bytes4(TestReceipt.SEAL) == verifier.SELECTOR(), "receipt selector");
    }

    function testUpstreamReceiptVerifies() external view {
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, journalDigest);
    }

    function testUpstreamReceiptVerifiesViaIntegrity() external view {
        bytes32 claimDigest = ReceiptClaimLib.ok(TestReceipt.IMAGE_ID, journalDigest).digest();
        verifier.verifyIntegrity(Receipt(TestReceipt.SEAL, claimDigest));
    }

    function testVerificationGas() external view {
        bytes memory seal = TestReceipt.SEAL;
        bytes32 imageId = TestReceipt.IMAGE_ID;
        uint256 before = gasleft();
        verifier.verify(seal, imageId, journalDigest);
        uint256 used = before - gasleft();
        _log("verify gas (external call, incl. overhead)", used);
        _eq(used > 100_000 && used < 1_000_000, "gas out of expected range");
    }

    function testFlippedJournalByteReverts() external {
        bytes memory journal = TestReceipt.JOURNAL;
        for (uint256 i = 0; i < journal.length; i++) {
            bytes memory mutated = abi.encodePacked(journal);
            mutated[i] = bytes1(uint8(mutated[i]) ^ 0x01);
            bytes32 digest = sha256(mutated); // compute before expectRevert: sha256 is a call
            vm.expectRevert(VerificationFailed.selector);
            verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, digest);
        }
    }

    function testChangedImageIdReverts() external {
        vm.expectRevert(VerificationFailed.selector);
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID ^ bytes32(uint256(1)), journalDigest);
        vm.expectRevert(VerificationFailed.selector);
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID ^ bytes32(uint256(1) << 255), journalDigest);
    }

    function testChangedJournalDigestReverts() external {
        vm.expectRevert(VerificationFailed.selector);
        verifier.verify(TestReceipt.SEAL, TestReceipt.IMAGE_ID, journalDigest ^ bytes32(uint256(1)));
    }

    /// A tampered proof must never verify. A coordinate that is off the curve makes a BN254 precompile
    /// call fail, and a failed precompile call consumes all the gas forwarded to it. The verifier still
    /// reports VerificationFailed(), but only after burning nearly all the gas it was given. `burned`
    /// is true when more than 2.5M of the 3M gas cap was used.
    function _assertTamperedSealRejected(bytes memory seal) internal returns (bool burned) {
        uint256 before = gasleft();
        try verifier.verify{gas: 3_000_000}(seal, TestReceipt.IMAGE_ID, journalDigest) {
            revert("tampered seal verified");
        } catch (bytes memory err) {
            _eq(bytes4(err) == VerificationFailed.selector, "expected VerificationFailed");
        }
        burned = before - gasleft() > 2_500_000;
    }

    /// Flip the low bit of every byte of the 256-byte proof part (offsets 4..259).
    function testChangedProofByteReverts() external {
        uint256 burned;
        for (uint256 i = 4; i < 260; i++) {
            bytes memory seal = abi.encodePacked(TestReceipt.SEAL);
            seal[i] = bytes1(uint8(seal[i]) ^ 0x01);
            if (_assertTamperedSealRejected(seal)) burned++;
        }
        _log("low-bit flips that burned >2.5M of a 3M gas cap (of 256)", burned);
    }

    /// Flip the high bit of a handful of proof bytes (pushes coordinates out of the field).
    function testHighBitProofByteReverts() external {
        uint256[5] memory offsets = [uint256(4), 36, 100, 164, 259];
        for (uint256 k = 0; k < offsets.length; k++) {
            bytes memory seal = abi.encodePacked(TestReceipt.SEAL);
            seal[offsets[k]] = bytes1(uint8(seal[offsets[k]]) ^ 0x80);
            _assertTamperedSealRejected(seal);
        }
    }

    function testChangedSelectorReverts() external {
        for (uint256 i = 0; i < 4; i++) {
            bytes memory seal = abi.encodePacked(TestReceipt.SEAL);
            seal[i] = bytes1(uint8(seal[i]) ^ 0x01);
            vm.expectRevert(abi.encodeWithSelector(SelectorMismatch.selector, bytes4(seal), verifier.SELECTOR()));
            verifier.verify(seal, TestReceipt.IMAGE_ID, journalDigest);
        }
    }

    function testTruncatedAndEmptySealRevert() external {
        bytes memory full = TestReceipt.SEAL;
        bytes memory shortSeal = new bytes(259);
        for (uint256 i = 0; i < 259; i++) {
            shortSeal[i] = full[i];
        }
        vm.expectRevert();
        verifier.verify(shortSeal, TestReceipt.IMAGE_ID, journalDigest);
        vm.expectRevert();
        verifier.verify("", TestReceipt.IMAGE_ID, journalDigest);
    }

    // ---------------------------------------------------------------- mock verifier

    function testMockAcceptsRegisteredTriple() external {
        MockRiscZeroVerifier mock = new MockRiscZeroVerifier();
        bytes memory seal = hex"aabbcc";
        mock.expect(seal, bytes32(uint256(1)), bytes32(uint256(2)));
        mock.verify(seal, bytes32(uint256(1)), bytes32(uint256(2)));
        IRiscZeroVerifier(address(mock)).verify(seal, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function testMockSupportsSeveralTriples() external {
        MockRiscZeroVerifier mock = new MockRiscZeroVerifier();
        mock.expect(hex"01", bytes32(uint256(1)), bytes32(uint256(2)));
        mock.expect(hex"02", bytes32(uint256(3)), bytes32(uint256(4)));
        mock.verify(hex"01", bytes32(uint256(1)), bytes32(uint256(2)));
        mock.verify(hex"02", bytes32(uint256(3)), bytes32(uint256(4)));
    }

    function testMockRejectsEverythingWhenEmpty() external {
        MockRiscZeroVerifier mock = new MockRiscZeroVerifier();
        vm.expectRevert(MockRiscZeroVerifier.UnexpectedProof.selector);
        mock.verify(hex"aabbcc", bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function testMockRejectsAnySingleFieldChange() external {
        MockRiscZeroVerifier mock = new MockRiscZeroVerifier();
        bytes memory seal = hex"aabbcc";
        mock.expect(seal, bytes32(uint256(1)), bytes32(uint256(2)));

        vm.expectRevert(MockRiscZeroVerifier.UnexpectedProof.selector);
        mock.verify(hex"aabbcd", bytes32(uint256(1)), bytes32(uint256(2)));

        vm.expectRevert(MockRiscZeroVerifier.UnexpectedProof.selector);
        mock.verify(hex"aabbcc00", bytes32(uint256(1)), bytes32(uint256(2)));

        vm.expectRevert(MockRiscZeroVerifier.UnexpectedProof.selector);
        mock.verify(seal, bytes32(uint256(3)), bytes32(uint256(2)));

        vm.expectRevert(MockRiscZeroVerifier.UnexpectedProof.selector);
        mock.verify(seal, bytes32(uint256(1)), bytes32(uint256(3)));
    }

    function testMockVerifyIntegrity() external {
        MockRiscZeroVerifier mock = new MockRiscZeroVerifier();
        bytes32 img = bytes32(uint256(1));
        bytes32 jd = bytes32(uint256(2));
        mock.expect(hex"aabbcc", img, jd);
        bytes32 claimDigest = ReceiptClaimLib.ok(img, jd).digest();
        mock.verifyIntegrity(Receipt(hex"aabbcc", claimDigest));

        vm.expectRevert(MockRiscZeroVerifier.UnexpectedProof.selector);
        mock.verifyIntegrity(Receipt(hex"aabbcc", claimDigest ^ bytes32(uint256(1))));
        vm.expectRevert(MockRiscZeroVerifier.UnexpectedProof.selector);
        mock.verifyIntegrity(Receipt(hex"aabbcd", claimDigest));
    }
}
