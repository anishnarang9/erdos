# Anish’s project context

## Goal

Build a verification and settlement API for existing agent marketplaces. A buyer approves deterministic acceptance rules and funds a job. A worker agent proves the exact encrypted deliverable satisfies those rules while the output remains hidden. The escrow releases USDC when the worker releases the matching key.

## Decisions

- **Proof engine.** RISC Zero 3.1.0 with Groth16. Pin the prover, guest toolchain, lockfile and matching Solidity verifier. Deploy the `risc0-ethereum` v3.1.0 verifier from commit `ff30da77ba4afdd496290ebebedb205348b15d83` and check selector `0xe71e6620`.
- **Authoring.** Grok drafts typed rules or asks clarifying questions. A model adapter and typed JSON import allow other authoring clients. The buyer reviews the normalized data, rules and units before funding. The model has no signing authority.
- **Compiler.** Generate Rust from bounded, typed linear predicates using fixed templates. Rust compiles to the RISC-V guest. The guest evaluates a Boolean assignment using checked integer arithmetic. Compile by rule shape and pass indices, coefficients and thresholds as committed runtime data. Changes to thresholds produce a different plan digest while retaining the same guest image when shape is unchanged.
- **Settlement.** Use Arc Testnet, chain ID 5042002, and direct test USDC funding. Use a pinned ERC-8183 lifecycle with a custom evaluator and policy hook, zero fees and one selected provider per funded job. Quotes can precede funding. Funded competitions with multiple solvers require a separate award flow.
- **x402.** Circle’s Arc Testnet facilitator advertised `exact`. If time allows, use it for a real paid compilation or authoring API call. ERC-8183 handles the proof-gated bounty.
- **App.** Rust worker and prover CLI, thin TypeScript UI/API, viem and Foundry with Arc-specific deployment checks. An external marketplace can supply its own solver and call the API or contracts.

## Proof and delivery

The buyer’s funding call freezes the provider, budget, expiry, image ID, plan digest and dataset digest. Use versioned canonical binary encodings and fixed-width public fields. The worker locally generates a new random 32-byte key and 12-byte nonce per attempt. The guest checks the canonical assignment bytes and uses ChaCha20-Poly1305 to encrypt those same bytes. Use the job context as authenticated associated data. The envelope is the nonce, ciphertext and authentication tag.

The public job context includes chain ID, escrow address, job ID, provider, plan hash and dataset hash. The guest journal commits to that context, a Boolean verdict, the SHA-256 envelope digest and a domain-separated SHA-256 commitment to the context and key. The evaluator reconstructs the exact expected journal with a passing verdict and verifies the Groth16 seal against the funded image ID and SHA-256 journal digest. Share commitment byte fixtures across Rust and Solidity. A passing proof establishes threshold feasibility.

The selected provider submits the envelope and proof onchain. This makes the small fixture retrievable from transaction data. A rejected proof leaves escrow funded. After proof acceptance, the worker calls the evaluator with the key. The evaluator checks the commitment, pays through ERC-8183 and emits the key in the same successful transaction. Expiry allows permissionless refund to the buyer if the job was funded or submitted without settlement. Enforce expiry on submission and release and prevent repeated payout or refund.

Use synthetic schedules. The key becomes public in calldata when the release transaction is broadcast and can be exposed even if the transaction fails. Preflight and leave a deadline margin. Buyer-only delivery and pre-inclusion confidentiality are follow-on protocol work.

## Worker and demo

The worker reads chain state, checks that the job is funded and assigned to its address, validates the committed inputs and allowlisted addresses, solves within its resource budget, runs the checker, proves, submits, and releases. Restrict the signer to the Arc testnet submit and release calls, zero transaction value and capped gas. Reconcile chain state before retrying. Document the decision loop and safety limits for the track.

Use three workers costing 4,000, 5,000 and 6,000 cents per shift, two shifts and a one-shift-per-worker rule. Job A caps cost at 10,000 cents with minimum coverage [1, 1]. The first two workers qualify. Job B caps cost at 16,000 cents with minimum coverage [2, 1]. Submit a real failing-verdict receipt for the two-worker schedule and show the bounty remains funded. Then submit a passing receipt for the 15,000-cent three-worker schedule, show proof acceptance while the result is hidden, and show payout plus decryption. Both jobs use the same checker image and verifier.

Test changed journal and image ID, cross-job replay, swapped ciphertext, incorrect key, duplicate settlement and expiry refunds. Confirm fund movement through onchain evidence. Start with an upstream receipt and a freshly generated tiny guest receipt on the deployed Arc verifier. Benchmark proving time and verification gas. Then finish the compiler and encryption, exercise settlement, connect authoring and the worker, and rehearse by Wednesday, November 18. Proof generation and complete settlement are build gates.

## Sources

- [RISC Zero 3.1.0 release](https://github.com/risc0/risc0/releases/tag/v3.1.0)
- [ERC-8183 draft](https://eips.ethereum.org/EIPS/eip-8183)
- [Arc connection and network details](https://docs.arc.io/arc/references/connect-to-arc)
- [Circle testnet x402 capabilities](https://gateway-api-testnet.circle.com/v1/x402/supported)
- [UBC Devpost rules](https://ubc-hackathon-2026.devpost.com/rules)
