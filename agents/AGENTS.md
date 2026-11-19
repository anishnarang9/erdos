# Shared collaboration context

Before starting work, read the [shared planning rules](current%20plan/AGENTS.md) and the [current plan](current%20plan/PLAN.md). Record your own progress in your `status.md`. Record decisions and changes that affect the team in the shared plan.

Plan documents in `current plan/`:
- [WORK-SPLIT.md](current%20plan/WORK-SPLIT.md) splits the work into three workstreams with owners.
- [ZKVM-IMPLEMENTATION.md](current%20plan/ZKVM-IMPLEMENTATION.md) covers the engine and is the source of truth for the wire format.
- [COMMERCE-IMPLEMENTATION.md](current%20plan/COMMERCE-IMPLEMENTATION.md) covers agent-to-agent commerce.
- [ARCHITECTURE.md](current%20plan/ARCHITECTURE.md) and [MARKETPLACES.md](current%20plan/MARKETPLACES.md) hold research notes. The banner at the top of each says which parts are superseded.

## Agent selection and delegation

- Use `agy` first for bounded work that another agent can do independently. Prefer the lowest capability model that can do the work. Run `agy models` to confirm the available model IDs.
- Use available `agy` free credits for useful work before moving to another provider or paid capacity. This includes work suitable for Claude or GPT: use the available Claude or GPT option through `agy` when a stronger model is needed. Continue through `agy` until its free allowance is exhausted for the work session. Do not spend credits on filler or retry loops.
- For buyer acceptance, start a fresh `agy --model gemini-3.8-flash-low` session. Give it the public guide, the task, and scoped test access. Assume the buyer will need clear instructions and may get stuck. Have the solver agent help through the intended workflow when needed. Record the first blocker, the help given, and the result. Keep the buyer on Flash Low while measuring the buyer experience.
- The Arc demo tests the workflow. The solver can use any suitable model, including Flash Low, and can receive a prepared receipt or other test deliverable. Label the supplied input in the evidence. The solver still needs to verify it, generate a fresh proof bound to the new funded job, settle on Arc, and let the buyer recover the exact bytes.
- Keep delegated access scoped to the task. Keep credentials and wallet secrets out of prompts and logs. Review agent output and verify consequential actions before depending on them.

## Workstreams

| # | Workstream | Owner | Plan |
| --- | --- | --- | --- |
| 1 | RISC Zero engine | Anish | [ZKVM-IMPLEMENTATION.md](current%20plan/ZKVM-IMPLEMENTATION.md) |
| 2 | Arc settlement | Nick | [WORK-SPLIT.md §2](current%20plan/WORK-SPLIT.md#2-arc-and-ethereum-settlement) |
| 3 | Agent-to-agent commerce | Neil | [COMMERCE-IMPLEMENTATION.md](current%20plan/COMMERCE-IMPLEMENTATION.md). The code is on branch `neil/plan-architecture`. |

**Workstream 3 summary (Neil):**
- **Builds:** `commerce/` (TypeScript), containing:
  - `sdk`: byte codec, viem chain client, API client
  - `api`: the 11 `/v1` endpoints, with SQLite storage
  - `worker`: the solver agent, which runs `engine prove` in WSL2
  - `web`: the buyer UI
- **Follows** the engine wire format and the settlement lifecycle as written. Where they conflict with this plan, they win. The SDK is tested against the fixture vectors in ZKVM-IMPLEMENTATION §3.
- **Needs from Anish:** the plan JSON schema (for Grok), the capability-error format, the CLI JSON output shapes, and an optional `engine eval` for labelling examples.
- **Needs from Nick:** the ABI (`createJob`/`fund`/`setBudget` signatures, event names and fields), the expiry rule, the calldata cap, and an anvil deploy script.
- **Gives the team:**
  - to Anish: one real Grok draft and one unsupported-capability job;
  - to Nick: the list of chain reads, writes and status fields the client expects;
  - for the demo: an end-to-end trace with the reject, payout and refund evidence.

## Commits and pushes

- Commit each small, coherent change when it is ready. During longer tasks, commit at each useful checkpoint.
- Push after each checkpoint commit to the remote branch you are working on. Push the latest commits before a handoff or when you end a work session.
- Include only changes that belong to the checkpoint. Record pending checks in your status entry.

## Status and handoffs

- Read the relevant owners' `status.md` files before you start or resume work across chats.
- Add an entry to your own `status.md` at each checkpoint, when a blocker or decision changes, and before a handoff. Commit and push the status update with the checkpoint when possible.
- Use `YYYY-MM-DD HH:MM ±HH:MM` in every new heading. Include the date, time, and UTC offset. Keep the newest entry first and preserve earlier entries.
- Record your branch, what changed, checks and results, blockers or dependencies, and the next action. Link the relevant commit or PR when available. Name the next owner if you hand off work.
