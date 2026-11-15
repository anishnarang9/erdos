# Engine and authoring evaluation

Run: November 14–15, 2026. Branch: `codex/engine-commerce`.
Status: all 12 real receipts verified. Independent full replay pending.

The deterministic checks found no engine disagreement in the tested corpus.
The model preserved all tested supported predicates after validation repairs.
Its clarification and explanation quality was weaker. These are separate results.

## Scope and fixed dependencies

- Engine baseline: `adda3a3c52fd8cebe594aba42d3e43f47a7baf0e`.
- Commerce interface dependency: `3013d73624c3cf279015b25ec17497d7394ab70f`.
- Real RISC Zero prover and receipt format: 3.1.0.
- Solidity verifier: `ff30da77ba4afdd496290ebebedb205348b15d83`, selector `0xe71e6620`.
- Latest settlement revision reviewed separately: `80c8a4af68f0cf00e4177c98e9c435d869716edd`. It is not merged here.

All contexts, reference data, signer fixtures, and approvals are synthetic.
Approval is simulated. No contract deployment, funding, or live transaction occurred.
Local ephemeral Solidity deployments test the real pinned verifier.

## Deterministic evidence

| Check | Actual result | Evidence |
| --- | --- | --- |
| Plain-English requests | 60: 40 supported, 10 ambiguous, 10 unsupported | [Corpus](CHALLENGES.md) |
| Independent candidate deliveries | 341, no host disagreement | [Host report](reports/host.json) |
| Seeded native cases | 10,000, no disagreement, 40 case families | [Seeded report](reports/seeded.json) |
| Baseline generated checkers | 40 packages, 8 distinct images | [Compilation report](reports/package-compilations.json) |
| Baseline guest checks | 262 actual executions, 79 valid input rejections | [Identity audit](reports/guest-audit.json) |
| Commitment invariants | 6 passed | [Invariants](reports/invariants.json) |
| Prepared guest checks | Signature profiles, frame bounds, independent source rebuild passed | [Prepared checks](reports/prepared-guests.json) |
| Scoring controls | Omission, weakened predicate, changed units, invented threshold detected | [Controls](reports/semantic-controls.json) |

The independent oracle uses direct domain calculations and byte checks.
It does not use the engine result as the expected result.
The seeded suite checks 23 operations and 95 recorded input categories.
It uses checked integer boundaries, malformed inputs, collection limits, duplicate keys, and lookup errors.
Native runtime tests do not establish guest correctness by themselves.
The separate guest runs supply that evidence for this finite corpus.

Phase 1 exposed fixture and harness errors. These involved canonical signed payloads, rejection categories, and a byte limit.
[Corrections](reports/harness-corrections.json) preserve the findings and regression evidence.
An initial guest launch inherited a forbidden environment variable and executed no guests.
The corrected run reused prepared packages and completed all required checks.
The [failed setup attempt](reports/initial-environment-attempt.json) remains available.
No production engine defect was confirmed by these cases.

## Measured model behavior

The model was GPT-6 Luna with low reasoning.
Three fresh native batches each received sixty shuffled, opaque requests.
Two validation-only follow-ups repaired 35 invalid plans.
The model received public contracts, approved reference bytes, the schema, and the capability catalog.
It did not receive predicates, expected labels, or counterexamples.

| Measurement | Result |
| --- | --- |
| First request outcomes | 180 |
| Expected response kind | 180/180 |
| Engine-valid first draft plans | 85/120 |
| Validation repairs | 35, at most one per affected request |
| Engine-valid final draft plans | 120/120 |
| Draft candidate outcomes matching independent expectations | 1,023/1,023 |
| Non-draft responses covering every checked request facet | 21/60 |
| Clarifications covering every checked facet | 1/30 |
| Specific unsupported-capability explanations | 20/30 |
| Final combined coverage before annotation checks | 141/180 |
| Final outputs containing nonverbatim source quotes | 13 |

All accepted drafts passed the public-constant and trust-key screen.
Fourteen hash constants required review. Each was SHA-256 of the exact requested report text.
The [constant review](reports/constant-screen-review.json) records this result.
Hash comparison assumes SHA-256 collision resistance.

The 39 non-draft defects remain model failures.
Twenty-nine clarifications omitted required details or introduced unrelated assumptions.
Ten capability explanations named no specific missing capability.
For example, one trusted-signature request received questions about unrequested recency and score rules.
The [fixed facet rubric](non-draft-oracle.mjs) detects these cases conservatively.
It does not prove full language understanding or measure every possible false premise.

