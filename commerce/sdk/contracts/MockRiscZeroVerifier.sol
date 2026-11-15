// SIMULATED: stand-in until Nick's settlement contracts land
// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// Accepts only seal == 0xe71e6620 ‖ sha256(imageId ‖ journalDigest). Not a real proof check.
contract MockRiscZeroVerifier {
    error VerificationFailed();

    bytes4 public constant SELECTOR = 0xe71e6620;

    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view {
        this; // keep `view` to match IRiscZeroVerifier.verify
        bytes memory expected = abi.encodePacked(SELECTOR, sha256(abi.encodePacked(imageId, journalDigest)));
        if (keccak256(seal) != keccak256(expected)) revert VerificationFailed();
    }
}
