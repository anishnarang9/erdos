# Grok and proof pipeline sweep

The local sweep tested plan authoring, example review, compilation, proof acceptance, and delivery recovery. It made no external Grok or Bot requests and sent no live transaction.

| Check | Result |
| --- | --- |
| Current Grok adapter and API with controlled replies | Eight workloads passed native example review and buyer approval. The API declined wrong coverage digests and unqualified example checks. Three jobs compiled with Docker. |
| Independent native comparisons | 326 frozen hosted comparisons, 341 comparisons in the engine corpus, and 17 new invoice and battery dispatch cases passed. |
| Historical authoring replay | 180 initial recorded outcomes and 35 repairs. A total of 141 of 180 met the historical fidelity gate after repair. The 39 remaining defects concerned clarification or unsupported capability explanations. These were historical Luna outputs. |
| Local Arc contracts | 168 passed. One live-fork test was skipped. |
| Real proof replay | Local Solidity accepted 15 proofs when checked against their actual journals. Each of the six verdict-0 proofs rejected a changed passing verdict. |
| Claim and payout | Fresh 96-order dispatch and two-hop route proofs passed the real adapter and core on a simulated EVM with a mock payment token. |
| Recovery | Eight packages with available private keys recovered byte for byte. The archived inventory proof passed verification, but its key was unavailable. |

The fresh 128-hop route produced a passing Groth16 proof in 1,386,696 ms at 7,087,607 guest cycles. The local verifier accepted its independently reconstructed journal. Decryption matched the submitted route byte for byte. Its proof JSON SHA-256 is `3d609c2052c68c3bf0b4de5d9ca8e44272901b2d104c9cc94f62075a3e6b8a85`.

## Defects reproduced

- A buyer could answer a clarification and still fail coverage review. The API now checks quotes against the exact indexed answer. It rejects quotes from another answer or from the question.
- A repair could discard an engine-valid draft that already passed coverage or example review. The API now retains the first draft if the repair loses either passed check. Both attempts remain in the audit and billing records.
- The qualification scorer expected unsupported capability names in prose. It now also checks the native structured error for the exact capability kind and name.
- An interruption after proof publication left the attempt in `proving`. A second `prepare` can now check and recover a complete package. It makes no claim or release transaction.
- An invoice fixture can exceed the `i64` intermediate range when every input and the final rounded result fit. The checker currently rejects that input. The boundary probe used 7,378,697,629,483,821 source cents and a scale-1,000 rate of 1,250. The workload needs exact scaled arithmetic or an explicit bound in its quoted policy.

## Reproduce

From `commerce/api`, run `pnpm exec tsx scripts/check-broad-authoring.mjs /absolute/path/to/engine`. The script authenticates a synthetic buyer and uses the normal queued draft, approval, and compile routes. Docker is required for compilation.

From `engine`, run `node --test evaluation/hosted-qualification/*.test.mjs` with the native CLI built. Run `node evaluation/hosted-qualification/host-run.mjs` for the frozen comparisons.

Run `forge test --network arc --offline` from `contracts` with the pinned Arc Foundry build. Open-claim contract tests include the actual Groth16 verifier.

These results measure the software paths and finite checker expectations. Fresh Grok authoring quality, Grok Bot review quality, and hosted settlement reliability remain open.

## Live spend preflight

The user authorized up to $0.10 of existing Grok API credit. The pinned model's provider-bound reservation is $2.54096 per call. The exact-budget test confirmed that the API made zero provider requests and released the unused reservation. The documented postpaid limit does not cap prepaid spend. Provider token counts can include framing outside the tokenizer result. Live spend remains $0.
