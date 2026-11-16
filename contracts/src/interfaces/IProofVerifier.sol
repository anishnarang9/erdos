// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The one method of RISC Zero's IRiscZeroVerifier (v3.1.0) that SettlementHook calls.
/// @dev Same selector and ABI as upstream `verify(bytes,bytes32,bytes32)`. Reverts on failure.
interface IProofVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}
