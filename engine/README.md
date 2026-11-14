# UBC26 engine

The engine turns buyer-approved rules into commitments for a funded job. The final guest will check the deliverable and encrypt its exact bundle bytes. The Arc evaluator will verify the job journal and the matching key commitment. See the [engine plan](../agents/current%20plan/ZKVM-IMPLEMENTATION.md) for the full flow.

## Validate a plan

Run these commands from the repository root.

```sh
cargo +stable run --locked --manifest-path engine/Cargo.toml --bin engine -- \
  validate --plan engine/fixtures/expense-report-plan.json
cargo +stable test --locked --manifest-path engine/Cargo.toml --workspace
node engine/fixtures/check-wire-v1.mjs
```

The validator writes one JSON object to stdout. It includes the normalized structure, ordered parameter slots, canonical JSON, and both hashes. The structure uses zero-based file and field indices in declaration order. Literal values enter parameter slots in rule traversal order. Edit the budget in the sample plan to see the rules hash change while the structure hash stays the same.

The current syntax supports scalar `bool`, `i64`, and `string` values. Write `i64` literals as decimal strings. Rules can read declared fields from `json/v1` files or compare all the text in a `text/v1` file. Use `opaque/v1` for a file declaration with no projected fields. The rule operations are `field`, `literal`, `add`, `sub`, `mul`, `lt`, `lte`, `gt`, `gte`, `eq`, `ne`, `and`, `or`, and `not`. Every rule in the top-level list must evaluate to a Boolean.

A validation failure exits with code 2 and writes JSON to stderr. Unsupported operations, parsers, and evidence profiles include a request with the capability kind and name. For example, an unsupported `sum` rule reports:

```json
{"code":"unsupported_capability","path":"/rules/0/op","message":"Unsupported operation \"sum\"","request":{"kind":"operation","name":"sum"}}
```

Successful validation produces commitments only. Rule evaluation, generated checker builds, and the funded-job `prove` and `decrypt` commands require the guest integration.

## Use the wire fixture

[wire-v1.json](fixtures/wire-v1.json) contains the complete bytes for a synthetic funded context, file bundle, encrypted envelope, and journal. The fixture includes a public test key and nonce. The Rust tests and Node script check the same fixture independently. The Node script also checks exact bundle recovery and rejection after the job ID changes.
