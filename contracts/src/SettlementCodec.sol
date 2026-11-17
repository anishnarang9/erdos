// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SettlementCodec
/// @notice Byte formats shared with the RISC Zero engine. They must stay byte-identical to
///         ZKVM-IMPLEMENTATION.md Section 3 and SETTLEMENT-IMPLEMENTATION.md Section 7.
///
///         context       = 0x01 || chainId[32] || escrow[20] || jobId[32] || provider[20]
///                         || rulesHash[32] || referenceHash[32]                       (169 bytes)
///         journal       = context || verdict[1] || envelopeHash[32] || keyCommitment[32] (234 bytes)
///         journalDigest = SHA256(journal)
///         keyCommitment = SHA256("UBC26/key/v1" || context || key[32])
library SettlementCodec {
    uint8 internal constant CONTEXT_VERSION = 0x01;
    uint8 internal constant VERDICT_PASS = 0x01;
    uint256 internal constant CONTEXT_LENGTH = 169;
    uint256 internal constant JOURNAL_LENGTH = 234;
    bytes internal constant KEY_DOMAIN = "UBC26/key/v1";

    function context(
        uint256 chainId,
        address escrow,
        uint256 jobId,
        address provider,
        bytes32 rulesHash,
        bytes32 referenceHash
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            CONTEXT_VERSION, bytes32(chainId), escrow, bytes32(jobId), provider, rulesHash, referenceHash
        );
    }

    function journal(bytes memory ctx, uint8 verdict, bytes32 envelopeHash, bytes32 commitment)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(ctx, verdict, envelopeHash, commitment);
    }

    function keyCommitment(bytes memory ctx, bytes32 key) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(KEY_DOMAIN, ctx, key));
    }
}
