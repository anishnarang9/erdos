# Hosted candidate source review

Reviewed on 2026-11-17 by one fresh-context, read-only Codex reviewer. The reviewer inspected `8c98d6b..20b0dc282482ad22d7fff49ffe86de903576f547`. Later branch commits changed documentation only. Product source still matches the candidate.

## Assessment

The reviewer found no actionable code defect in the inspected changes. Those changes need no identified source fix before the next acceptance stage. This assessment does not approve public release or establish native-host behavior.

The earlier [Grok review](hosted-integrated-security-review.md) covers `8c98d6b`. This review covers the later candidate changes. It used no Grok CLI call and created no implementation worker or worktree.

## Inspected boundaries

- Exact CORS rejection and preflight precede route work, including operator metrics. Public logs use fixed route labels.
- Paid compilation checks ownership before replay. It reserves bounded capacity before settlement, rechecks approval after waiting and preserves uncertain payments after shutdown.
- Durable compilation shares the compiler lease. Claim rollback releases that lease. Task acceptance and spending reservation remain atomic.
- Campaign v2 binds principals, inputs, mode, model, task identity and terminal results. Reused tasks or traces stop the campaign. Unknown costs retain their reservation.
- Packaging fixes the esbuild working directory and pins source links. The committed candidate report records Linux payload manifest `cc1b0196cb4e3d250ccf8decb286f88663544dd00ffe3e19aac2c392e40f957d` for reproducibility and native installed checks.

## Checks run by the reviewer

All 106 targeted checks passed on Node `v24.10.0`.

From `commerce/api/`:

```sh
pnpm exec vitest run test/unit/browser-origin.test.ts test/unit/paid-compile-admission.test.ts test/unit/x402-paid-compile.test.ts
# 33 passed

pnpm exec vitest run test/spec/hosted-tasks.test.ts test/unit/observe.test.ts
# 12 passed

pnpm exec vitest run test/spec/hosted-task-idempotency.test.ts test/spec/hosted-authoring-bounds.test.ts test/spec/hosted-billable-bound.test.ts test/spec/hosted-failure-metadata.test.ts
# 22 passed
```

From the repository root:

```sh
node --test engine/evaluation/hosted-qualification/campaign.test.mjs engine/evaluation/hosted-qualification/trials.test.mjs
# 39 passed
```

The reviewer also inspected committed CI, image and archive evidence. The reviewer did not independently rebuild or execute those artifacts. No Docker, real compiler, prover, genuine model request, network, chain, wallet, operator-file or account action ran.

## Remaining acceptance

Public API/TLS operation, native deployment resource limits, secure application model access and approved budgets, 180 genuine qualification trials and fresh authorized funded acceptance remain open. Review actual host configuration and new deployment evidence before release. Reassess affected source after a behavior change. Keep PR #8 draft until the sprint's full completion gates pass.
