// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.9;

import {IRiscZeroVerifier, Receipt, ReceiptClaimLib} from "./IRiscZeroVerifier.sol";

/// @notice Test double for `IRiscZeroVerifier` that accepts only explicitly registered proofs.
/// @dev NOT the upstream `RiscZeroMockVerifier` (risc0-ethereum `contracts/src/test/RiscZeroMockVerifier.sol`).
///      The upstream mock has a selector constructor argument and accepts any seal of the form
///      `selector || claimDigest`, so it needs no setup but also cannot reject a chosen triple.
///      This mock is constructed empty. A test calls `expect(seal, imageId, journalDigest)` for every
///      proof that should verify, and every other `(seal, imageId, journalDigest)` reverts with
///      `UnexpectedProof`. Several triples can be registered at once. The mock does not check seal
///      contents, length, or selector, so a test must use the exact registered seal bytes.
///      Never deploy this contract outside tests.
contract MockRiscZeroVerifier is IRiscZeroVerifier {
    /// @notice Raised when the presented proof was not registered with `expect`.
    error UnexpectedProof();

    /// @notice Emitted when a triple is registered.
    event ProofExpected(bytes32 indexed key, bytes32 imageId, bytes32 journalDigest);

    mapping(bytes32 => bool) public accepted;
    mapping(bytes32 => bool) private acceptedIntegrity;

    /// @notice Register a `(seal, imageId, journalDigest)` triple that `verify` must accept.
    /// @dev Callable by anyone and repeatable. The matching `verifyIntegrity` receipt (same seal and
    ///      the claim digest of a successful run of `imageId` with `journalDigest`) is also accepted.
    function expect(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external {
        bytes32 key = keccak256(abi.encode(seal, imageId, journalDigest));
        accepted[key] = true;
        acceptedIntegrity[keccak256(abi.encode(seal, ReceiptClaimLib.digest(ReceiptClaimLib.ok(imageId, journalDigest))))] =
            true;
        emit ProofExpected(key, imageId, journalDigest);
    }

    /// @notice Key under which a triple is stored.
    function keyOf(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external pure returns (bytes32) {
        return keccak256(abi.encode(seal, imageId, journalDigest));
    }

    /// @inheritdoc IRiscZeroVerifier
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view {
        bytes32 key = keccak256(abi.encode(seal, imageId, journalDigest));
        if (!accepted[key]) revert UnexpectedProof();
    }

    /// @inheritdoc IRiscZeroVerifier
    /// @dev Accepts a receipt only if its seal and claim digest match a triple registered through
    ///      `expect`.
    function verifyIntegrity(Receipt calldata receipt) external view {
        bytes32 key = keccak256(abi.encode(receipt.seal, receipt.claimDigest));
        if (!acceptedIntegrity[key]) revert UnexpectedProof();
    }
}
