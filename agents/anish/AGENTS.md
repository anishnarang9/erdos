# Anish’s project context

## 2026-11-18 — Anish — Resume from remote main

The [resume audit](reports/core-sprint-resume-2026-11-18.json) checks remote main `2e04451`. It contains the saved engine-commerce integration, Nick's settlement head and Neil's merged PR #5. Do not repeat those merges or resume from the old dirty worktree.

The [prepared live exchange](reports/open-claim-arc-live-acceptance-2026-11-16.md) passed with a **0.01-USDC open-claim** bounty. The clean [selected-provider rehearsal](reports/fresh-exchange-local-2026-11-15.json) passed with **1 USDC on local Arc Anvil only**. Neither result establishes the original live 1-USDC selected-provider acceptance.

Historical wallet and small-run approvals do not authorize a new 1-USDC run. Require current exact terms and remaining spending authority before any new signature. Do not request credentials in chat. Do not repeat deployment or freeze. Keep the general funded CLI read-only.

Main now contains a buyer web implementation. Its existence does not establish browser acceptance for the original sprint. The older guidance below records earlier stages, not current merge, UI or live-run status.

## 2026-11-15 — Anish — Current sprint authority and limits

Use the [core sprint runbook](../../docs/core-sprint.md) and the latest [shared plan](../current%20plan/PLAN.md). Earlier scheduling examples below are historical fixtures, not a product taxonomy.

The user authorized sprint continuation, delegation, checkpoint commits/pushes, and normal merge integration into main. Follow the active task's narrower file and shipping scope. Publication-only limits in older handoffs are stale. No real wallet access, spending, or funded live acceptance is authorized yet.

Neil `8584b04`, Nick `57c387f`, and engine `adda3a3` are merged ancestors on `codex/engine-commerce`. The isolated Arc deployment is frozen. A later read-only refresh passed 60 checks at block 72490082. The earlier check at block 72478546 remains historical. Do not repeat the freeze. A passed deployment gate does not authorize signing or prove a funded exchange.

Keep `commerce/worker/src/cli.ts funded` read-only. The separate operator runner has seven commands documented in the runbook. It requires clean relevant source, native executable/wrapper digests, and an explicit environment. WSL fails closed for this runner only. Independent oracle and slow-suite reviews passed, and the reviewed suite source is published at `9458a81`. Final rehearsal and final-head CI remain pending. Buyer UI work remains planned.

