# Open-claim implementation plan

2026-11-16 — Anish. Execute the user-supplied Open-Claim Arc Escrow Implementation Plan in this chat. The supplied design authorizes implementation and parallel independent workers.

- [x] Read project guidance, owner status, core, hook and ERC-8183 draft. Fetch refs and verify Nick 57c387f is an ancestor of reviewed integration ae1295a.
- [x] Create codex/overnight-open-escrow in an isolated managed worktree. Preserve active proof worktrees.
- [x] Publish the normative interface before implementation.
- [ ] Standards worker: review current draft against pinned core, document selectors/events/errors and x402 boundary.
- [ ] Implementation worker: add isolated adapter and local deploy script. Match the published API.
- [ ] Independent test worker: write adversarial Foundry coverage in an exclusive test file.
- [ ] Parent: run baseline, real verifier checks, full pinned Arc suite, ABI parity and TypeScript examples.
- [ ] Independent reviewers: audit specification compliance, payout safety and callback/token accounting.
- [ ] Publish ABI, manifest template/schema and source checkpoints with status updates.
- [ ] Hand exact SHAs and commands to the proof/commerce chat. Verify a clean checkout. Review combined fresh-proof evidence when available.
- [ ] Publish final acceptance and deployment limits. Live transactions require separate authorization.
