# ERC-8183 compatibility and x402 boundary

2026-11-16 — Native Codex standards review. Review base: `43b4fca1a8d7db5b99b1607a0a5fce7ce61d4e83`.

The project uses a pinned ERC-8183-derived core with project-specific proof policies. It does not claim full compliance with the current draft. The draft's normative prose and embedded reference code also disagree. Clients must use the pinned ABI.

## Sources and pins

- [Current ERC-8183 draft](https://eips.ethereum.org/EIPS/eip-8183), read on 2026-11-16. The corresponding [ERCs source](https://github.com/ethereum/ERCs/blob/eb90f8e1b2ac75b20648d8bdb0a7affae985c44b/ERCS/erc-8183.md) uses repository revision `eb90f8e1b2ac75b20648d8bdb0a7affae985c44b`, dated 2026-11-15.
- [Pinned patched core](../../contracts/src/core/src/AgenticCommercePatched.sol), [pristine core](../../contracts/src/core/src/AgenticCommerce.sol), [one-line patch](../../contracts/src/core/setBudget-client-only.patch), and [core ABI](../../contracts/abi/AgenticCommerce.json), at the review base above.
- [SettlementHook](../../contracts/src/SettlementHook.sol), [frozen manifest](../../contracts/deployments/arc-testnet.json), and [selected-provider handoff](../../contracts/HANDOFF.md), at the same base.
- [Approved open-claim API](open-claim-v1.md). This document describes its compatibility boundary. It does not replace its requirements.

The manifest records core proxy `0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8`, implementation `0x55A3C9319EEe607579855880b5651766eBF103d7`, and both fees as zero. It records historical freeze evidence at block 72472573. This review did not repeat live provenance or role-history verification.

## Draft differences

The middle column summarizes the draft's normative prose. The last column describes the actual pinned source. References point to [core functions](https://eips.ethereum.org/EIPS/eip-8183#core-functions), [hooks](https://eips.ethereum.org/EIPS/eip-8183#hooks-optional), and the [embedded reference](https://eips.ethereum.org/EIPS/eip-8183#agenticcommercesol).

| Area | Current draft prose | Pinned source and project policy |
| --- | --- | --- |
| Funding | Includes `expectedBudget`, checks equality, rejects zero budget. | `fund(uint256,bytes)`, selector `0xe25ba707`. No expected-budget check. Zero budget is allowed. `jobHasBudget` is not checked. |
| Budget caller | Client or provider. | Patched core permits only client. Pristine Circle source and current embedded reference permit only provider. |
| Provider | Client assigns once while Open. Hookable. | Same assignment checks. `setProvider(uint256,address)` has no `optParams` and invokes no callbacks. |
| Creation expiry | Requires a future expiry. | Requires `expiredAt > block.timestamp + 300`. |
| Submission | Funded → Submitted, provider only. | Also allows Open → Submitted when budget is zero. Emits the deliverable but does not store it in `Job`. |
| Completion | Submitted, evaluator only. | Same role and state checks. Raw core has no expiry check and no proof check. |
| Rejection | Client while Open. Evaluator while Funded or Submitted. | Same role and state checks. Funded/Submitted rejection refunds the full budget. |
| Refund | Funded/Submitted at `now >= expiredAt`. No hook. | Permissionless `claimRefund(uint256)` matches this boundary. A failed token transfer reverts the state change. |
| Fees | Optional platform fee on completion only. | Supports platform and evaluator fees. Their sum cannot exceed 10,000 basis points. Both equal zero under the project policy. Refunds deduct neither. |
| Hook data | Amount/reason/deliverable plus `optParams`. Raw `optParams` for funding. | Every emitted callback payload starts with the core caller. See the exact encodings below. |
| Zero hook | Optional. Skip callbacks. | Supported. Zero hook is whitelisted during initialization and bypasses ERC-165 checking. |

The embedded reference has the same funding, zero-budget, submission and callback differences. It is not evidence that these differences satisfy the normative prose. Its initializer also differs: the reference takes `(paymentToken, treasury)` and grants roles to its caller. The pinned source takes `(paymentToken, treasury, admin)` and grants both roles to `admin`. The project's pristine-to-patched source diff changes only the budget caller.

The draft's optional [ERC-2771 relay extension](https://eips.ethereum.org/EIPS/eip-8183#meta-transactions--facilitator-relay-erc-2771) does not exist in this pinned core. Lifecycle authorization uses raw `msg.sender`.

## Actual hook encoding

These are the pinned core's callback payloads. `caller` means `msg.sender` of the external core call. Parentheses describe `abi.encode`, except where stated.

| Action | Calls | Actual `data` |
| --- | --- | --- |
| `createJob` | After only | `(address caller, address provider, address evaluator)` |
| `setProvider` | None | No payload |
| `setBudget` | Before and after | `(address caller, uint256 amount, bytes optParams)` |
| `fund` | Before and after | `(address caller, bytes optParams)` |
| `submit` | Before and after | `(address caller, bytes32 deliverable, bytes optParams)` |
| `complete` | Before and after | `(address caller, bytes32 reason, bytes optParams)` |
| `reject` | Before and after | `(address caller, bytes32 reason, bytes optParams)` |
| `claimRefund` | None | No payload |

The draft table omits this leading caller and requires callbacks for `setProvider`. Its funding payload is raw bytes. A hook built for that table cannot decode this deployment safely. The pinned `IACPHook` also extends ERC-165. Its interface ID is `0x7ff6bc9e`.

## Selected-provider path

The buyer chooses the solver before funding. The solver remains the core provider. `SettlementHook` is both hook and evaluator. Creation rejects a zero provider or another evaluator. Budget setting rejects zero and requires empty optional data. Funding requires exactly `abi.encode(imageId, rulesHash, referenceHash)`, or 96 bytes. It also requires a positive budget, a representable `uint64` expiry, and at least 600 seconds remaining.

The hook freezes the provider and commitments after funding succeeds. Submission requires a passing receipt for that provider and the exact encrypted envelope. Submission and key release require `now < expiry`. Only `hook.release` can drive completion. The core pays the selected solver directly. The hook does not forward the bounty.

The hook exposes no method that calls `core.reject`. Thus the evaluator's general core rejection authority has no public route for Funded or Submitted jobs. The buyer can still reject an Open job. Expiry refunds bypass the hook. The hook's stored flags remain historical after a direct core refund.

## Open-claim extension

The buyer creates a core job with `provider = evaluator = adapter` and `hook = address(0)`. This is a project extension. The base protocol still sees one fixed provider. Individual solvers compete through the adapter's proof interface.

The frozen hook whitelist does not block this design. Initialization already allows zero hook. `setHookWhitelist` rejects attempts to change the zero entry. Only nonzero hooks face ERC-165 and whitelist admission. Provider and evaluator addresses have no whitelist requirement. The adapter therefore needs no new core or whitelist transaction.

The approved API requires registration after direct buyer funding. Registration authenticates the buyer and checks the funded job, adapter roles, zero hook, payment token, positive exact budget, exact expiry, zero fees and expiry margin. A claim verifies the receipt before it reserves the first solver. Its context binds the adapter address and actual solver. It cannot reuse a selected-provider receipt whose context binds the core and its selected provider.

The core pays the adapter on completion because the adapter is its provider. Release must check an exact budget increase and forward that budget to the recorded solver atomically. Core `JobSubmitted` and `PaymentReleased` identify the adapter. Consumers must use adapter records and events to identify the solver and final recipient. The API has no relayer or alternate payout address.

An arbitrary zero-hook job carries no proof guarantee. A buyer-controlled evaluator can complete or reject it under the raw lifecycle. A job naming the adapter but lacking valid registered terms is also insufficient. Discovery must check the trusted adapter, registered terms and current core snapshot. At expiry, consumers must honor the core's status even when adapter records still show an accepted claim.

## x402 assessment

The official [Circle testnet supported endpoint](https://gateway-api-testnet.circle.com/v1/x402/supported) returned HTTP 200 on 2026-11-16 at 06:27:07 GMT. It advertised x402 v2 `exact` on `eip155:5042002`. Its metadata names `GatewayWalletBatched`, version `1`, verifying contract `0x0077777d7eba4688bdef3e311b846f25870a19b9`, and minimum validity 604800 seconds. It lists Arc USDC with six decimals. The [review report](standards-report.md) retains the complete Arc entry and response hash.

Circle's [Nanopayments overview](https://developers.circle.com/gateway-nanopayments) and [batch lifecycle](https://developers.circle.com/gateway-nanopayments/concepts/batched-settlement) describe a Gateway Wallet deposit, signed payments, and later seller balance credits. This adds a Gateway balance layer. It does not directly fund a core job. Circle describes its system as non-custodial. This review does not characterize it as operator custody.

The official [EVM exact scheme](https://github.com/x402-foundation/x402/blob/1a084343e165d6f61b60b34f6146d6e4a4a7f3ca/specs/schemes/exact/scheme_exact_evm.md) specifies three transfer methods. EIP-3009 calls the token. Permit2 calls its payment proxy. ERC-7710 constructs an ERC-20 `transfer(payTo, amount)` execution. These are payment transfers. They do not specify an arbitrary `core.fund` execution. The scheme name alone does not prove that Circle supports every transfer method.

For this pinned core, direct x402 bounty funding fails the required composition:

1. A facilitator or payment proxy calling `fund` is not the original buyer. The core checks raw `msg.sender == job.client`.
2. A token transfer to the core does not set the job's Funded state or attribute a deposit to that job.
3. Calling `fund` after such a transfer still pulls the budget from the buyer. That creates a second debit.
4. Paying an API server first requires that server to move funds later. It changes the approved funding and refund identities.

No reviewed source establishes one atomic debit, the correct client, no extra balance layer and a successful `core.fund` call. Preserve the initial boundary: x402 pays an API fee. The buyer separately approves and funds the bounty directly in the core. API fee payment must not imply bounty registration or proof-gated settlement. Direct funding needs a separately approved mechanism and new evidence.

## Evidence limits

Focused local checks passed seven provenance tests and two zero-hook tests. Those tests confirm only their named behaviors. They do not establish adapter correctness, a funded live exchange, latest-draft compliance or production security. See [commands, hashes and handoff details](standards-report.md).
