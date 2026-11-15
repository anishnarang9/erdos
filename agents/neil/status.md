# neil status

Follow the [shared status rules](../AGENTS.md#status-and-handoffs). Add a heading with date, time, and UTC offset for each new entry. Keep the newest entry first.

## 2026-11-14 20:10 -05:00 — Neil

- **Branch:** `neil/plan-architecture`. The workstream 3 plan docs are now on main. The code stays on the branch until it is reviewed.
- **Done on the branch:**
  - T1: the `commerce/` workspace, CI, and the SDK and API contracts.
  - T2: the byte codec, which matches the engine fixture exactly.
  - T3: the viem chain adapter, plus SIMULATED stub ERC-8183 contracts on anvil.
  - T4: the API skeleton covering auth, idempotency and revisions.
  - Each task had a coder and an independent black-box tester, and then each reviewed the other's work. That review found and fixed a provider nonce-replay bug and a path that could leak the release key.
- **Checks:** 394 API tests and 211 or more SDK tests pass locally. The SDK security fixes from the cross-review are in progress.
- **Next:** T5–T8 (Grok drafting, compile, quotes and funding linkage), using SIMULATED stand-ins for the engine and the chain.
- **Blocked on:**
  - Anish: the plan schema and the CLI JSON output shapes.
  - Nick: the settlement ABI, including an evaluator-binding guard.
  - Neil: an xAI API key for live Grok calls.

## 2026-11-14 15:45 -05:00 — Neil

- **Branch:** `neil/plan-architecture` ([PR #1](https://github.com/anishnarang9/UBC-26/pull/1)). I merged `origin/main` (`072cb2c`) into it.
- **Changed:**
  - Added the workstream 3 plan, [COMMERCE-IMPLEMENTATION.md](../current%20plan/COMMERCE-IMPLEMENTATION.md).
  - Added a new top entry in [PLAN.md](../current%20plan/PLAN.md) that adopts main's design. My earlier proposals for Circle's shared ACP, `attest`, RFQ and scheduling are marked superseded.
  - Added superseded banners to ARCHITECTURE.md and MARKETPLACES.md.
  - Added a document index to `agents/AGENTS.md`.
- **Checks:**
  - Recomputed the engine fixture (context, envelope, envelopeHash, keyCommitment, journalDigest) independently with Node `crypto`. All values match ZKVM-IMPLEMENTATION.md.
  - Ran `git diff --check`, checked that no conflict markers remain, and checked that the relative links resolve.
- **Blockers and dependencies:**
  - Anish has to answer Q-A1–Q-A12 (plan schema, capability error, CLI JSON shapes, `engine eval`).
  - Nick has to answer Q-N1–Q-N13 (ABI, events, `setBudget` caller, expiry rule) and provide the ABI stub.
- **Next:** T1–T3 for the Interface gate (Nov 15 12:00): commerce workspace, SDK byte codec against the fixture, and the chain adapter on the ABI stub.

## 2026-11-14 — Neil

- **Done:** wrote a proposed architecture and repository layout ([ARCHITECTURE.md](../current%20plan/ARCHITECTURE.md)), a dated plan entry with revised gates ([PLAN.md](../current%20plan/PLAN.md)) and marketplace integration options ([MARKETPLACES.md](../current%20plan/MARKETPLACES.md)).
- **Verified on-chain (read-only):** Circle's ERC-8183 `AgenticCommerce` on Arc has zero fees, about 193k jobs, `hook = 0` whitelisted and a provider-only `setBudget`. This led to the proposal to settle through a `ProofGateEvaluator` on Circle's live contract. Main has since chosen an isolated core instead.
- **Reviews done:** round 1 had two technical reviewers (zk, settlement/delivery). Round 2 had four reviewers, one per brief step (feasibility and real-world fit). Every verdict was "viable with fixes", and all fixes are applied. See the PLAN.md review log.
