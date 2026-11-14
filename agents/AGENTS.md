# Shared collaboration context

Before starting work, read the [shared planning rules](current%20plan/AGENTS.md) and the [current plan](current%20plan/PLAN.md). Record your own progress in your `status.md`. Record decisions and changes that affect the team in the shared plan.

Plan documents in `current plan/`:
- [WORK-SPLIT.md](current%20plan/WORK-SPLIT.md) splits the work into three workstreams with owners.
- [ZKVM-IMPLEMENTATION.md](current%20plan/ZKVM-IMPLEMENTATION.md) covers the engine and is the source of truth for the wire format.
- [COMMERCE-IMPLEMENTATION.md](current%20plan/COMMERCE-IMPLEMENTATION.md) covers agent-to-agent commerce.
- [ARCHITECTURE.md](current%20plan/ARCHITECTURE.md) and [MARKETPLACES.md](current%20plan/MARKETPLACES.md) hold research notes. The banner at the top of each says which parts are superseded.

## Commits and pushes

- Commit each small, coherent change when it is ready. During longer tasks, commit at each useful checkpoint.
- Push after each checkpoint commit to the remote branch you are working on. Push the latest commits before a handoff or when you end a work session.
- Include only changes that belong to the checkpoint. Record pending checks in your status entry.

## Status and handoffs

- Read the relevant owners' `status.md` files before you start or resume work across chats.
- Add an entry to your own `status.md` at each checkpoint, when a blocker or decision changes, and before a handoff. Commit and push the status update with the checkpoint when possible.
- Use `YYYY-MM-DD HH:MM ±HH:MM` in every new heading. Include the date, time, and UTC offset. Keep the newest entry first and preserve earlier entries.
- Record your branch, what changed, checks and results, blockers or dependencies, and the next action. Link the relevant commit or PR when available. Name the next owner if you hand off work.
