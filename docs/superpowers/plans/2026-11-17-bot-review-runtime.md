# Live Bot Review Runtime Plan

The user requires meaningful Bot validation in the application. Continue inline with the executing-plans and TDD workflows. No Grok CLI calls or paid dispatch are authorized by this plan.

App flow: authenticate owner → load exact revision → native validation/examples → persist review → authenticated Bot webhook → restricted MCP callback → explicit buyer approval → compiler.

## Durable records

- [x] Add migration 019 and store tests before implementation.
- [x] Store one owner-bound immutable input per job revision. Reject changed input and cross-owner reads.
- [x] Persist a dispatch claim and hashed callback ticket before network access. Never retry an uncertain dispatch automatically.
- [x] Preserve the first valid terminal result. Permit exact replay and reject conflicting results. Expiry blocks pending callbacks, but retains terminal receipts.
- [x] Test reopen, independent database connections, interrupted dispatch, stale revisions and callback races.

## Transport and application gate

- [ ] Create owner-authenticated review and polling routes. Derive the plan and bindings from stored records. Evaluate bounded examples with the native engine.
- [ ] Add the one-tool authenticated MCP endpoint. Validate Origin, JSON-RPC, body bounds, service credential and per-review ticket.
- [ ] Add at-most-once webhook dispatch with a bounded timeout, no redirects and no retry. A trigger acknowledgement never passes a review.
- [ ] Require the exact passed receipt at approval when enabled. Persist its identity with approval and recheck after asynchronous validation.
- [ ] Keep the integration disabled by default. Require explicit operator configuration before live dispatch. Cost remains unknown until genuine measurement.
- [ ] Add SDK methods and isolated callback ingress. Preserve normal public readiness checks.

## Acceptance

- [ ] Run focused tests, API/SDK typechecks and the affected complete suites.
- [ ] Review the changes, update status and checkpoint each ready part.
- [ ] Configure a genuine Bot routine/custom MCP connector only after account access and spending scope permit it.
- [ ] Measure total API plus Bot usage and preserve the genuine conversation export. No simulated test establishes Bot success or cost.
