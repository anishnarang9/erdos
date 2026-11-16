# UBC 2026 · Three-way work split

**2026-11-14 · Anish workstream · Proposed handoff**

Use the [settlement and commerce integration entry](PLAN.md#2026-11-14-2048--0500--anish--settlement-and-commerce-integration) for the current core source, hook layout, and delivery limits.

The buyer approves a job and funds a USDC bounty. The solver completes the job, proves that the deliverable meets the rules, and submits the encrypted deliverable. An evaluator verifies the proof on Arc Testnet. The solver releases the matching key in the transaction that pays the bounty.

| Workstream | Owner | Delivers |
| --- | --- | --- |
| **1. RISC Zero engine** | Anish | Typed rule compiler, guest, local proving CLI, proof package, and byte fixtures |
| **2. Arc and Ethereum settlement** |  Nick| ERC-8183 escrow, verifier, policy hook and evaluator, deployment manifest, and transaction tests |
| **3. Agent-to-agent commerce** |  Neil| Buyer and solver workflows, job API, chain client, and full demo |

Assign the two open roles within the team. Each owner can turn their section into an implementation plan. Use the [engine plan](ZKVM-IMPLEMENTATION.md) as the source for the proof wire format.

## 1. RISC Zero engine

**Own the conversion from approved rules to a guest, and from local files to proof bytes.**

- Publish the supported rule schema, parser catalog, capability error format, and deterministic validation command. Include a sample request for a missing capability. This is what the commerce owner supplies to the authoring model.
- Compile the approved rule structure into a guest. Publish a manifest with the image ID, rules hash, reference hash, toolchain versions, and content digests for package files. Keep per-job parameters and reference data bound to the manifest.
- Deliver the local CLI for proof generation and decryption. The solver owns the plaintext and key. The CLI exports an Arc submission artifact and saves the key separately.
- Supply two fixtures for independent work. Give Solidity and TypeScript the deterministic encoding fixture immediately. Give the settlement owner a fresh Groth16 fixture for a job whose actual context is fixed before proving. An upstream receipt can test the verifier independently of either fixture.
- Accept the work when two unrelated job types use the same compiler and CLI. A supported rule change must produce the intended result. A parameter-only change must update the rules hash and preserve the image ID. Record timings and validate every enabled evidence profile in the guest. [Engine implementation plan](ZKVM-IMPLEMENTATION.md)

## 2. Arc and Ethereum settlement

**Own USDC custody, proof verification, and key release.** Deploy the first release on Arc Testnet. Use standard Ethereum tooling and interfaces. Run local EVM tests with Foundry and use Arc RPC for final acceptance. A separate Ethereum deployment can follow the same design with its own chain ID, escrow, token, and verifier configuration. [Arc connection settings](https://docs.arc.io/arc/references/connect-to-arc)

### Contracts and responsibilities

1. **Pin the ERC-8183 core.** Use a separate deployment of Circle's verified core source. Apply the Poster-only `setBudget` authorization patch from the settlement plan. Record the source, patch, Solidity settings, deployed bytecode, and ABI. Match the verified core's hook encodings and test them against the deployed ABI. [Settlement implementation plan](SETTLEMENT-IMPLEMENTATION.md)
2. **Deploy the released RISC Zero verifier.** Pin `risc0-ethereum` v3.1.0 at `ff30da77ba4afdd496290ebebedb205348b15d83`. Use its released control IDs and selector `0xe71e6620`. Run the released test receipt before testing the evaluator. Record the Arc verification gas and a transaction or reproducible RPC call. The earlier team pin `f6d9398` uses a different selector. [Released verifier](https://github.com/risc0/risc0-ethereum/releases/tag/v3.1.0) · [Test receipt](https://github.com/risc0/risc0-ethereum/blob/v3.1.0/contracts/test/TestReceiptV3_1.sol)
3. **Implement a policy hook and evaluator.** Use one contract for both roles to keep commitment and acceptance state together. Set both roles to that address when the buyer creates a job. Accept callbacks only from the configured core. Fund one provider per job, use a positive bounty, and use zero fees. Freeze the funded provider, image ID, rules hash, reference hash, budget, and expiry. Use Arc's ERC-20 USDC interface at `0x3600000000000000000000000000000000000000` with six decimals. Native transaction gas uses Arc's native USDC units. [Arc USDC details](https://docs.arc.io/arc/references/contract-addresses#usdc)
4. **Verify before the core records submission.** The provider calls `submit(jobId, envelopeHash, optParams)`. Encode `optParams` as Solidity `abi.encode(bytes envelope, bytes seal, bytes32 keyCommitment)`. Decode the callback as `(address caller, bytes32 envelopeHash, bytes optParams)`. Require a funded job, a deadline in the future, and an envelope inside the published byte limit. Compute the actual envelope hash. Reconstruct the versioned journal with verdict 1 from funded state and the submitted commitments. Call `verify(seal, fundedImageId, sha256(journal))`. Revert on failure. Store acceptance and emit a compact event with the envelope hash and key commitment after success. The transaction calldata carries the encrypted envelope.
5. **Release only after proof acceptance.** Use `release(jobId, bytes32 key)` on the evaluator. Require the provider, Submitted state, and a deadline in the future. Recompute the key commitment from the exact job context. Call core `complete` only when the key matches. Emit a release event in the same transaction. Revert if the payout fails. Enforce a guard against duplicate release and preserve the core's unhooked, permissionless refund after expiry. [ERC-8183 lifecycle](https://eips.ethereum.org/EIPS/eip-8183#state-machine)
6. **Protect the funded path.** Decode the funding callback as `(address caller, bytes optParams)`. Decode `optParams` as `(bytes32 imageId, bytes32 rulesHash, bytes32 referenceHash)`. Validate the tuple in the before hook. Record the frozen terms in the after hook once the core reports Funded. Read the provider, budget, and expiry from the core. Test effect order around token transfers. Reject zero-budget and unfunded submission paths for proof-gated jobs, even if the upstream core permits free jobs. Ensure only the evaluator can complete through the core. Write the expected callback encodings for `fund`, `submit`, and `complete` into the manifest or ABI integration notes.

A submitted envelope proves that the checker used the bound key and file bytes. Arc publishes the key in transaction calldata. The key can become visible before confirmation, including if the release fails. Use synthetic data and preflight release with a deadline margin. The buyer can check the envelope and decrypt it with the confirmed key. [ERC-8183 hook atomicity](https://eips.ethereum.org/EIPS/eip-8183#hook-behaviour)

### Handoff and acceptance

- Publish a deployment manifest with chain ID, RPC and explorer links, USDC address and decimals, core, hook/evaluator and verifier addresses, ABI files, fee policy, time boundary, and both the encoded bundle and encrypted envelope limits. Publish tested read methods and event fields for funded terms, submission, completion, and refund.
- Test caller authorization, wrong image ID, mutated envelope, invalid seal, a genuine verdict-0 receipt, commitment substitution, and replay across job, provider, deployment, or chain. Check that a bad submission leaves the escrow Funded.
- Test wrong key, early release, duplicate release, timeout before and after submission, a reverting payout, and exact expiry. Check USDC balance changes. Record the proof submission, completion, and refund transactions on Arc. Measure gas near the 16 KiB initial delivery cap.
- Supply commerce with contract writes, event decoders, transaction preflight examples, and sample receipts. Supply the engine with the selected calldata cap and one real funded context before the final proof run.

## 3. Agent-to-agent commerce

**Own the interaction between buyer and solver agents and the link from that interaction to the funded job.** Start with an authenticated HTTP JSON API plus a TypeScript reference client. An existing marketplace can use the same flow. An A2A adapter can follow once the core workflow works. The A2A protocol defines agent discovery, tasks, and artifacts if that integration becomes necessary. [A2A specification](https://a2a-protocol.org/latest/specification/agent-card/)

### Buyer and solver flow

1. **Draft the job.** Accept a clear request, required file names and formats, and optional reference files. Give Grok the engine schema and supported operation catalog. Accept typed import through the same validator. Return a typed draft, a clarification request, or an unsupported capability. Validate the model output with the engine. [Grok structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
2. **Approve the exact commitments.** Show the normalized rules, units, examples, data sources, available signer profiles, expiry, provider, and price. Compile the approved rules. Show the resulting image ID and commitment hashes in the funding request. If a draft or input changes, require approval of the new version before funding.
3. **Select a solver.** Allow agents to discover job types and submit an off-chain quote with provider address, price, and validity. The buyer selects one solver before funding. Link quote acceptance to the approved job revision. Use the funded provider and terms as the source of truth once the job is on Arc.
4. **Execute and prove.** The solver polls assigned jobs, checks funded terms against the package, and produces the required files using its own tools. Run the engine CLI locally. Check the verdict and calculate whether enough time remains for submission and release. Keep plaintext and keys out of the app API and model context.
5. **Submit and release.** Preflight the provider transaction with the production ABI and wait for a successful submission receipt. Read the onchain job before retrying. Before release, check the accepted commitment and expiry. Submit the matching key and read the completion event before reporting settlement. Keep transaction submission and key release restricted to the funded job, configured chain and contracts, zero native value, and explicit gas caps.
6. **Deliver to the buyer.** Resolve the accepted transaction, retrieve the envelope from calldata, and match its hash to the accepted event. Read the key from a confirmed release event. Decrypt with the engine CLI and recover the exact named files. Show the verification and payment receipts.

### API, status, and optional payment

| Operation | Input and result |
| --- | --- |
| `POST /v1/drafts` | Request and references in. Typed draft, clarification, or missing capability out. |
| `POST /v1/jobs` | Validated draft revision in. App job ID out. |
| `POST /v1/jobs/{id}/approve` | Exact draft revision and reference digest in. Buyer approval record out. |
| `POST /v1/jobs/{id}/compile` | Approved revision in. Checker package and commitment manifest out. |
| `GET /v1/jobs` | Filter by capability and availability. Return jobs open for quotes. |
| `POST /v1/jobs/{id}/quotes` | Provider quote in. Quote ID and validity out. |
| `POST /v1/jobs/{id}/select-quote` | Quote ID and approved revision in. Funding terms and transaction request out. |
| `POST /v1/jobs/{id}/funding-receipt` | Core transaction hash in. Verify onchain terms before linking the confirmed job ID. |
| `GET /v1/jobs/{id}` | App status plus chain ID, funded job ID, and confirmed chain status. |
| `GET /v1/assignments` | Authenticated provider receives its funded job references. |
| `GET /v1/jobs/{id}/submission` | Accepted transaction, envelope hash, and release status. |

Use an app job ID before funding. Persist the chain job identity as chain ID, core address, and job ID after funding. Use revision checks and idempotency keys on writes. Persist pending transaction hashes and reconcile them on restart. Show local states such as proving or submission pending separately from confirmed contract states.

If the core demo works, add one paid compiler or authoring API call through x402. Confirm the Circle facilitator still lists Arc Testnet and `exact` before integration. Exercise a real test payment. Retain the ERC-8183 escrow path for the bounty. Quicknode Streams can supply optional event notifications. Reconcile them against Arc state. Its webhook HMAC uses a shared secret. A future trusted issuer can sign authenticated stream data for the zkVM. [x402 flow](https://docs.cdp.coinbase.com/x402/how-it-works) · [Circle testnet facilitator](https://gateway-api-testnet.circle.com/v1/x402/supported) · [Quicknode webhooks](https://www.quicknode.com/docs/streams/destinations/webhooks)

### Handoff and acceptance

- Give the engine owner one typed draft from the real authoring flow and one job that triggers the unsupported capability response. Give the settlement owner the expected reads, writes, and status fields for the TypeScript client.
- Show buyer approval and funding, solver assignment, local CLI invocation, proof submission, key release, payment, and decryption in one trace. Include three negative paths. Reject a changed draft after approval, recover from a duplicate or interrupted request, and show an expired job reaching refund.
- Build against fixture responses and local EVM contracts while the other owners implement their systems. Label fixtures as simulated. Use real Arc receipts and Groth16 proofs for the final demo.

## Integration gates

| Gate | Engine | Settlement | Commerce |
| --- | --- | --- | --- |
| **Interface** | Publish wire format, synthetic vector, CLI commands, and rule schema | Publish ABI, chain config shape, and mock receipts | Use the shared fields in app requests and chain adapters |
| **First proof** | Prove a tiny guest and export its receipt | Verify the upstream fixture and engine receipt on Arc | Run draft, approval, quote, and status against fixtures |
| **First funded job** | Prove against a fixed funded context | Verify on submit, release key with USDC payout, and check refund | Drive both agents and decrypt from confirmed chain data |
| **Demo** | Prove two unrelated job types and record timings | Record pass, fail, and refund evidence | Rehearse the user flow and retain reproducible sample inputs |

Use the existing November 18 internal rehearsal target. Run the first real proof and ERC-8183 refund early. If live proving exceeds the demo window, use a previously generated real receipt for the exact funded job and artifact. Generate it after the job context is known.
