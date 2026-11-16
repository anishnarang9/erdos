// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AgenticCommerce as Core} from "./core/src/AgenticCommercePatched.sol";
import {IProofVerifier} from "./interfaces/IProofVerifier.sol";
import {SettlementCodec} from "./SettlementCodec.sol";

/// @notice Proof-gated, first-valid-solver claims against a funded ERC-8183 job.
/// @dev The buyer creates a hookless core job with this adapter as both provider and evaluator.
///      The core keeps the USDC until release or its permissionless expiry refund.
contract OpenClaimAdapter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Terms {
        address buyer;
        bytes32 imageId;
        bytes32 rulesHash;
        bytes32 referenceHash;
        uint256 budget;
        uint64 expiry;
        bool registered;
    }

    struct Submission {
        address solver;
        bytes32 envelopeHash;
        bytes32 keyCommitment;
        bool accepted;
    }

    uint256 public constant MAX_ENVELOPE_BYTES = 16_412;
    uint256 public constant MIN_EXPIRY_MARGIN = 600;

    Core public immutable core;
    IProofVerifier public immutable verifier;
    IERC20 public immutable usdc;

    mapping(uint256 => Terms) public terms;
    mapping(uint256 => Submission) public submissions;
    mapping(uint256 => bool) public released;

    event TermsRegistered(
        uint256 indexed jobId,
        address indexed buyer,
        bytes32 imageId,
        bytes32 rulesHash,
        bytes32 referenceHash,
        uint256 budget,
        uint64 expiry
    );
    event ClaimAccepted(
        uint256 indexed jobId, address indexed solver, bytes32 envelopeHash, bytes32 keyCommitment, bytes envelope
    );
    event KeyReleased(uint256 indexed jobId, address indexed solver, bytes32 key, bytes32 envelopeHash, uint256 amount);

    error ZeroAddress();
    error MissingCode();
    error PaymentTokenMismatch();
    error InvalidTerms();
    error CoreJobMismatch();
    error FeesEnabled();
    error ExpiryTooSoon();
    error Expired();
    error AlreadyRegistered();
    error AlreadyAccepted();
    error EnvelopeTooLarge();
    error NotWinner();
    error WrongKey();
    error AlreadyReleased();
    error WrongPaymentAmount();

    constructor(address core_, address verifier_, address usdc_) {
        if (core_ == address(0) || verifier_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        if (core_.code.length == 0 || verifier_.code.length == 0 || usdc_.code.length == 0) revert MissingCode();
        if (address(Core(core_).paymentToken()) != usdc_) revert PaymentTokenMismatch();
        core = Core(core_);
        verifier = IProofVerifier(verifier_);
        usdc = IERC20(usdc_);
        _checkTokenAndFees();
    }

    /// @notice Freeze buyer-approved proof terms after the core holds the exact budget.
    function register(
        uint256 jobId,
        bytes32 imageId,
        bytes32 rulesHash,
        bytes32 referenceHash,
        uint256 expectedBudget,
        uint64 expectedExpiry
    ) external nonReentrant {
        if (terms[jobId].registered) revert AlreadyRegistered();
        if (expectedBudget == 0) revert InvalidTerms();
        if (uint256(expectedExpiry) < block.timestamp + MIN_EXPIRY_MARGIN) revert ExpiryTooSoon();
        Core.Job memory job = core.getJob(jobId);
        if (
            job.id != jobId || job.client != msg.sender || job.provider != address(this)
                || job.evaluator != address(this) || job.hook != address(0) || job.status != Core.JobStatus.Funded
                || job.budget != expectedBudget || job.expiredAt != expectedExpiry
        ) revert CoreJobMismatch();
        _checkTokenAndFees();
        terms[jobId] = Terms({
            buyer: msg.sender,
            imageId: imageId,
            rulesHash: rulesHash,
            referenceHash: referenceHash,
            budget: expectedBudget,
            expiry: expectedExpiry,
            registered: true
        });
        emit TermsRegistered(jobId, msg.sender, imageId, rulesHash, referenceHash, expectedBudget, expectedExpiry);
    }

    /// @notice The first solver with a verified verdict-1 receipt reserves the job.
    function claim(uint256 jobId, bytes calldata envelope, bytes calldata seal, bytes32 keyCommitment)
        external
        nonReentrant
    {
        Terms storage t = terms[jobId];
        if (!t.registered) revert InvalidTerms();
        if (block.timestamp >= t.expiry) revert Expired();
        if (submissions[jobId].accepted) revert AlreadyAccepted();
        if (envelope.length > MAX_ENVELOPE_BYTES) revert EnvelopeTooLarge();
        _checkCoreJob(jobId, t, Core.JobStatus.Funded);

        bytes32 envelopeHash = sha256(envelope);
        bytes memory journal = SettlementCodec.journal(
            _context(jobId, msg.sender, t), SettlementCodec.VERDICT_PASS, envelopeHash, keyCommitment
        );
        verifier.verify(seal, t.imageId, sha256(journal));

        submissions[jobId] =
            Submission({solver: msg.sender, envelopeHash: envelopeHash, keyCommitment: keyCommitment, accepted: true});
        core.submit(jobId, envelopeHash, "");
        emit ClaimAccepted(jobId, msg.sender, envelopeHash, keyCommitment, envelope);
    }

    /// @notice Reveal the accepted key and send exactly this job's budget to its solver.
    function release(uint256 jobId, bytes32 key) external nonReentrant {
        Terms storage t = terms[jobId];
        Submission storage s = submissions[jobId];
        if (!t.registered || !s.accepted || msg.sender != s.solver) revert NotWinner();
        if (released[jobId]) revert AlreadyReleased();
        if (block.timestamp >= t.expiry) revert Expired();
        _checkCoreJob(jobId, t, Core.JobStatus.Submitted);
        if (SettlementCodec.keyCommitment(_context(jobId, s.solver, t), key) != s.keyCommitment) {
            revert WrongKey();
        }

        uint256 adapterBefore = usdc.balanceOf(address(this));
        uint256 solverBefore = usdc.balanceOf(s.solver);
        released[jobId] = true;
        core.complete(jobId, s.keyCommitment, "");
        uint256 adapterAfterCore = usdc.balanceOf(address(this));
        if (adapterAfterCore < adapterBefore || adapterAfterCore - adapterBefore != t.budget) {
            revert WrongPaymentAmount();
        }
        usdc.safeTransfer(s.solver, t.budget);
        uint256 adapterAfter = usdc.balanceOf(address(this));
        uint256 solverAfter = usdc.balanceOf(s.solver);
        if (adapterAfter != adapterBefore || solverAfter < solverBefore || solverAfter - solverBefore != t.budget) {
            revert WrongPaymentAmount();
        }
        emit KeyReleased(jobId, s.solver, key, s.envelopeHash, t.budget);
    }

    function contextOf(uint256 jobId, address solver) external view returns (bytes memory) {
        return _context(jobId, solver, terms[jobId]);
    }

    function expectedJournal(uint256 jobId, address solver, bytes32 envelopeHash, bytes32 keyCommitment)
        external
        view
        returns (bytes memory journal, bytes32 journalDigest)
    {
        journal = SettlementCodec.journal(
            _context(jobId, solver, terms[jobId]), SettlementCodec.VERDICT_PASS, envelopeHash, keyCommitment
        );
        journalDigest = sha256(journal);
    }

    function _context(uint256 jobId, address solver, Terms storage t) private view returns (bytes memory) {
        return SettlementCodec.context(block.chainid, address(this), jobId, solver, t.rulesHash, t.referenceHash);
    }

    function _checkCoreJob(uint256 jobId, Terms storage t, Core.JobStatus status) private view {
        Core.Job memory job = core.getJob(jobId);
        if (
            job.id != jobId || job.client != t.buyer || job.provider != address(this) || job.evaluator != address(this)
                || job.hook != address(0) || job.status != status || job.budget != t.budget || job.expiredAt != t.expiry
        ) revert CoreJobMismatch();
        _checkTokenAndFees();
    }

    function _checkTokenAndFees() private view {
        if (address(core.paymentToken()) != address(usdc)) revert PaymentTokenMismatch();
        if (core.platformFeeBP() != 0 || core.evaluatorFeeBP() != 0) revert FeesEnabled();
    }
}
