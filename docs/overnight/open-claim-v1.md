# Open-claim escrow v1

2026-11-16 — Anish — Normative interface and implementation checkpoint. Local acceptance passed; live acceptance remains pending.

## Deployment policy

Reuse the frozen patched `AgenticCommerce` core from `contracts/deployments/arc-testnet.json` and `contracts/abi/AgenticCommerce.json`. Core: `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8`. Verifier: `0xCf8D70A203b40D3A17d023c0CDDF752870BC3992`, released RISC Zero 3.1.0, seal selector `0xe71e6620`. Arc USDC: `0x3600000000000000000000000000000000000000`, six decimals. Chain: 5042002. Both core fees must equal zero. Preserve `SettlementHook` and its selected-provider path.

Deploy `OpenClaimAdapter` separately. The target core permits `hook = address(0)` without another whitelist transaction. No new core is required on testnet. Local deployment creates the same patched core and real verifier on a forkless Arc node with native local USDC. Test doubles belong only in tests. Verify deployment provenance, immutable wiring, fee policy and freeze before any live use. No live deployment or spending is authorized by this document.

## Normative adapter API

```solidity
constructor(address core_, address verifier_, address usdc_);
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
function register(uint256 jobId, bytes32 imageId, bytes32 rulesHash,
    bytes32 referenceHash, uint256 expectedBudget, uint64 expectedExpiry) external;
function claim(uint256 jobId, bytes calldata envelope, bytes calldata seal,
    bytes32 keyCommitment) external;
function release(uint256 jobId, bytes32 key) external;
function contextOf(uint256 jobId, address solver) external view returns (bytes memory);
function expectedJournal(uint256 jobId, address solver, bytes32 envelopeHash,
    bytes32 keyCommitment) external view returns (bytes memory journal, bytes32 journalDigest);
// Public immutable getters: core(), verifier(), usdc().
// Public mapping getters: terms(jobId), submissions(jobId), released(jobId).
// Constants: MAX_ENVELOPE_BYTES() = 16412, MIN_EXPIRY_MARGIN() = 600.
```

`terms` and `submissions` return fields in the declared struct order. This API uses `msg.sender` as both proof identity and payout identity. It has no alternate payout address or relayer identity.

## Function selectors and events

| Call | Selector |
| --- | --- |
| `register(uint256,bytes32,bytes32,bytes32,uint256,uint64)` | `0x22c1d372` |
| `claim(uint256,bytes,bytes,bytes32)` | `0xdbadcda7` |
| `release(uint256,bytes32)` | `0xdd20edf9` |
| `contextOf(uint256,address)` | `0xd19aca07` |
| `expectedJournal(uint256,address,bytes32,bytes32)` | `0x981fa9ee` |
| `terms(uint256)` | `0xc0aa0e8a` |
| `submissions(uint256)` | `0xad73349e` |
| `released(uint256)` | `0xa94d373b` |

```solidity
event TermsRegistered(uint256 indexed jobId, address indexed buyer,
    bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash, uint256 budget, uint64 expiry);
event ClaimAccepted(uint256 indexed jobId, address indexed solver,
    bytes32 envelopeHash, bytes32 keyCommitment, bytes envelope);
event KeyReleased(uint256 indexed jobId, address indexed solver,
    bytes32 key, bytes32 envelopeHash, uint256 amount);
```

The adapter declares `ZeroAddress`, `MissingCode`, `PaymentTokenMismatch`, `InvalidTerms`, `CoreJobMismatch`, `FeesEnabled`, `ExpiryTooSoon`, `Expired`, `AlreadyRegistered`, `AlreadyAccepted`, `EnvelopeTooLarge`, `NotWinner`, `WrongKey`, `AlreadyReleased`, and `WrongPaymentAmount`. Its exported ABI also includes inherited `ReentrancyGuardReentrantCall` and `SafeERC20FailedOperation(address)`. All errors revert the whole transaction. The constructor rejects a core with either fee enabled.

The core emits `JobSubmitted` and `PaymentReleased` with the adapter as provider. Use adapter events and token transfers to identify the winning solver and final payment. The public claim event contains the exact encrypted envelope.

## Approval, funding and registration

1. Buyer approves the compiled image, rules, references, exact budget and expiry offchain.
2. Buyer calls `core.createJob(adapter, adapter, expiry, description, address(0))`.
3. Buyer calls `core.setBudget(jobId, amount, "")`. The patched core restricts this call to the buyer.
4. Buyer approves the core for exactly `amount` USDC.
5. Buyer calls `core.fund(jobId, "")`. This core has no expected-budget parameter.
6. Buyer calls `adapter.register(jobId, imageId, rulesHash, referenceHash, amount, expiry)`.

