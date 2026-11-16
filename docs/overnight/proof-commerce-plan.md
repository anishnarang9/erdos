# Proof commerce execution

2026-11-16 01:27 -05:00 — Anish

Branch: `codex/overnight-proof-commerce`. Base: `ae1295a6364f31a4f98baa69536d03dad4276f20`.

The supplied overnight plan authorizes implementation, independent review, local acceptance, and scoped checkpoint commits and pushes.
The morning handoff target is 2026-11-16 08:00 Eastern. Continue unfinished authorized work under the active goal.

## Work and acceptance

- [x] Preserve the original integration checkout, active Meridian process and scratch.
- [x] Create a separate coordinator worktree and three worker worktrees.
- [x] Dispatch Grok 4.7 High tracks for worker, API/x402 and SDK/buyer.
- [x] Read Chat 2 interface checkpoint `43b4fca` from `codex/overnight-open-escrow`.
- [ ] Independently reproduce the shared public context, journal and commitment vector.
- [ ] Close Meridian with a clean full-suite exit and the required proof/payment/recovery evidence.
- [ ] Review and integrate the three client tracks against the published adapter ABI.
- [ ] Run focused negative paths and preserve selected-provider regression checks.
- [ ] Run the first combined actual-contract open-claim exchange with a fresh real proof.
- [ ] Show two solver identities, one winner, no losing payout, autonomous release and exact buyer recovery.
- [ ] Check a separate expiry refund and independent semantic oracle.
- [ ] Exercise local x402 payment, replay and compile-failure recovery with one charge.
- [ ] Run final-head checks and a documented clean-checkout flow.
- [ ] Publish source and sanitized evidence with exact limits and handoff status.

## Ownership

| Track | Branch | Writable scope | Model |
| --- | --- | --- | --- |
| Coordinator | `codex/overnight-proof-commerce` | Integration, evidence and shared status | Codex |
| Proof/worker | `codex/overnight-proof-worker` | `commerce/worker/` | Grok 4.7 High |
| API/x402 | `codex/overnight-agent-api` | `commerce/api/`, buyer quickstart, route contract | Grok 4.7 High |
| SDK/buyer | `codex/overnight-sdk-buyer` | `commerce/sdk/` | Grok 4.7 High |
| Chat 2 | `codex/overnight-open-escrow` | Contracts, ABI, deployment and contract acceptance | Separate chat |

The existing Meridian run owns the proving host. Its launch source is `ae1295a`.
The coordinator reads its results and process identity without modifying its source or private state.
No second prover starts until that process releases the host.

## Interface consumed

Chat 2 freezes `register`, `claim`, `release`, `terms`, `submissions`, `released`, `contextOf` and `expectedJournal`.
Use `docs/overnight/open-claim-v1.md` from that branch as the source of truth.
The frozen core uses the adapter for provider and evaluator, with a zero hook.
The proof uses the adapter as escrow and the actual solver address as provider.
Buyer registration follows confirmed direct core funding and checks exact approved terms.
The selected-provider path remains independently tested.

## Live acceptance

The overnight request does not authorize real-wallet access or live signing.
Complete local acceptance and publish exact operator commands if live deployment and wallet approvals remain absent.
A local test facilitator establishes local x402 behavior. It does not establish a Circle Gateway payment.
