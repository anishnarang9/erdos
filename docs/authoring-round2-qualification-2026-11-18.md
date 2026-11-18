# Second controlled authoring qualification

**Status, 2026-11-18 08:38 -05:00:** Prepared for review. No second paid run has started. The first ten-case pilot remains failed. This plan uses the code merged in PR #18 at `fc3ea3eca7f6bc1a5dd7ac3ddfa82c6d29effc6f` and requires a new paid-test allowance before any dispatch.

## Scope and admission

- Use the existing personal xAI API and Grok Bot accounts only for a controlled synthetic test. A separate production Bot account is still required before general public authoring.
- Build an isolated image from the exact source SHA above. Use a new local-mode state directory, one scoped buyer wallet, no published container ports, and only the authenticated HTTPS Bot callback route. Keep the public API on its current release until qualification passes.
- Pin the Linux engine, check free disk and memory, create `tmp`, `cache`, `work`, and `packages` before launch, and verify the image source and engine digests. Confirm that rollback restores the prior callback route and that the pilot container can be stopped without touching public state.
- Use ten new queued draft tasks, at most nine exact-revision Bot dispatches, zero paid repairs, one attempt at a time, and no Arc transaction. Preserve each idempotency key, task ID, provider usage, and callback receipt. Stop on an uncertain charge, send, callback, or account attribution.
- Proposed stop limits: at most $1 observed incremental API plus Bot spend and at most $0.15 observed per attempt. These are proposed limits for a new authorization; the previous ten-draft allowance is exhausted.

## Frozen cases and grading

Use only the plain-English `draftInput` for each corpus case. Do not pass the oracle plan, hidden candidates, expected verdicts, or other case's output to the model or Bot. The set covers observed failures and unseen tasks:

| Case | Role in sample |
| --- | --- |
| `pier-drawers` | Repeat the malformed nested JSON case |
| `lot-range-1` | Repeat the Boolean `unique` versus numeric `count` error |
| `badge-zone-1` | Repeat the duplicate `rows` declaration error |
| `nights-1` | Repeat the duplicate `rows` error in a different family |
| `firmware-note-1` | Recheck the prior native-valid, Bot-passed plan through queued compile |
| `pier-variance` | Unseen pier reconciliation task |
| `sensor-1` | Unseen pharmacy inventory task |
| `clearance-1` | Unseen badge policy task |
| `berth-swap-1` | Unseen berth allocation task |
| `hq-ambiguous-7` | Ask for missing toll table and currency unit |

For each supported case, save the raw draft kind, exact sanitized failure reason, provider usage, native validation, examples, source-quote verification, coverage, and independent hidden-candidate oracle result. Request Bot review only when those checks pass. Approve the exact revision and compile only after Bot passes. The ambiguous case must ask the missing policy questions without creating a payable draft. A failed case stays failed after any later diagnostic repair.

The target is nine valid supported plans with no hidden-candidate disagreement and one adequate clarification. Every accepted supported plan must pass exact Bot review and queued compile. Record complete-run cost and elapsed time. A low average cost cannot compensate for a failed quality result, and this ten-case sample alone cannot establish general production reliability.

## Release decision

Keep general public authoring gated until the new sample passes, the revised 5–10¢ average complete-run target is supported by attributable billing, and the production account boundary is set. If any case fails, preserve the evidence and diagnose it offline before another paid campaign. The earlier cold Arc job 9 remains a separate scoped acceptance result; it does not qualify this production policy.