Registration authenticates the buyer and checks the exact funded core job, both adapter roles, zero hook, token, both zero fees, nonzero budget, matching expiry and at least 600 seconds remaining. The authentic core records full funding only after its token transfer succeeds. Registration stores the approved commitments. An unregistered funded job cannot accept a claim or pay a solver. Its buyer can still receive the core expiry refund. Discovery must require registered terms and a matching current core snapshot.

## Candidate and release

`claim` first checks registered funded terms, core roles, amount, expiry, token and fees. It requires `now < expiry`, no accepted candidate and an envelope of at most 16412 bytes. It verifies a verdict-1 receipt before reserving `msg.sender`. It stores the envelope digest and key commitment, emits the envelope, and calls `core.submit`. The core provider remains the adapter. A failed claim reverts all changes and leaves the job open to other candidates.

The first accepted proof reserves the bounty. Later candidates cannot replace it. `release` requires the recorded solver, accepted claim, correct key, no earlier payment and `now < expiry`. It completes the core job, checks the adapter balance increase equals this job's entire budget, and forwards exactly that budget to the recorded solver in the same transaction. Any failure reverts completion, key event and payment. Reentrancy cannot pay twice or use another job's balance.

At `now >= expiry`, anyone calls `core.claimRefund(jobId)`. The core refunds the original buyer from Funded or Submitted state. Release and claim close at the same boundary. No adapter refund custody exists. Adapter records are historical after a direct core refund. Consumers must read the core status.

The key appears in public transaction calldata before confirmation. A failed release can still expose it. Preflight release and leave a deadline margin.

## Proof encoding

Reuse the version-1 wire bytes, with the adapter as the escrow domain and the actual candidate solver as provider:

```text
context = 0x01 || chainId[32] || adapter[20] || jobId[32] || solver[20]
          || rulesHash[32] || referenceHash[32]                 (169 bytes)
keyCommitment = SHA256(ASCII("UBC26/key/v1") || context || key[32])
journal = context || 0x01 || SHA256(envelope)[32] || keyCommitment[32] (234 bytes)
journalDigest = SHA256(journal)
```

Integers use unsigned big-endian encoding. The verifier separately binds the approved `imageId`. The immutable adapter-to-core binding identifies the core. A selected-provider proof using the core as domain cannot serve as an open-claim proof.

Synthetic vector: chain 5042002, adapter `0x1111111111111111111111111111111111111111`, job 7, solver `0x2222222222222222222222222222222222222222`, rules `0x33` repeated 32 bytes, references `0x44` repeated 32 bytes, key `0x55` repeated 32 bytes. Envelope hash: `0xad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6`. Expected key commitment: `0x3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d`. Expected journal digest: `0x9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e`.

Exact synthetic context and journal:

```text
context = 0x0100000000000000000000000000000000000000000000000000000000004cef5211111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000007222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444
journal = 0x0100000000000000000000000000000000000000000000000000000000004cef521111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000722222222222222222222222222222222222222223333333333333333333333333333333333333333333333333333333333333333444444444444444444444444444444444444444444444444444444444444444401ad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e63bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d
```

## Artifacts and remaining checks

ABI: `contracts/abi/OpenClaimAdapter.json`. Local deploy script: `contracts/script/09_DeployOpenClaimLocal.s.sol`. [Verified Arc deployment manifest](../../contracts/deployments/open-claim-arc-testnet.json), [deployment report](../../agents/anish/reports/open-claim-arc-deployment-2026-11-16.md), proposed template: `contracts/deployments/open-claim-arc-testnet.template.json`. Manifest schema: `contracts/deployments/OPEN-CLAIM-SCHEMA.md`.

The adapter source and exported ABI are on `codex/overnight-open-escrow` and `codex/open-escrow-rescue`. Forty-eight focused Forge tests pass, including adversarial registration, payout and refund checks and six checks against a checked-in real receipt. The [combined local acceptance report](../../agents/anish/reports/open-claim-local-acceptance-2026-11-16.json) records a fresh adapter-domain proof, a real-verifier claim, exact 1,000,000-unit payout to the winning solver, losing-solver abstention, byte-exact SDK and engine recovery with an independent oracle, and a separate exact refund. The slow suite exited 0. The SDK uses the compiled JSON ABI, and the API reads confirmed blocks. A separate [local x402 report](../../agents/anish/reports/open-claim-x402-local-2026-11-16.json) covers an API compile charge with a test facilitator. The adapter is now deployed and source verified on Arc Testnet. No live funded proof, buyer/solver exchange or Circle Gateway charge is recorded. Direct x402 bounty funding remains unproven.