An earlier score counted matching non-draft kinds as coverage.
The [correction](reports/fidelity-correction.json) preserves the original report and replaces that score.
No saved output, draft predicate, validation result, candidate result, guest structure, or proof input changed.

The [current authoring report](reports/authoring.json) records first attempts and repairs separately.
The [expected defect list](authoring-expectations.json) makes replay compare against actual measured behavior.
Replay rejects additional failures, missing checks, altered outcomes, inconsistent counts, and invalid repair sequences.
Reproducing a known model defect does not make that response correct.

The batches shared context within each trial and used model-authored helpers.
They are not 180 isolated API calls or independent statistical samples.
The native route did not expose token usage or a separate filesystem sandbox.
Usage remains `null`. Prompt access restrictions are not a filesystem security boundary.
These results do not establish live Grok behavior.

## Generated model guests and real proofs

All 16 distinct accepted model rule structures compiled and ran in the actual guest.
All 134 checks matched: 102 actual executions and 32 input rejections.
The [guest report](reports/authoring-guests.json) binds the preserved report from before the scoring correction.
The correction independently checks that every measured draft and candidate result remains identical.

The sequential queue completed twelve new Groth16 receipts: one passing and one failing predicate in each family.
The [public proof index](proofs/index.json) contains completed evidence only.
The [progress report](reports/proof-progress.json) records measured proof times and cycles.
All twelve receipts passed the pinned local Solidity verifier and its mutation checks.
All six passing deliveries recovered byte for byte.
Every pair passed wire checks and all four negative recovery checks.
Independent full replay remains pending at this checkpoint.

| Family | Passing proof, seconds | Failing proof, seconds | Recovered bytes |
| --- | ---: | ---: | ---: |
| inventory | 231.052 | 234.174 | 190 |
| signed-evidence-bindings | 744.814 | 744.260 | 36 |
| ledger-reconciliation | 221.277 | 225.942 | 235 |
| allocation-scheduling | 283.293 | 300.237 | 259 |
| expenses-budgets | 230.448 | 219.391 | 286 |
| file-hash-size | 217.296 | 219.101 | 57 |

Each proof carries a 260-byte seal and a 234-byte journal.
The local verifier checks changed image, journal, seal, and verdict.
Pair checks cover context fields, cross-job replay, envelope substitution, and key commitments.
Recovery compares exact filenames and bytes.
Negative recovery checks use the wrong key, changed ciphertext, changed context, and a failing verdict.
Release keys stay in private scratch storage and never enter the public fixture export.

## Reproduce and integration limits

Use the [repeatable commands](README.md) from a checkout with the pinned runtimes installed.
`evaluate.sh` replays saved model outputs without new inference or proof generation.
It runs native tests, all host candidates, strict authoring replay, archived guests, and real local Solidity verification.
Its optional private directory enables fresh byte-exact decryption.
`run-engine-checks.sh` rebuilds and executes every baseline package.
`run-authoring-guests.mjs` rebuilds and executes each accepted model structure.

Measurements came from this macOS host with Linux/amd64 compression in Docker.
Native Linux timing remains unverified. Proof times are local measurements, not latency guarantees.
Signed-evidence proofs each took about 744 seconds here.
The settlement source's 600-second minimum funding margin is shorter than that proof time alone.
Clients must allow measured proving, submission, and key-release time before expiry.

The local adapter implements Neil's imported `Engine` interface and preserves normalized approvals and persistent packages.
The recorded adapter implements `DraftModel` and returns only exact saved-input matches.
The production API still needs explicit adapter injection in Neil's workstream.
The hourly review found a deployed settlement stack at Nick's latest revision.
Eighteen independent [read-only Arc checks](reports/arc-readonly.json) passed at one fixed block.
They confirm contract code, wiring, limits, whitelist status, retained admin roles, and fresh inventory receipt verification.
Changed image, journal, and seal reverted. These calls sent no transaction.
The core remains unfrozen. The manifest contains no funded test job.
Its policy prose still describes renounced roles, while the explicit freeze field and live role reads show retained privileges.
Actual buyer review, funded terms, fresh funded-job proofs, and live acceptance/payment/refund remain integration dependencies.
The [inventory package manifest](proofs/inventory/package/manifest.json) supplies one tested image/rules/reference combination for integration planning.
A real job still needs its selected provider and approved inputs.
Existing receipts use synthetic escrow, provider, and job fields. A newly funded job requires a fresh context-bound proof.
Engine PR #3 remains separate from this integration branch.
