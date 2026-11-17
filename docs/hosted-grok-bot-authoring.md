# Live Grok Bot constraint validation

Status: native callback-only deployment and public HTTPS bootstrap pass on `fb45033`. The Bot connector reports Connected. Genuine routine execution and cost measurement remain pending.

## Current requirement

The user explicitly rejected development-only Bot use. Grok Bot must participate in the live constraint-validation workflow. Keep the app's API boundary. The backend can invoke a dedicated Bot routine through an authenticated webhook. The proposed return channel is a small custom MCP tool on our backend. Official Bot docs support both mechanisms. The owner routes, durable store, restricted MCP tool and approval gate exist. The restricted callback runs in production. The connector reports Connected. The dispatch spending policy and one genuine end-to-end run remain pending.

Production flow: app → DigitalOcean API → deterministic plan/example checks → Grok Bot semantic review → explicit buyer approval → native compiler. Existing direct Grok API authoring can supply the candidate plan. Its calls and any repair count toward the same total refinement cost target. Typed imports can supply a candidate without another model call.

Bot checks whether the proposed predicates express the buyer's brief. It returns pass, changes, clarification or unsupported. The engine checks supported syntax and evaluates examples. Bot output does not prove intent coverage or external truth, and cannot authorize funding. Human approval remains mandatory.

## Integration boundary

- Send the original brief, exact candidate plan, reference digest, catalog identity and bounded deterministic example results. Exclude compiler code, repository history, full schemas and raw reference files from this review payload.
- Bind the review to a canonical input hash, owner, job and revision. Cache only an exact owner-bound match. A changed brief, rule, unit, output or reference binding requires a new review.
- Persist dispatch intent before the outbound webhook. A client replay must select the existing review. An uncertain delivery must not create another Bot run automatically.
- Treat HTTP 200 from the trigger as acceptance only. The adapter accepts only that documented status. Wait for an authenticated, hash-bound structured result through the dedicated MCP tool. Its credential cannot approve, fund, sign or modify a revision.
- Validate result shape, source quotes, rule indexes and decision consistency. A pass cannot carry questions, findings or unmapped rules. Failed or missing reviews block the app's approval path when the integration is enabled.
- Keep paid dispatch disabled until account access, cost controls and acceptance pass. Do not weaken the existing public readiness gate for a synthetic result.

## Cost target

Target about $0.05–$0.10 for the entire refinement, including direct API drafting and corrections. Bot validation must be one narrow pass on an already valid candidate. Do not invoke Bot for malformed inputs, repeated downloads, compilation, proving or replay. Avoid browsing, delegation and repository exploration. Permit no open-ended repair loop.

Payload/output limits bound our protocol. They do not prove Bot token usage or impose a provider-enforced dollar ceiling. Bot chooses its model and has plan-dependent usage. A running Bot task can exceed a spend cap. Measure a small separately approved real sample before claiming a unit price. Keep API charges and Bot usage separate in that measurement. The proposed $20 mass-test budget remains unapproved.

The user installed Grok Bot and reports exhausted usage. The app passes Apple signature/notarization checks and opens. No task was sent, no credits were purchased and no API key was placed in Bot chat. The API key does not replace Bot's own allowance. The restricted MCP connector is connected. A genuine run still needs available Bot usage, the approved account cap and the actual routine webhook.

## Bounty evidence

Preserve the real Bot conversation, review input/result hashes, application review receipt, native checks and buyer approval. A development prompt or CLI/API log cannot stand in for runtime Bot evidence. The organizer guide requires core Bot use, a genuine chat export, a short role README and a working main-track submission. Judges decide eligibility.

