# Recorded Grok drafts (handoff to Anish)

These are real `grok-4.7` calls, made through `POST /v1/drafts` with the real engine (`codex/anish-engine` `adda3a3`). `pnpm --filter @ubc26/api record:grok` recorded them. The `<sha256>.json` files hold the exact model input and Grok's reply, and `grok-replay.test.ts` replays them offline. `summary.json` holds the API responses. No API key is stored.

| Case | Request | Result |
| --- | --- | --- |
| `reconciliation` | Reconcile `result.json` against the reference `ledger.json`, plus a `report.txt` note | `kind: draft`. The engine validated the plan: `rulesHash 0xe5d4f5a0…`, `structureHash 0x2308b819…`. The rules use `unique`, `count`, a `lookup` in each direction, `sum`, and `file_size > 0` on the report. The checker agreed with Grok's predicted verdict on 4 of 5 examples. |
| `regexEmails` | Every email in `contacts.json` must match a regular expression | `kind: unsupported`, `reason: capability_unsupported`. The engine error is passed through unchanged: `{"code":"unsupported_capability","message":"Unsupported operation \"regex_match\"","path":"/rules/0/right/where/op","request":{"kind":"operation","name":"regex_match"}}` |

The draft input includes the engine plan schema, the capability catalog and the reference file text. The model needed the reference text: given only file names, Grok asked twice for the ledger's shape.

**Finding for the engine:** in the reconciliation draft, Grok's example `duplicate-and-missing` repeats an id in `result.json`. `engine eval` aborts on it with `invalid_deliverable: Invalid rule expression` and does not return verdict 0. The cause is that `lookup` rejects duplicate keys in its source collection. A solver that delivers a duplicate therefore gets no verdict-0 proof at all; proving aborts. This is safe, because nothing is paid. Still, a reconciliation plan that runs `unique` first might be expected to just fail. Is the abort intended?
