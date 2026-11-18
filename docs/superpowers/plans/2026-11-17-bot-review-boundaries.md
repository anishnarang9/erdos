# Grok Bot Review Boundary Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. The user prohibits further Grok CLI calls. Do not create an implementation worker swarm.

**Goal:** Build the bounded, hash-bound input/result contract for live Bot constraint validation without enabling paid dispatch.

**Architecture:** A pure API module prepares a canonical semantic-review snapshot and validates an eventual result against that snapshot. Durable dispatch, restricted MCP callbacks and approval gating follow as separate integration work. Keep the existing API behavior and paid-provider guard unchanged during this foundation checkpoint.

**Tech Stack:** TypeScript, existing Zod/canonicalize dependencies, Node crypto, Vitest.

## Scope and files

Create `commerce/api/src/bot-review-contract.ts` and `commerce/api/test/unit/bot-review-contract.test.ts`. Do not add a model call, network route, Bot credential, migration, fake charge or public readiness exception in this checkpoint.

### Task 1: Canonical review input

- [x] Write and run the failing unit tests before creating the module.
- [x] Export `BOT_REVIEW_MAX_INPUT_BYTES = 16384` and `BOT_REVIEW_MAX_RESULT_BYTES = 8192`.
- [x] Implement `prepareBotReview(input: unknown)`.

The strict input has version 1, the original nonblank request (at most 4096 characters), 32-byte revision/reference/catalog hex digests, a version-1 plan with 1–64 rules and bounded example results. Example results contain a name and numeric verdict. Require at least one verdict 1 and one verdict 0. Native engine validation must happen before this function; this contract does not replace it.

Normalize only hex digest case. Preserve the request and all plan content. Reject unsafe canonical data with the existing `checkHashable`. Serialize with JCS and reject input beyond 16384 UTF-8 bytes. Return immutable primitive fields: `inputJson`, `inputHash`, `request` and `ruleCount`.

Hash exactly:

```ts
createHash('sha256')
  .update('UBC26/bot-review-input/v1')
  .update(inputJson)
  .digest('hex');
```

Expose the hash with a `0x` prefix. Use fixed public errors without input text. Invalid input uses `validation_failed`; oversized input uses `payload_too_large`.

- [x] Check stable hashes across object-key order and changed hashes for brief, rules, references, catalog and examples.
- [x] Check that later caller mutation cannot change the prepared snapshot.
- [x] Check strict fields, malformed plans, missing pass/fail evidence, cycles and UTF-8 byte limits.

### Task 2: Bound the eventual result

- [x] Implement `validateBotReviewResult(snapshot, reviewId, result)` after its failing tests.
- [x] Reconstruct and hash the saved input rather than trusting mutable rule-count/request fields.

Require a strict result object with version 1, expected review ID, exact input hash, decision, covered rule indexes, findings and questions. Decisions are `pass`, `needs_changes`, `clarify` and `unsupported`. A finding contains kind, verbatim source quote, rule indexes and message. Bound all text/arrays. Reject duplicate or nonexistent indexes. Verify each source quote occurs in the captured original request.

A pass needs every rule covered and no finding/question. `needs_changes` needs a finding. `clarify` needs a question. `unsupported` needs an unsupported finding. Reject callback fields that claim approval, funding or billing. A trigger acknowledgement such as `{accepted:true}` is not a review result.

- [x] Check pass, valid objections, clarification and unsupported results.
- [x] Check wrong review/hash, stale or damaged snapshot, invented quotes, duplicate indexes and inconsistent decisions.
- [x] Check fixed errors do not include raw request text.

### Task 3: Verify and checkpoint

- [x] Run from `commerce/api`: `pnpm exec vitest run test/unit/bot-review-contract.test.ts`.
- [x] Run from `commerce/api`: `pnpm typecheck`.
- [x] Run the complete API suite after the focused checks pass.
- [x] Update Anish status/shared plan with exact checks and remaining runtime work.
- [x] Commit only this contract, its tests and current task documentation. Push the checkpoint.

## Required continuation

Next implement durable owner-bound review records with immutable first terminal results and exact replay, at-most-once webhook dispatch, restricted MCP callback authentication and hash checks, explicit approval gating, callback bootstrap ingress and SDK polling. Use controlled transports for development. A real Bot routine/custom MCP connection and restored account usage remain external inputs. Only a genuine run can establish live integration or measured cost. The sprint remains incomplete after this foundation checkpoint.
