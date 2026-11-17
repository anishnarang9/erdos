# Fresh 1-USDC exchange constraint authoring

Model grok-4.7-build-fast, low reasoning, native Grok inference through Orca. No HTTP DraftModel call.

## Task

Bounded low-cost constraint author for the user's fresh 1-USDC exchange goal. Work from the repository root. Translate the exact 13 English requirements in `docs/fresh-exchange-input/request.md` into one engine-supported typed plan using bounded records, aggregates, uniqueness, lookup, and all/any. Preserve required file names and schemas, signed i64 string units, exact joins, and inclusive bounds. No answer hash, hidden witness, optimization, or invented constraints. Validate with `engine/target/debug/engine validate --plan docs/fresh-exchange-input/plan.json`. At most two validation-only repair attempts. Write only `docs/fresh-exchange-input/plan.json` and the authoring logs in this directory. No Groth16 proof, compile, network write, credentials, nested agents, or git mutation.

This is a sanitized task summary with exact input digests, not a complete session transcript. The original Orca dispatch also supplied process and output-recording instructions.

## Allowed inputs and SHA-256

- `docs/fresh-exchange-input/request.md` `229223c55c23c24e0f70413154acd84994672fa6fee76fe247557c288ec2750e`
- `docs/fresh-exchange-input/reference/dataset.json` `6ccaaf06a64a68039dace223fc36fad9f60efce3f250d6044c5f7274b60fc06f`
- `docs/fresh-exchange-input/outputs.json` `ccf5f21cac432a09c93b51ebfe000aeb602227cea70707a0815c74489dce79aa`
- `engine/plan-v1.schema.json` `5c333917cf889e1682d38da76e95a4da9b331c4dd95870da5fb2e4f6050ead56`
- `engine/capabilities-v1.json` `fdb05c7b3ab6cac185dca29771e5f9364d9d3170174f14223d70c9a9f2db2e6a`

`engine/README.md` was read only for validate syntax and collection operation meanings. The validator binary was `engine/target/debug/engine`.
