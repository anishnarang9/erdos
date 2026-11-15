// SIMULATED: stand-in until Nick's settlement contracts land
// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IJobHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// ERC-8183 draft-shaped job escrow. Status: Open=0, Funded=1, Submitted=2, Completed=3, Rejected=4, Expired=5.
contract StubCore {
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

    uint8 internal constant OPEN = 0;
    uint8 internal constant FUNDED = 1;
    uint8 internal constant SUBMITTED = 2;
    uint8 internal constant COMPLETED = 3;
    uint8 internal constant EXPIRED = 5;

    IERC20Min public immutable token;
    uint256 public jobCount;
    mapping(uint256 => Job) internal jobs;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        address hook,
        uint256 expiredAt
    );
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error Unauthorized();
    error WrongStatus(uint8 status);
    error InvalidExpiry();
    error ZeroBudget();
    error BudgetMismatch();
    error JobExpired();
    error NotExpired();
    error TransferFailed();
    error Reentrancy();

    uint256 private locked = 1;

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address token_) {
        token = IERC20Min(token_);
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        if (expiredAt <= block.timestamp) revert InvalidExpiry();
        jobId = ++jobCount;
        jobs[jobId] = Job(msg.sender, provider, evaluator, hook, 0, expiredAt, OPEN, description);
        emit JobCreated(jobId, msg.sender, provider, evaluator, hook, expiredAt);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata /* optParams */) external {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();
        if (job.status != OPEN) revert WrongStatus(job.status);
        job.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != OPEN) revert WrongStatus(job.status);
        if (job.budget == 0) revert ZeroBudget();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        if (job.hook != address(0)) IJobHook(job.hook).beforeAction(jobId, this.fund.selector, optParams);
        if (!token.transferFrom(msg.sender, address(this), job.budget)) revert TransferFailed();
        job.status = FUNDED;
        if (job.hook != address(0)) IJobHook(job.hook).afterAction(jobId, this.fund.selector, optParams);
        emit JobFunded(jobId, msg.sender, job.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.provider) revert Unauthorized();
        if (job.status != FUNDED) revert WrongStatus(job.status);
        if (block.timestamp >= job.expiredAt) revert JobExpired();
        bytes memory data = abi.encode(deliverable, optParams);
        if (job.hook != address(0)) IJobHook(job.hook).beforeAction(jobId, this.submit.selector, data);
        job.status = SUBMITTED;
        if (job.hook != address(0)) IJobHook(job.hook).afterAction(jobId, this.submit.selector, data);
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata /* optParams */) external nonReentrant {
        Job storage job = jobs[jobId];
        if (msg.sender != job.evaluator) revert Unauthorized();
        if (job.status != SUBMITTED) revert WrongStatus(job.status);
        job.status = COMPLETED;
        uint256 amount = job.budget;
        if (!token.transfer(job.provider, amount)) revert TransferFailed();
        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, amount);
    }

    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != FUNDED && job.status != SUBMITTED) revert WrongStatus(job.status);
        if (block.timestamp < job.expiredAt) revert NotExpired();
        job.status = EXPIRED;
        uint256 amount = job.budget;
        if (!token.transfer(job.client, amount)) revert TransferFailed();
        emit Refunded(jobId, job.client, amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
