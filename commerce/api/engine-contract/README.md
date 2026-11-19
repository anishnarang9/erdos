# Engine contract files

Read-only copies of the engine's authoring contract. The API gives them to Grok when it drafts a plan. The engine is the source of truth.

| File | Source | SHA-256 |
| --- | --- | --- |
| `plan-v1.schema.json` | `engine/plan-v1.schema.json` | `3de271534215873ea74993c8f1f8a63254cea94f957dcb7ab3c79fcaf9d711de` |
| `capabilities-v1.json` | `engine/capabilities-v1.json` (`engine capabilities` prints the same JSON) | `da4f7957d2dc862c043879a13c50dddb355ad8d83903f33c8dce79f0e85eb9f2` |

The engine integration test checks that `engine capabilities` still equals `capabilities-v1.json`. When the engine changes either file, copy both again and update this table.
