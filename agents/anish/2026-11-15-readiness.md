# Engine, team, and build readiness — November 15, 2026

Reviewed on November 15 in America/New_York. This report separates implementation, observed tests, and remaining integration work.

## Current assessment

The engine is a tested prototype for bounded, deterministic acceptance rules.
It is ready for controlled integration work. It is not production security certification.
The largest gaps are acceptance-policy fidelity, dependency review, service hardening, and the complete live settlement lifecycle.

No branch was merged for this review. No live transaction was sent.

| Component | Pinned revision | Current assessment |
| --- | --- | --- |
| Engine PR #3 | `adda3a3c52fd8cebe594aba42d3e43f47a7baf0e` | Core implementation and real proof fixtures. Integration candidate with explicit prototype scope. |
| Our integration/evaluation | `ad2dab18ba5fe7239607fda8359db05f0d8845e1` | Completed three-phase evaluation. Includes commerce baseline `3013d736`, not Neil's latest code. |
| Nick PR #4 | `80c8a4af68f0cf00e4177c98e9c435d869716edd` | Deployed stack and source integration candidate. Documentation, freeze, and live lifecycle gates remain. |
| Neil PR #5 | `8584b045f18996667419b8c6d7f965717b099f5e` | Real engine/Grok/worker progress. Hold final merge while CI is red and live wiring remains incomplete. |
| Remote main | `9a1b4444ec30360210cdccc4d26fdfe4601e81d7` | Review base. The local main checkout remains at `072cb2c`; it was not changed. |

## What is written in Rust

Yes: the core engine we own is Rust. Its generated checker is Rust too.
The complete application and proving toolchain use other languages as well.

| Part | Language | Responsibility |
| --- | --- | --- |
| `engine/compiler` | Rust | Validate typed plans, normalize rules and parameters, emit checker source. |
| `engine/guest-runtime` | Rust | Parse bounded inputs, verify signed evidence, evaluate rules, encrypt the exact checked delivery. |
| `engine/protocol` | Rust | Canonical bundles, context and journal encodings, hashes, encryption primitives. |
| `engine/cli` | Rust | `validate`, `eval`, `compile`, `execute`, `prove`, and `decrypt`. Package and key handling. |
| Generated checker | Rust compiled to a RISC-V ELF | Run the approved predicate inside RISC Zero. |
| Commerce API, SDK, worker, and UI | TypeScript | Authoring, approvals, transport, chain access, solver orchestration, and buyer experience. |
| Our evaluation adapters and harness | TypeScript/JavaScript, shell, Rust tests | Independent cases, model replay, guest execution, and proof checks. |
| Settlement and Ethereum verifier | Solidity | Funded terms, proof verification, key release, payout, and refund. |
| External build/prover tools | Mixed | Docker, the pinned guest builder, `r0vm`, and Groth16 compression. The entire trusted stack is not pure Rust. |

The model proposes a typed JSON plan. It does not supply arbitrary Rust for the service to execute.
The compiler emits from fixed templates and committed data.

## What we completed

The [full evaluation report](../../engine/evaluation/REPORT.md) and [successful replay](../../engine/evaluation/reports/final-replay.json) contain the measured results.

- Sixty requests: forty supported, ten ambiguous, and ten unsupported.
- Independent expectations for 341 candidate deliveries. All host outcomes matched.
- Ten thousand seeded cases across forty case families. No mismatch.
- Forty baseline packages, eight images, 262 actual guest executions, and 79 input rejections.
- Six commitment checks, including stable images for parameter changes and changed commitments for changed inputs.
- Three Luna batches produced 180 first outcomes. Thirty-five validation-only repairs yielded 120 valid final supported plans.
- All 1,023 draft candidate outcomes matched. All sixteen distinct accepted model structures ran in the actual guest.
- Twelve new Groth16 receipts covered passing and failing predicates in all six families.
- The independent replay reverified all twelve receipts locally and freshly decrypted all six passing deliveries. All nine recovered files matched exactly.
- One fresh inventory receipt also passed the deployed Arc verifier through a read-only call. Changed image, journal, and seal failed.
- Final replay: 51 Rust tests, 38 Node tests, 11 TypeScript tests, and typecheck passed. Three prepared guest tests passed explicitly earlier.

These counts do not establish universal correctness or independent security audit coverage.
The model runs used three shared-context batches, rather than 180 isolated inference calls.
Native token usage was unavailable.

