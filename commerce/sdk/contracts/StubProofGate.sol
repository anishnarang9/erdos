// SIMULATED: stand-in until Nick's settlement contracts land
// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IStubCore {
    struct Job {
        address client;
        address provider;
        address evaluator;
        address hook;
        uint256 budget;
        uint256 expiredAt;
        uint8 status;
        string description;
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function getJob(uint256 jobId) external view returns (Job memory);
}

interface IRiscZeroVerifierMin {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}

/// Hook and evaluator in one contract: freezes terms on fund, verifies the proof on submit,
/// and completes the job when the provider reveals the key that matches the commitment.
contract StubProofGate {
    struct Terms {
        bytes32 imageId;
        bytes32 rulesHash;
        bytes32 referenceHash;
        address provider;
        uint256 budget;
        uint256 expiredAt;
    }

    struct Acceptance {
        bytes32 envelopeHash;
        bytes32 keyCommitment;
    }

    uint256 public constant MAX_ENVELOPE_BYTES = 16384;
    uint8 internal constant SUBMITTED = 2;

    IStubCore public immutable core;
    IRiscZeroVerifierMin public immutable verifier;

    mapping(uint256 => Terms) internal terms;
    mapping(uint256 => Acceptance) internal acceptances;
    mapping(uint256 => bool) public released;

    event TermsFrozen(uint256 indexed jobId, bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash);
    event SubmissionAccepted(uint256 indexed jobId, bytes32 envelopeHash, bytes32 keyCommitment);
    event KeyReleased(uint256 indexed jobId, bytes32 key);

    error Unauthorized();
    error WrongStatus(uint8 status);
    error JobExpired();
    error InvalidTerms();
    error EnvelopeTooLarge();
    error EnvelopeHashMismatch();
    error KeyMismatch();
    error AlreadyReleased();

    constructor(address core_, address verifier_) {
        core = IStubCore(core_);
        verifier = IRiscZeroVerifierMin(verifier_);
    }

    modifier onlyCore() {
        if (msg.sender != address(core)) revert Unauthorized();
        _;
    }

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCore {
        if (selector == IStubCore.fund.selector) {
            (bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash) = abi.decode(data, (bytes32, bytes32, bytes32));
            if (imageId == bytes32(0) || rulesHash == bytes32(0) || referenceHash == bytes32(0)) revert InvalidTerms();
            // Evaluator binding: only this gate can complete the job, so it must be both evaluator and hook.
            IStubCore.Job memory job = core.getJob(jobId);
            if (job.evaluator != address(this) || job.hook != address(this)) revert InvalidTerms();
            Terms storage t = terms[jobId];
            t.imageId = imageId;
            t.rulesHash = rulesHash;
            t.referenceHash = referenceHash;
        } else if (selector == IStubCore.submit.selector) {
            _verifySubmission(jobId, data);
        }
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata /* data */) external onlyCore {
        if (selector == IStubCore.fund.selector) {
            IStubCore.Job memory job = core.getJob(jobId);
            Terms storage t = terms[jobId];
            t.provider = job.provider;
            t.budget = job.budget;
            t.expiredAt = job.expiredAt;
            emit TermsFrozen(jobId, t.imageId, t.rulesHash, t.referenceHash);
        }
    }

    function _verifySubmission(uint256 jobId, bytes calldata data) internal {
        (bytes32 deliverable, bytes memory optParams) = abi.decode(data, (bytes32, bytes));
        (bytes memory envelope, bytes memory seal, bytes32 keyCommitment) = abi.decode(optParams, (bytes, bytes, bytes32));
        if (envelope.length > MAX_ENVELOPE_BYTES) revert EnvelopeTooLarge();
        if (sha256(envelope) != deliverable) revert EnvelopeHashMismatch();
        bytes memory journal = abi.encodePacked(_context(jobId), uint8(1), deliverable, keyCommitment);
        verifier.verify(seal, terms[jobId].imageId, sha256(journal));
        acceptances[jobId] = Acceptance(deliverable, keyCommitment);
        emit SubmissionAccepted(jobId, deliverable, keyCommitment);
    }

    function _context(uint256 jobId) internal view returns (bytes memory) {
        Terms storage t = terms[jobId];
        return abi.encodePacked(uint8(1), block.chainid, address(core), jobId, t.provider, t.rulesHash, t.referenceHash);
    }

    function release(uint256 jobId, bytes32 key) external {
        Terms storage t = terms[jobId];
        if (t.provider == address(0) || msg.sender != t.provider) revert Unauthorized();
        uint8 status = core.getJob(jobId).status;
        if (status != SUBMITTED) revert WrongStatus(status);
        if (block.timestamp >= t.expiredAt) revert JobExpired();
        if (sha256(abi.encodePacked("UBC26/key/v1", _context(jobId), key)) != acceptances[jobId].keyCommitment) {
            revert KeyMismatch();
        }
        if (released[jobId]) revert AlreadyReleased();
        released[jobId] = true;
        core.complete(jobId, bytes32(0), "");
        emit KeyReleased(jobId, key);
    }

    function getTerms(uint256 jobId)
        external
        view
        returns (bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash, address provider, uint256 budget, uint256 expiredAt)
    {
        Terms storage t = terms[jobId];
        // Terms are only "frozen" once the fund after-hook ran (provider set).
        if (t.provider == address(0)) return (bytes32(0), bytes32(0), bytes32(0), address(0), 0, 0);
        return (t.imageId, t.rulesHash, t.referenceHash, t.provider, t.budget, t.expiredAt);
    }

    function getAcceptance(uint256 jobId) external view returns (bytes32 envelopeHash, bytes32 keyCommitment) {
        Acceptance storage a = acceptances[jobId];
        return (a.envelopeHash, a.keyCommitment);
    }
}
