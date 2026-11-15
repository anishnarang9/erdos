# Orca handoff — UBC-26 engine integration

Continue in the existing checkout:

`/Users/anishnarang/.codex/worktrees/engine-commerce/UBC-26-engine`

Branch: `codex/engine-commerce`.
Completed evaluation checkpoint: `ad2dab18ba5fe7239607fda8359db05f0d8845e1`.
Read [today's readiness report](2026-11-15-readiness.md) before implementation.

## Completed evidence

- Core compiler, runtime, protocol, and CLI are Rust. Commerce orchestration is TypeScript and settlement is Solidity.
- Sixty challenges, 10,000 seeded cases, 341 host candidates, and sixteen accepted model structures were tested.
- Twelve fresh Groth16 receipts passed local Solidity verification. Six passing deliveries recovered exactly.
- Full replay passed. See `engine/evaluation/reports/final-replay.json`.
- Thirty-nine non-draft fidelity failures and thirteen quote defects remain recorded model limitations.
- A fresh receipt passed the deployed Arc verifier in a read-only call. That is not live settlement evidence.

## Current dependency revisions

- Engine PR #3: `adda3a3c52fd8cebe594aba42d3e43f47a7baf0e`.
- Nick PR #4: `80c8a4af68f0cf00e4177c98e9c435d869716edd`.
- Neil PR #5: `8584b045f18996667419b8c6d7f965717b099f5e`.
- Our branch includes Neil's older `3013d736` baseline. Do not assume it includes his latest production adapter.

## Next work

1. Fix the commerce CI `setAAD` type error and reject live-chain configuration with a simulated engine.
2. Wire the real Arc reader and concrete worker settlement port. Addresses and ABIs are now available.
3. Prepare one buyer-approved reconciliation lifecycle with actual funded terms and a real provider. Existing proofs use synthetic contexts.
4. Track the new advisory matches before making a production security claim. Do not blindly upgrade the pinned proof stack.

Nick's deployment is whitelisted and unfrozen. A 600-second minimum margin does not cover our roughly 745-second signed proof plus transaction overhead.
Lookup on duplicate keys aborts as invalid input, even if an earlier unique rule returned false. This is intentional current eager evaluation.

## Operating rules

- Do not deploy contracts, send live transactions, or message other chats/people without new user authorization.
- Do not edit Nick's or Neil's status files.
- Keep coherent commits and push checkpoints on our branch. Preserve source/receipt dependency pins.
- Update `agents/anish/status.md` newest first with America/New_York timestamps. Update the shared plan for team-facing changes.
- Prefer a small number of GPT-6 Sol helpers. Replay saved model outputs instead of buying new trials.
- Do not expose release keys. Private proof scratch is `/tmp/ubc26-integration-new-proofs`; it is not a public artifact directory.
- Use the Orca CLI skill for Orca state. The repository and this worktree already exist in Orca.

## Authentication

System default currently contains API-key credentials. Orca has no managed Codex account yet.
The user can add ChatGPT once with `orca account add --agent codex`, then select the saved account or `system` for new launches.
Do not replace or copy the system credential file. Never place API keys in Git, prompts, or command arguments.
Do not run a second writer against the active Codex conversation. Resume after the current turn ends, or start a fresh chat with this handoff.
