# Engine evaluation execution plan

Goal: Test request fidelity, deterministic checking, generated guests, and real proof delivery.

The user approved unattended execution through these phases in order. Checkpoints save progress and continue.

## Fixed revisions and scope

- Engine baseline: `adda3a3`.
- Commerce baseline: `3013d73624c3cf279015b25ec17497d7394ab70f`.
- Integration branch: `codex/engine-commerce`. Keep commerce out of engine PR #3.
- Keep engine fixes in separate commits. Do not merge into main.
- No contract deployment, funding, live transactions, or messages to other chats or people.
- Synthetic contexts and simulated approval must remain explicit. Actual buyer approval remains a product requirement.

## Phase 1: Independent challenge testing

- [ ] Generate 60 plain-English requests: 40 supported, 10 ambiguous, 10 unsupported.
- [ ] Cover expenses, reconciliation, inventory, allocation, file integrity, and signed evidence.
- [ ] Supply valid candidates and isolated counterexamples with independent expected results.
- [ ] Run 10,000 seeded cases. Record operations, input types, failure classes, failing seeds, and useful minimized examples.
- [ ] Separate translation mistakes, compiler/evaluator disagreements, invalid inputs, unsupported features, and proof failures.

## Phase 2: Engine hardening

- [ ] Investigate every phase-1 failure. Add regression tests before production fixes.
- [ ] Compare host and generated guest results against independent expectations.
- [ ] Check parameter-only image stability and rules/reference commitment changes.
- [ ] Check malformed and oversized inputs, overflow, types, source injection, context/key/ciphertext/journal/proof changes.
- [ ] Record capability gaps without weakening requirements or adding unrelated features.

## Phase 3: Authoring and end-to-end evidence

- [ ] Implement a reusable adapter for Neil's DraftModel and Engine boundaries. Avoid a competing service.
- [ ] Use `gpt-6-luna`, low reasoning, with only request, permitted reference information, schema, and catalog.
- [ ] Run three independent trials per challenge. Allow at most one repair after validation feedback. Record every attempt and usage when available.
- [ ] Score semantics: missing requirements, invented constants, changed units, and weaker predicates. Keep first attempts separate from repairs.
- [ ] Use real CLI validation, evaluation, compilation, execution, proving, and decryption.
- [ ] Execute each distinct accepted rule structure in the guest.
- [ ] Produce 12 new Groth16 receipts across six families, including passing and failing predicates. Invalid input/signatures may abort.
- [ ] Verify with the pinned real Solidity verifier locally. Recover passing files byte for byte.
- [ ] Publish one repeatable evaluation command and a report separating translation, engine, and proof results. Luna evidence does not establish live Grok behavior.

## Recurring checkpoints

- Update status after meaningful checkpoints, changed dependencies, about every 30 minutes, and before final reports.
- Use dated headings with UTC offsets. Keep the newest entry first. Preserve older entries.
- Commit and push coherent checkpoints with their status updates.
- About hourly, fetch and inspect Nick and Neil remote revisions at a safe boundary. Never interrupt a running proof.
- Inspect relevant changed status, plans, interfaces, manifests, code, and PRs before integration. Record exact pins.
- Update the shared plan when dependencies or team interfaces change. Do not edit other owners' status files.

## Completion rule

Completion requires verified challenge coverage, generated tests, regression fixes, model records, real proof evidence, and the final report. Missing model access blocks model evidence only. Missing settlement blocks live integration only. Do not present simulations as required real results.
