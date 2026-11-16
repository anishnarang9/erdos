# Engine contract files

Read-only copies of the engine's authoring contract. The API gives them to Grok when it drafts a plan. The engine is the source of truth.

| File | Source (branch `codex/anish-engine`, commit `adda3a3`) | SHA-256 |
| --- | --- | --- |
| `plan-v1.schema.json` | `engine/plan-v1.schema.json` | `5c333917cf889e1682d38da76e95a4da9b331c4dd95870da5fb2e4f6050ead56` |
| `capabilities-v1.json` | `engine/capabilities-v1.json` (`engine capabilities` prints the same JSON) | `fdb05c7b3ab6cac185dca29771e5f9364d9d3170174f14223d70c9a9f2db2e6a` |

The engine integration test checks that `engine capabilities` still equals `capabilities-v1.json`. When the engine changes either file, copy both again and update this table.