Known model defects remain: 39 non-draft responses failed the fixed fidelity rubric and thirteen source annotations were not verbatim.
The replay explicitly preserves these failures. A matching replay does not make those responses correct.

## What the proof guarantees

Given the approved checker image, rules, reference commitment, and funded job context, a valid passing receipt binds:

1. The deterministic checker execution and passing verdict.
2. The hash of the encrypted envelope produced from the checked delivery bytes.
3. The commitment to the context and release key.

The verifier must reconstruct those public fields from the actual funded job.
Changing a job, provider, checker, reference data, envelope, or key must not reuse the old acceptance.
The tests exercise those substitution boundaries.

The proof does not establish that a buyer chose good rules, that external data is true, or that a deliverable has unexpressed business value.
A signature establishes attribution to an approved key. Its issuer remains a trust dependency.

## Security assessment and limits

The implementation uses checked integers, typed rules, canonical encodings, parser limits, fixed templates, signature-profile checks, and private release-key files.
Input imports reject symlinks and nonregular files. Bundle and expression limits bound guest work.
These controls reduce concrete attack surfaces. Rust alone does not establish security.

The [new advisory scan](../../engine/evaluation/reports/dependency-advisories-2026-11-15.json) checked 498 registry package versions in the engine lockfile.
All 195 registry versions in each of the six published guest lockfiles are subsets of that scan.
Seven package versions matched advisories: four security/soundness issues and three maintenance warnings.
One issue has both a GHSA and RustSec identifier, so eight IDs represent seven distinct issues.

