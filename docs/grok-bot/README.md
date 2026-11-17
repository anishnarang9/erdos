# Live Grok Bot validation evidence

Status: implementation/preflight only. No genuine Bot review or chat export exists here. The user requires Bot in the live validation path. Development-only use does not meet that requirement.

## Prepared semantic-review case

[review-packet.json](review-packet.json) is one coordinator-prepared synthetic review input. It contains the buyer's original brief, exact candidate rules, revision/reference/catalog bindings and two deterministic example results. Its canonical input is 1,185 bytes. It excludes the repository, full engine schema and raw reference files. Size is not a price guarantee.

The candidate intentionally permits USD100 where the brief permits USD75. Native engine validation and both supplied examples pass. A separate held-out case exposes that semantic difference. The Bot's intended job is to identify the mismatch between intent and rules. See [native preflight](../../agents/anish/reports/hosted-bot-review-preflight-2026-11-17.json). Do not send this README or the expected-outcome report as Bot input.

The [runtime design](../hosted-grok-bot-authoring.md) invokes a dedicated Bot routine through an authenticated webhook. A restricted MCP tool will return its result to our API. HTTP 200 from the trigger is not completed validation. The input/result contract exists; durable dispatch, callback authentication and approval gating remain unfinished.

No task was sent to Bot, no credits were purchased and no API key was placed in Bot chat. The user installed Bot and reports exhausted usage. Real account connectivity, a genuine review/export and measured total cost remain pending. The direct xAI API key does not replace Bot's own usage allowance.

## Planned bounty README text

Our app will invoke Grok Bot to compare a buyer's brief with proposed checker constraints. The Bot will return semantic gaps or clarification questions through a restricted backend tool. Our deterministic engine will validate the rules and examples, while the buyer retains approval and funding authority. A hash-bound Bot review and genuine conversation export will document the live validation step.

Use present tense only after the complete workflow runs. The [official guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit?usp=sharing) requires core Bot use, a genuine chat export and a three-to-four-sentence role README. Judges decide eligibility.

## Input pins

- Semantic input hash: `0xd1457873eb4b4f4be4612c8f8a1358333ba175a82dc826bf311973a312679cb7`.
- Packet file SHA-256: `1bb3320de59185ef3320b46549b79ff344bc30b17b7e1d5001dcbcc7e2d5e619`.

These pins identify an input. They do not establish Bot execution, semantic success, measured cost or funding approval.
