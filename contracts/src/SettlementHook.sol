// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IACPHook} from "./core/src/interfaces/IACPHook.sol";
import {ISettlementCore} from "./interfaces/ISettlementCore.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {SettlementCodec} from "./SettlementCodec.sol";

/// @title SettlementHook
/// @notice ERC-8183 hook and evaluator for proof-gated jobs. Spec: SETTLEMENT-IMPLEMENTATION.md Section 6.
///
///         The Poster creates a job with this contract as both hook and evaluator, sets a positive
///         budget, and funds it with the image ID, rules hash and reference hash. The funded Solver
///         submits an encrypted envelope and a Groth16 seal; `submit` reverts unless the proof
///         verifies against the journal rebuilt from frozen terms with verdict 1. The Solver then
///         calls `release` with the key; this contract checks the key commitment and calls the
///         core's `complete`, which pays the Solver. There is no reject path: the Poster recovers
///         funds only through the core's permissionless `claimRefund` after expiry.
contract SettlementHook is IACPHook {
    // ───────────────────────── Types and storage ─────────────────────────

    struct Terms {
        bytes32 imageId;
        bytes32 rulesHash;
        bytes32 referenceHash;
        address provider;
        uint256 budget;
        uint64 expiry;
        bool funded;
    }

    struct Submission {
        bytes32 envelopeHash;
        bytes32 keyCommitment;
        bool accepted;
    }

    /// @dev ERC-165 interface ID of IERC165 itself.
    bytes4 private constant ERC165_ID = 0x01ffc9a7;

    ISettlementCore public immutable core;
    IProofVerifier public immutable verifier;
    address public immutable usdc;
    /// @notice Largest envelope `submit` accepts, in bytes.
    uint256 public immutable MAX_ENVELOPE_BYTES;
    /// @notice Seconds a job must still have before expiry at the moment it is funded.
    uint256 public immutable MIN_EXPIRY_MARGIN;

    mapping(uint256 => Terms) public terms;
    mapping(uint256 => Submission) public submissions;
    mapping(uint256 => bool) public released;

    /// @dev Job ID whose `complete` call `release` is driving, or 0. Core job IDs start at 1.
    uint256 private transient _releasingJobId;

    // ───────────────────────── Events and errors ─────────────────────────

    event TermsFrozen(
        uint256 indexed jobId,
        address indexed provider,
        bytes32 imageId,
        bytes32 rulesHash,
        bytes32 referenceHash,
        uint256 budget,
        uint64 expiry
    );
    event ProofAccepted(uint256 indexed jobId, bytes32 envelopeHash, bytes32 keyCommitment);
    event KeyReleased(uint256 indexed jobId, address indexed provider, bytes32 key, bytes32 envelopeHash);

    error NotCore();
    error ZeroAddress();
    error PaymentTokenMismatch();
    error WrongEvaluator();
    error ZeroProvider();
    error ZeroBudget();
    error UnexpectedOptParams();
    error BadFundParams();
    error ExpiryTooSoon();
    error NotFundedStatus();
    error ExpiryOverflow();
    error NotFunded();
    error NotProvider();
    error Expired();
    error AlreadyAccepted();
    error EnvelopeTooLarge();
    error EnvelopeHashMismatch();
    error NotAccepted();
    error AlreadyReleased();
    error WrongKey();
    error CompleteNotFromRelease();

    // ───────────────────────── Construction ─────────────────────────

    constructor(
        ISettlementCore core_,
        IProofVerifier verifier_,
        address usdc_,
        uint256 maxEnvelopeBytes_,
        uint256 minExpiryMargin_
    ) {
        if (address(core_) == address(0) || address(verifier_) == address(0) || usdc_ == address(0)) {
            revert ZeroAddress();
        }
        if (core_.paymentToken() != usdc_) revert PaymentTokenMismatch();
        core = core_;
        verifier = verifier_;
        usdc = usdc_;
        MAX_ENVELOPE_BYTES = maxEnvelopeBytes_;
        MIN_EXPIRY_MARGIN = minExpiryMargin_;
    }

    modifier onlyCore() {
        if (msg.sender != address(core)) revert NotCore();
        _;
    }

    // ───────────────────────── ERC-165 ─────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == ERC165_ID;
    }

    // ───────────────────────── Hook callbacks ─────────────────────────

    /// @inheritdoc IACPHook
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCore {
        if (selector == ISettlementCore.setBudget.selector) {
            _beforeSetBudget(data);
        } else if (selector == ISettlementCore.fund.selector) {
            _beforeFund(jobId, data);
        } else if (selector == ISettlementCore.submit.selector) {
            _beforeSubmit(jobId, data);
        } else if (selector == ISettlementCore.complete.selector) {
            if (_releasingJobId != jobId) revert CompleteNotFromRelease();
        }
        // reject and any other selector: allowed without state changes.
    }

    /// @inheritdoc IACPHook
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCore {
        if (selector == ISettlementCore.createJob.selector) {
            (, address provider, address evaluator) = abi.decode(data, (address, address, address));
            if (evaluator != address(this)) revert WrongEvaluator();
            if (provider == address(0)) revert ZeroProvider();
        } else if (selector == ISettlementCore.fund.selector) {
            _afterFund(jobId, data);
        } else if (selector == ISettlementCore.submit.selector) {
            (, bytes32 envelopeHash, bytes memory optParams) = abi.decode(data, (address, bytes32, bytes));
            (,, bytes32 keyCommitment) = abi.decode(optParams, (bytes, bytes, bytes32));
            submissions[jobId] = Submission({envelopeHash: envelopeHash, keyCommitment: keyCommitment, accepted: true});
            emit ProofAccepted(jobId, envelopeHash, keyCommitment);
        }
    }

    function _beforeSetBudget(bytes calldata data) private pure {
        (, uint256 amount, bytes memory optParams) = abi.decode(data, (address, uint256, bytes));
        if (amount == 0) revert ZeroBudget();
        if (optParams.length != 0) revert UnexpectedOptParams();
    }

    function _beforeFund(uint256 jobId, bytes calldata data) private view {
        (, bytes memory optParams) = abi.decode(data, (address, bytes));
        // Exactly abi.encode(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash).
        if (optParams.length != 96) revert BadFundParams();
        ISettlementCore.Job memory job = core.getJob(jobId);
        if (job.budget == 0) revert ZeroBudget();
        if (job.provider == address(0)) revert ZeroProvider();
        if (job.expiredAt < block.timestamp + MIN_EXPIRY_MARGIN) revert ExpiryTooSoon();
    }

    function _afterFund(uint256 jobId, bytes calldata data) private {
        (, bytes memory optParams) = abi.decode(data, (address, bytes));
        (bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash) =
            abi.decode(optParams, (bytes32, bytes32, bytes32));
        ISettlementCore.Job memory job = core.getJob(jobId);
        if (job.status != ISettlementCore.JobStatus.Funded) revert NotFundedStatus();
        if (job.expiredAt > type(uint64).max) revert ExpiryOverflow();
        uint64 expiry = uint64(job.expiredAt);
        terms[jobId] = Terms({
            imageId: imageId,
            rulesHash: rulesHash,
            referenceHash: referenceHash,
            provider: job.provider,
            budget: job.budget,
            expiry: expiry,
            funded: true
        });
        emit TermsFrozen(jobId, job.provider, imageId, rulesHash, referenceHash, job.budget, expiry);
    }

    function _beforeSubmit(uint256 jobId, bytes calldata data) private view {
        (address caller, bytes32 deliverable, bytes memory optParams) = abi.decode(data, (address, bytes32, bytes));
        (bytes memory envelope, bytes memory seal, bytes32 keyCommitment) =
            abi.decode(optParams, (bytes, bytes, bytes32));

        Terms storage t = terms[jobId];
        if (!t.funded) revert NotFunded();
        if (caller != t.provider) revert NotProvider();
        if (block.timestamp >= t.expiry) revert Expired();
        if (submissions[jobId].accepted) revert AlreadyAccepted();
        if (envelope.length > MAX_ENVELOPE_BYTES) revert EnvelopeTooLarge();
        if (sha256(envelope) != deliverable) revert EnvelopeHashMismatch();

        bytes memory journal =
            SettlementCodec.journal(_context(jobId, t), SettlementCodec.VERDICT_PASS, deliverable, keyCommitment);
        verifier.verify(seal, t.imageId, sha256(journal));
    }

    // ───────────────────────── Release ─────────────────────────

    /// @notice Reveal the envelope key and collect the bounty. Only the funded Solver may call it,
    ///         after an accepted submission and before expiry. A failed payout reverts everything.
    function release(uint256 jobId, bytes32 key) external {
        Terms storage t = terms[jobId];
        Submission storage s = submissions[jobId];
        if (msg.sender != t.provider || t.provider == address(0)) revert NotProvider();
        if (!s.accepted) revert NotAccepted();
        if (released[jobId]) revert AlreadyReleased();
        if (block.timestamp >= t.expiry) revert Expired();

        bytes32 commitment = s.keyCommitment;
        if (SettlementCodec.keyCommitment(_context(jobId, t), key) != commitment) revert WrongKey();

        released[jobId] = true;
        _releasingJobId = jobId;
        core.complete(jobId, commitment, "");
        _releasingJobId = 0;

        emit KeyReleased(jobId, msg.sender, key, s.envelopeHash);
    }

    // ───────────────────────── Views ─────────────────────────

    /// @notice The 169-byte funded context for a job, built from frozen terms. Empty terms give a
    ///         context with zero fields; check `terms(jobId).funded` first.
    function contextOf(uint256 jobId) external view returns (bytes memory) {
        return _context(jobId, terms[jobId]);
    }

    /// @notice The verdict-1 journal and its digest `submit` would verify for these commitments.
    function expectedJournal(uint256 jobId, bytes32 envelopeHash, bytes32 keyCommitment)
        external
        view
        returns (bytes memory journal, bytes32 journalDigest)
    {
        journal = SettlementCodec.journal(
            _context(jobId, terms[jobId]), SettlementCodec.VERDICT_PASS, envelopeHash, keyCommitment
        );
        journalDigest = sha256(journal);
    }

    function _context(uint256 jobId, Terms storage t) private view returns (bytes memory) {
        return SettlementCodec.context(block.chainid, address(core), jobId, t.provider, t.rulesHash, t.referenceHash);
    }
}