The [previous local rehearsal](reports/core-sprint-local-2026-11-15.json) is `partial`. On source `9458a81` the lifecycle recorded a 583188 ms proof and the process exited 1. The report retains an earlier 592.4-second attempt. It is not a clean pass, live Arc, live Grok, or evidence for a later Meridian rehearsal. The current local workload is Meridian. See the [rehearsal section](../../docs/core-sprint.md#local-first-meridian-rehearsal). No fresh full pass exists yet. Provider maximum gas reservations remain permanently charged after reconciliation. Review stale locks manually. Never delete them automatically.

## Goal

Build a verification and settlement API for existing agent marketplaces. A buyer approves deterministic acceptance rules and funds a job. A worker agent proves the exact encrypted deliverable satisfies those rules while the output remains hidden. The escrow releases USDC when the worker releases the matching key.

## Decisions

- **Proof engine.** RISC Zero 3.1.0 with Groth16. Pin the prover, guest toolchain, lockfile and matching Solidity verifier. Deploy the `risc0-ethereum` v3.1.0 verifier from commit `ff30da77ba4afdd496290ebebedb205348b15d83` and check selector `0xe71e6620`.
- **Authoring.** Grok drafts typed rules or asks clarifying questions. A model adapter and typed JSON import allow other authoring clients. The buyer reviews the normalized data, rules and units before funding. The model has no signing authority.
- **Compiler.** Generate Rust from domain-independent typed plans using fixed templates. Support the catalog's bounded JSON records, aggregates, joins, and signed evidence. The guest uses checked integer arithmetic. Compile by rule structure and retain values as committed runtime parameters. Parameter-only changes alter the rules hash while preserving the guest image when all build inputs remain identical. Do not reduce the compiler to `LinearPlan` or scheduling-only rules.
- **Settlement.** Use Arc Testnet, chain ID 5042002, and direct test USDC funding. Use a pinned ERC-8183 lifecycle with a custom evaluator and policy hook, zero fees and one selected provider per funded job. Quotes can precede funding. Funded competitions with multiple solvers require a separate award flow.
- **x402.** Circle’s Arc Testnet facilitator advertised `exact`. If time allows, use it for a real paid compilation or authoring API call. ERC-8183 handles the proof-gated bounty.
- **App.** Rust compiler, guest, and engine CLI. TypeScript API, SDK, and worker, with viem and Foundry checks. A buyer web UI is planned, not implemented. External marketplaces can adopt the API/contracts but need explicit integration.

## Proof and delivery

The buyer’s funding call freezes the provider, budget, expiry, image ID, rules hash and reference hash. The Poster calls `createJob`, `setBudget`, exact-budget `approve`, then `fund`. Only the client (Poster) can call `setBudget`. Preserve the exact API-selected absolute expiry. ERC-20 amounts use six decimals. Native gas amounts use 18 decimals.

Use versioned canonical binary encodings and fixed-width public fields. The worker generates a random 32-byte key and 12-byte nonce per attempt. The guest checks the exact canonical file bundle and encrypts those bytes with ChaCha20-Poly1305. Use the job context as authenticated associated data. The envelope is the nonce, ciphertext and authentication tag.

The public job context includes chain ID, escrow address, job ID, provider, rules hash and reference hash. The guest journal commits to that context, a Boolean verdict, the SHA-256 envelope digest and a domain-separated SHA-256 commitment to the context and key. The evaluator reconstructs the exact expected journal with a passing verdict and verifies the Groth16 seal against the funded image ID and SHA-256 journal digest. Share commitment byte fixtures across Rust and Solidity. A passing proof establishes satisfaction of the approved predicates, not unexpressed intent or external truth.

The selected provider submits the envelope and proof onchain. This makes the small fixture retrievable from transaction data. A rejected proof leaves escrow funded. After proof acceptance, the worker calls the evaluator with the key. The evaluator checks the commitment, pays through ERC-8183 and emits the key in the same successful transaction. Expiry allows permissionless refund to the buyer if the job was funded or submitted without settlement. Enforce expiry on submission and release and prevent repeated payout or refund.

Use synthetic data. The key becomes public in calldata when the release transaction is broadcast, before payment, and can be exposed even if the transaction fails. Never send the real key through simulation or gas estimation. Leave a measured deadline margin. Buyer-only delivery and pre-inclusion confidentiality are follow-on protocol work.

## Worker and demo

The worker reads chain state, checks that the job is funded and assigned to its address, validates the committed inputs and allowlisted addresses, solves within its resource budget, runs the checker, proves, submits, and releases. Restrict the signer to the Arc testnet submit and release calls, zero transaction value and capped gas. Reconcile chain state before retrying. Document the decision loop and safety limits for the track.

The prior [synthetic workload](../../docs/core-sprint-input/README.md) is the legacy local package. The current local workload is [Meridian](../../docs/fresh-exchange-input/README.md). Buyer approval for a live exchange is still pending. Native OpenCode authoring of the legacy package is not Grok evidence. Keep candidates and the independent oracle outside the author's inputs. Admission checks semantic feasibility, not a hardcoded answer. Resource bounds do not provide a universal cost or latency model.

Historical scheduling example: three workers cost 4,000, 5,000 and 6,000 cents per shift. Two shifts and one-shift-per-worker rules illustrate threshold changes. Retain this example for history, not as the required current demo.

Retain tests for changed journal/image ID, cross-job replay, swapped ciphertext, incorrect key, duplicate settlement, and expiry refunds. The compiler, encryption, and synthetic proof gates already have evidence. Final funded acceptance still requires a new context-bound proof, authorized chain actions, exact recovery, and recorded payment/refund evidence. Measure timing for the selected workload.

## Sources

- [RISC Zero 3.1.0 release](https://github.com/risc0/risc0/releases/tag/v3.1.0)
- [ERC-8183 draft](https://eips.ethereum.org/EIPS/eip-8183)
- [Arc connection and network details](https://docs.arc.io/arc/references/connect-to-arc)
- [Circle testnet x402 capabilities](https://gateway-api-testnet.circle.com/v1/x402/supported)
- [UBC Devpost rules](https://ubc-hackathon-2026.devpost.com/rules)