Sources: [Bot webhooks](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks), [Bot custom MCP connectors](https://docs.x.ai/grok-bot/computer-and-apps), [Bot billing](https://docs.x.ai/grok-bot/faq), [official bounty guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit?usp=sharing).

## Implemented API contract

- `POST /v1/jobs/:id/bot-reviews` accepts `revisionHash`, optional `request`, and complete `examples`. It requires the owner's wallet API key and an idempotency key. Imports supply a brief. Grok revisions use the stored original brief plus stored buyer clarification answers. A caller cannot replace that text.
- Native validation and agreeing positive/negative examples precede durable acceptance. The canonical review binds the stored plan, revision, references, catalog and example verdicts. One revision retains one exact input.
- Acceptance atomically stores both the review and its initial HTTP 202 response before dispatch. The response can say `queued` after a fast result arrives. Poll `GET /v1/jobs/:id/bot-reviews/:reviewId` for current state.
- A trigger claim persists before network access. The sender makes one authenticated HTTPS POST, refuses redirects and waits at most ten seconds. A lost or rejected response becomes uncertain. It never automatically starts another Bot run. This timeout cannot cancel provider work already accepted.
- The restricted endpoint is `/integrations/grok-bot/mcp`. Its dedicated service credential permits one tool, `submit_constraint_review`. A per-review ticket also binds that tool call to one immutable input. The service credential cannot call buyer routes.
- A passed receipt does not approve a job. The buyer echoes `botReviewId` during approval. Approval stores the review/input/result hashes. Compilation and new funding preparations require that receipt when enabled. Cached successes cannot bypass the gate.
- Existing funded transactions may still reconcile through receipt/link routes. Those routes verify chain state and emit linkage summaries. Activation must not strand funds that already moved. They do not issue new funding transactions.
- The queue recovers accepted work, preserves uncertain deliveries and respects the emergency spending stop. Compiler work does not suppress later Bot queue ticks. Shutdown stops new dispatch and preserves active uncertainty.

The SDK provides `requestBotReview`, `botReview` and `waitForBotReview`. Polling ends at completed, expired or uncertain. It never resends a trigger or approves a job.

The proxy configuration gives only the exact MCP endpoint a separate `/healthz` upstream pool. Other API routes retain `/readyz`. The actual pinned proxy passed a controlled test with public-route 503, callback 401 without its credential, callback 200 with a synthetic credential and 503 for a longer callback-path prefix. This is local HTTP routing evidence, not public deployment or genuine Bot evidence.

## Pending account setup

Use the prepared [routine instructions](grok-bot/routine-instructions.md) when account usage and spending scope permit setup. Routine creation itself can consume Bot usage. The user approved setup plus one measured review under a $1 account cap, with possible in-flight overrun. Confirm the account cap before sending setup instructions. This pilot does not authorize buying credits, mass testing or a higher production authoring ceiling. A genuine acceptance run also needs the callback service configured in Bot as a Remote HTTPS connector and a private webhook URL/key saved outside Git.

The callback ticket is a short-lived capability. Treat the webhook payload and original conversation export as private. Keep the original evidence private and redact credentials from any shared copy. Do not replace real Bot output with the prepared sample or a controlled transport result.

## Production callback bootstrap

The environment profile defaults to `BOT_REVIEW_REQUIRED=0`. Set it to `1` only with a dedicated `BOT_REVIEW_SERVICE_TOKEN`. The authenticated MCP endpoint and mandatory receipt checks then activate. The profile supplies no dispatcher and explicitly rejects live webhook environment settings. Public readiness stays false with a nonfatal `bot_review: dispatch_disabled` check. This permits a connector handshake without starting inference.

Native source `fb45033`, image `sha256:0141ba0c4ed599bdead1852d9bc1a2bb0fe7d343fd378c27c4a203bb975188f8`, now runs this profile. Ten actual HTTPS checks pass, including service authentication, the single result tool, per-review ticket enforcement and rejection of longer path prefixes. This handshake used an operator protocol client. It does not establish genuine Bot execution. See the [native candidate report](../agents/anish/reports/hosted-bot-native-candidate-2026-11-17.json). Do not put a credential in source, a command argument, a query string or ordinary Bot chat. Store the Remote HTTPS connector header through its protected account setup after access approval.

## Current account state

The user approved the dedicated result-only connector and a $1 account cap for setup plus one measured review. The user accepts a possible in-flight overrun. The production complete-run ceiling remains $0.10. No credit purchase or mass test is authorized.

The user completed the approved connector as `UBC26 Result Callback`. The installed-plugin UI reports Connected. The account cap and available usage remain pending confirmation. Foreground automation stopped after the user's two-minute window. No Bot task or paid generation ran. The API key remains outside the host and Bot chat.

The native review preflight uses the real engine and a 1,185-byte canonical input. Owner isolation, replay and approval/compilation blocking pass. Production restart and a separate offline restore preserve the queued review, active keys and twenty prior artifact hashes. The restored test container is stopped. Public buyer routes remain HTTP 503.

## Account boundary before public dispatch

Bot apps and cloud-computer state are shared across one account. A second Bot does not isolate that account's files, sessions or app access. The current account also shows GitHub and Origin connected. Public customer payloads must wait for a deployment account that exposes only the intended review tools and contains no unrelated private sessions. Our restricted callback credential limits backend actions. It does not isolate other tools on the Bot account. See the [official account-sharing rules](https://docs.x.ai/grok-bot/computer-and-apps#one-computer-shared-by-all-your-bots).

The approved synthetic pilot can measure one review under the $1 account cap. It does not qualify public account isolation. Keep general dispatch disabled while that production boundary remains unresolved.
