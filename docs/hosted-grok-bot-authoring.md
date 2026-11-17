# Live Grok Bot constraint validation

Status: runtime integration design. No genuine Bot review or measured Bot cost exists yet.

## Current requirement

The user explicitly rejected development-only Bot use. Grok Bot must participate in the live constraint-validation workflow. Keep the app's API boundary. The backend can invoke a dedicated Bot routine through an authenticated webhook. The proposed return channel is a small custom MCP tool on our backend. Official Bot docs support both mechanisms. This path still needs a real account-level check and one genuine end-to-end run.

Production flow: app → DigitalOcean API → deterministic plan/example checks → Grok Bot semantic review → explicit buyer approval → native compiler. Existing direct Grok API authoring can supply the candidate plan. Its calls and any repair count toward the same total refinement cost target. Typed imports can supply a candidate without another model call.

Bot checks whether the proposed predicates express the buyer's brief. It returns pass, changes, clarification or unsupported. The engine checks supported syntax and evaluates examples. Bot output does not prove intent coverage or external truth, and cannot authorize funding. Human approval remains mandatory.

## Integration boundary

- Send the original brief, exact candidate plan, reference digest, catalog identity and bounded deterministic example results. Exclude compiler code, repository history, full schemas and raw reference files from this review payload.
- Bind the review to a canonical input hash, owner, job and revision. Cache only an exact owner-bound match. A changed brief, rule, unit, output or reference binding requires a new review.
- Persist dispatch intent before the outbound webhook. A client replay must select the existing review. An uncertain delivery must not create another Bot run automatically.
- Treat HTTP 200 from the trigger as acceptance only. Wait for an authenticated, hash-bound structured result through the dedicated MCP tool. Its credential cannot approve, fund, sign or modify a revision.
- Validate result shape, source quotes, rule indexes and decision consistency. A pass cannot carry questions, findings or unmapped rules. Failed or missing reviews block the app's approval path when the integration is enabled.
- Keep the feature disabled until real callback authentication, account access, cost controls and acceptance pass. Do not weaken the existing public readiness gate for a synthetic result.

## Cost target

Target about $0.05–$0.10 for the entire refinement, including direct API drafting and corrections. Bot validation must be one narrow pass on an already valid candidate. Do not invoke Bot for malformed inputs, repeated downloads, compilation, proving or replay. Avoid browsing, delegation and repository exploration. Permit no open-ended repair loop.

Payload/output limits bound our protocol. They do not prove Bot token usage or impose a provider-enforced dollar ceiling. Bot chooses its model and has plan-dependent usage. A running Bot task can exceed a spend cap. Measure a small separately approved real sample before claiming a unit price. Keep API charges and Bot usage separate in that measurement. The proposed $20 mass-test budget remains unapproved.

The user installed Grok Bot and reports exhausted usage. The app passes Apple signature/notarization checks and opens. No task was sent, no credits were purchased and no API key was placed in Bot chat. The API key does not replace Bot's own allowance. A genuine run needs restored Bot access or usage, plus the actual webhook and restricted MCP connection.

## Bounty evidence

Preserve the real Bot conversation, review input/result hashes, application review receipt, native checks and buyer approval. A development prompt or CLI/API log cannot stand in for runtime Bot evidence. The organizer guide requires core Bot use, a genuine chat export, a short role README and a working main-track submission. Judges decide eligibility.

Sources: [Bot webhooks](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks), [Bot custom MCP connectors](https://docs.x.ai/grok-bot/computer-and-apps), [Bot billing](https://docs.x.ai/grok-bot/faq), [official bounty guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit?usp=sharing).
