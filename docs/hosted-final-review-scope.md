# Final hosted candidate review

Candidate code is `20b0dc282482ad22d7fff49ffe86de903576f547`. The [scoped candidate source review](hosted-candidate-code-review-2026-11-17.md) is complete. One fresh-context reviewer found no actionable defect and passed 106 targeted checks. Native host configuration and public/live acceptance still need review. PR #8 remains draft. The user directed no more Grok CLI calls.

The earlier [independent review](hosted-integrated-security-review.md) covers `8c98d6b`. It does not approve the later ingress, paid compiler, qualification campaign or packaging changes. Current passing tests are evidence for review. They do not replace independent approval.

Review the current source and the diff from `8c98d6b`. Focus on these boundaries:

- `commerce/api/src/browser-origin.ts`, `observe.ts` and `capacity.ts`: exact origins, preflight before route work, operator ordering and fixed public log labels.
- `commerce/api/src/compile-admission.ts`, `x402.ts`, `tasks.ts` and `authoring.ts`: bounded ownership before settlement, immutable replay, post-wait approval checks, durable claim rollback and late shutdown responses.
- `engine/evaluation/hosted-qualification/trials.mjs`, `campaign.mjs` and `budget.mjs`: distinct wallet preflight, original request provenance, global task/trace uniqueness, conservative unknown bills, one writer and bounded polling.
- Campaign v2: live mode cannot change on resume. Live model/price checks precede network calls. Every attempt reports the reviewed model. Prompt/catalog identities remain in trial records. A partial score cannot claim the full corpus gate.
- `commerce/worker/scripts/package-runner.mjs`: canonical source-path comments, immutable source links, independent installation and manifest verification. Native Linux CI and both caller directories must select the same payload manifest.
- `deploy/` and the candidate reports: immutable payloads, actual prewarm output, owner-safe restore and source/platform limits. Configured readiness does not prove provider access or public hosting. Process counters do not enforce disk quotas.

Exact-source commerce and core CI pass. They include 939 API, 365 SDK, 945 worker and 63 qualification checks. Native Linux checks all twelve signed cases. The SDK also has thirteen wire checks. Review the [candidate evidence](../agents/anish/reports/hosted-release-candidate-2026-11-17.json) for ignored tests and reused evidence.

Run commerce checks from `commerce/` with `pnpm typecheck` and `pnpm test`. Run the qualification suite from the repository root with an explicit reviewed `UBC26_ENGINE` and `node --test engine/evaluation/hosted-qualification/*.test.mjs`. These checks need no genuine model call, proof or chain transaction. Keep all signers and credentials outside the review environment.

The selected DigitalOcean host has verified SSH identity, bounded storage, Docker, an imported candidate image and the pinned BuildKit worker. Native cold compilation, operator-channel API acceptance, process restart, separate-instance restore and external TLS pass. The helper and Compose follow-up reviews found no actionable code defect and passed ten and eleven deployment checks. A reviewer identified stale report/runbook claims. The native reports and current runbook now record actual outcomes. Public API readiness remains false. The application key authenticates for model listing, but the user permits only ten cents per complete authoring run and deferred mass testing. A reviewed input/session cost bound, genuine qualification and current live-action authority remain pending. Genuine trials remain zero. The deployment review must retain those open gates. No public release or new funded acceptance is established.