| Dependency | Finding | Initial scope assessment |
| --- | --- | --- |
| `crypto-bigint 0.5.5` | Timing weaknesses, [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) | Used through elliptic-curve/K256/P256. Secret-operation reachability needs review. No proof-forgery exploit was demonstrated. |
| `rsa 0.9.10` | Private-key timing risk, [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) | Our evidence path imports `RsaPublicKey` and verifies signatures. It does not perform RSA private-key operations. The advisory's private-key attack path was not demonstrated here. |
| `lru 0.16.4` | Conditional memory unsafety, [RUSTSEC-2026-0253](https://rustsec.org/advisories/RUSTSEC-2026-0253.html) | Workspace dependency through Alloy. Requires a particular panic/drop/unwind path. Reachability from our CLI is unproven. |
| `tracing-subscriber 0.2.25` | Terminal log injection, [RUSTSEC-2025-0055](https://rustsec.org/advisories/RUSTSEC-2025-0055.html) | Proving dependencies include this version. Review log sinks and sanitize untrusted control characters. |
| `bincode 1.3.3`, `derivative 2.2.0`, `paste 1.0.15` | Unmaintained dependencies | Maintenance warnings, not three demonstrated exploitable bugs. Track upstream replacements and build-chain risk. |

Sources for maintenance findings: [bincode](https://rustsec.org/advisories/RUSTSEC-2025-0141.html), [derivative](https://rustsec.org/advisories/RUSTSEC-2024-0388.html), [paste](https://rustsec.org/advisories/RUSTSEC-2024-0436.html).

This is advisory matching plus initial source review. It is not a completed exploitability analysis.
The scan does not cover installed prover/container binaries, every target feature, or JavaScript dependencies.
The first Python request failed certificate validation. Node's normal TLS validation succeeded. Neither client disabled TLS verification.

Do not apply a blind dependency upgrade to this proof stack.
Review affected paths and compatible releases first. Rebuild guests and regenerate affected evidence after changes.
Guest dependency changes can change image IDs. Prover/verifier parameter changes need coordinated compatibility checks.

Other material limits:

- **Policy quality:** a weak approved predicate can accept an undesirable result. Require explicit units, boundaries, filenames, trusted keys, and buyer approval.
- **Unprojected JSON:** extra fields can remain in the delivered bytes without being constrained by projected-field rules. Exact file sets are enforced, but arbitrary extra JSON content is not automatically forbidden.
- **Bounded tasks:** delivery bundles are at most 16,384 encoded bytes, references and evidence at most 32,768 bytes each, and collections at most 256 records.
- **Service isolation:** the CLI is not a general sandbox for an untrusted agent. Deployment still needs isolated users/processes, resource quotas, controlled paths, artifact retention, and protected secrets.
- **Delivery privacy:** the key becomes public when release is broadcast. Failed or front-run release transactions can reveal it before payment confirmation. This is not buyer-exclusive delivery.
- **Time and availability:** observed local proofs took about 217–745 seconds. The 600-second contract minimum is too short for our signed case alone. Native Linux measurements need the same pinned fixture for a fair comparison.
- **Settlement trust:** the reviewed core remains unfrozen. Its administrator can change privileged configuration. Complete live submit/release/payout/refund evidence is still absent from our verified results.

Our current security statement should be: **tested deterministic acceptance prototype with real proof/delivery binding, subject to the listed trust and deployment limits.**
It should not be marketed as secure for arbitrary agent work or production custody.

## Fit for real agent tasks

| Task | Current fit | What remains trusted or missing |
| --- | --- | --- |
| Small expense/budget checks | Good deterministic fit | Approved integer units, budgets, reference authenticity, and complete policy. |
| Bounded invoice/ledger reconciliation | Good fit | Exact matching and duplicate semantics. Input data must fit the limits. |
| Small inventory or scheduling assignments | Good fit | It proves feasibility against approved constraints, not global optimality or actual physical execution. |
| A report/file with exact hash, size, or signed metadata | Good for identity and specified properties | Does not prove writing quality, accuracy, usefulness, or external availability. |
| Signed audits or API attestations | Conditional fit | Approved signer, explicit freshness, exact artifact/context binding, and issuer honesty. |
| General websites, coding tasks, legal analysis, or persuasive writing | No general correctness checker yet | Need deterministic domain tests or an explicitly trusted evaluator. Hashing a file does not solve semantic evaluation. |
| Large datasets, PDFs, arbitrary network fetches, or GPU training claims | Outside the current direct checker | Need new parsers/verification schemes, bounded preprocessing, or approved attestations. These are separate engineering work. |

Start today's vertical slice with one small reconciliation job. It exercises useful structured data without requiring a new language feature.

## Nick and Neil: progress and merge readiness

See the [current review record](reports/team-review-2026-11-15-midday.json).

**Nick:** PR #4 contains the core, hook/evaluator, real verifier, ABI handoff, tests, and deployment scripts.
The manifest records deployed addresses and a whitelisted hook. The core is explicitly unfrozen.
The overnight read-only verification checked the wiring and a fresh engine receipt.
All eighteen checks were repeated today at a new fixed block and passed. The deployer still holds both admin roles.
See the [current Arc read-only report](reports/arc-readiness-2026-11-15-midday.json).
Nick reports 120 passing Foundry tests and one skipped test. We did not rerun them today because Foundry is absent on this host.

Before source merge, correct documentation that describes fees or roles as frozen/renounced while the current deployment remains unfrozen.
In particular, inspect `contracts/HANDOFF.md:19,32` and `contracts/deployments/arc-testnet.json:50,81` at the pinned revision.
Source merge and production deployment approval are separate decisions.
Freeze and real lifecycle tests remain demo gates even after source merge.

**Neil:** since `3013d736`, PR #5 adds a real CLI adapter, engine-bound approval, package/reference delivery, recorded Grok drafts, worker proving/decryption, signer policy, a funded-worker state machine, and submission indexing work.
His recordings include an engine-valid Grok reconciliation plan and a correctly rejected regex request.
His status reports API/SDK/worker tests and genuine passing/failing proof runs in WSL.
Those owner-reported counts were not independently rerun in this review.

The recorded Grok example agreed with four of five checker outcomes. Duplicate lookup keys caused an input rejection rather than verdict 0.
That is the engine's current fail-closed semantics: Boolean rules evaluate eagerly, and `lookup` requires one matching key.
Putting `unique` earlier does not short-circuit the later lookup.
Treat that example as invalid input in authoring/worker handling. Do not silently change the language for the demo.

PR #5 is not ready for final merge:

1. Both commerce CI checks fail at `sdk/src/chain/arc/nick-examples/fixture.test.ts:107`. The compiler requires a second `setAAD` argument.
2. `api/src/server.ts:47–58,79–90` permits chain configuration with the default simulated engine. Refuse that combination before exposing a real funding workflow.
3. The server does not supply a real `ChainReader`. `api/src/chain.ts:43–51` retains a stub fallback.
4. The funded worker has a `SettlementPort` abstraction, but no concrete live adapter wired through its CLI/public entry point.

The inspected `createJob` encoding uses the same five argument shapes as Nick's interface.
Its stub label alone is not evidence of incorrect calldata. The concrete reader/port gaps and missing end-to-end tests are the blockers.
Nick's addresses and ABIs are now available, so waiting for deployment is no longer the correct dependency description.

GitHub reports PRs #3 and #4 as mergeable/clean, with no required checks shown. PR #5 is mergeable/unstable because its checks fail.
Dry `git merge-tree` checks found no textual conflict for engine/main, Nick/main, or Neil/current integration.
That does not establish semantic compatibility. No branch or working tree was merged.

Recommended order: engine baseline with explicit prototype scope, Nick's corrected source/ABI, then Neil after CI and live-mode guards are fixed.
Keep our evaluation commits and exact proof artifacts as a separate, reviewed integration checkpoint.
Do not overwrite Neil's newer production adapter with our evaluation-only adapter.

## Proposed work for today

1. **Make integration safe and reproducible.** Fix Neil's typecheck and chain/simulated-engine guard. Correct Nick's current-state documentation. Record dependency reachability and remediation ownership. Run focused tests and CI before merges.
2. **Finish real chain wiring.** Implement the Arc reader and worker settlement port against the pinned ABIs. Read hook/evaluator, provider, funded terms, commitments, expiry, and freeze state from one confirmed snapshot. Build the real context only after those checks.
3. **Complete one lifecycle.** Use a buyer-approved reconciliation package and a real selected provider. Demonstrate rejection without payout, passing submission, key release/payment, exact buyer decryption, expiry refund, and duplicate/replay rejection. Nick owns authorized broadcasts. This chat retains its no-live-transaction constraint.
4. **Expose that same lifecycle in the buyer UI.** Show the normalized acceptance rule, units, reference digest, exact funding steps, proof state, expiry budget, and recovery result. Retain manual approval while model fidelity remains imperfect.

Today's success criterion is one complete, evidenced vertical slice. New general-purpose language features come after that integration gate.
Dependency triage and service isolation remain required before a production security claim.

## Orca migration and authentication

Orca 1.4.259 is running and already lists this exact integration worktree.
No clone, branch move, or Git migration is needed.
The worktree card is now **Anish engine integration**, marked in review, with this report opened in Orca.
Orca's enabled Session History index found this conversation as **Run UBC-26 execution phases**, session `01a1dd49-6c06-7970-9d8d-fef3d425a11f`.

After this turn ends, open that worktree in Orca and use Agent Session History → Resume in New Native Chat for the existing conversation.
Avoid running two writers against the same conversation.
For a fresh account-specific chat, read [ORCA-HANDOFF.md](ORCA-HANDOFF.md) instead of replaying the entire transcript.
[Orca session-history guide](https://orca.dev/docs/agents/session-history), [native-chat guide](https://orca.dev/docs/agents/native-chat).

Orca currently detects API-key credentials in **System default**, with zero managed Codex accounts.
This is credential metadata, not a successful paid API test.
Keep that system login. Add ChatGPT as a separate managed account once:

```sh
orca account add --agent codex
orca account list --json
orca account select --agent codex --account <saved-chatgpt-account-id>
# Later, for API-key work:
orca account select --agent codex --account system
```

The first command needs the user's browser/device authorization once. It was not started during this review.
Managed accounts use isolated credential homes, so they do not replace the system login.
Selection applies to new/restarted agents. It does not change credentials inside an already-running Codex process.
For predictable billing, select the account and start a fresh chat using the handoff.
History resume can retain the original account home.
[Orca account switching](https://orca.dev/docs/agents/codex-hot-swap), [local CLI reference](https://orca.dev/docs/cli/reference).

This avoids repeated login/logout. It does not reset limits or combine subscription access with API billing.
OpenAI treats subscription and API-key access as different authentication/billing routes.
[OpenAI authentication](https://learn.chatgpt.com/docs/auth).

No credential was copied into this repository. No global Codex configuration or active account was changed.

## Review commands and evidence

- Fetched origin and inspected pinned owner status, code, plans, PR state, and failed CI output.
- `gh run view 43734093882 --log-failed` confirmed TS2554 at the stated fixture line and exit code 2.
- Three dry `git merge-tree --write-tree` checks exited 0. They created no merge commit or branch update.
- `cargo +1.98.1 tree --locked --manifest-path engine/Cargo.toml -i ...` confirmed the affected workspace dependency paths.
- The OSV query succeeded through normal Node TLS and recorded all matching package versions.
- No full proof suite, authoring trial, or live transaction was repeated for this review.
