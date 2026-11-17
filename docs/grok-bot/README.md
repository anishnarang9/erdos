# Live Grok Bot validation evidence

Status: native callback bootstrap and review preflight pass. No genuine Bot review or chat export exists here. The user requires Bot in the live validation path. Development-only use does not meet that requirement.

## Prepared semantic-review case

[review-packet.json](review-packet.json) is one coordinator-prepared synthetic review input. It contains the buyer's original brief, exact candidate rules, revision/reference/catalog bindings and two deterministic example results. Its canonical input is 1,185 bytes. It excludes the repository, full engine schema and raw reference files. Size is not a price guarantee.

The candidate intentionally permits USD100 where the brief permits USD75. Native engine validation and both supplied examples pass. A separate held-out case exposes that semantic difference. The Bot's intended job is to identify the mismatch between intent and rules. See [native preflight](../../agents/anish/reports/hosted-bot-review-preflight-2026-11-17.json). Do not send this README or the expected-outcome report as Bot input.

The [runtime design](../hosted-grok-bot-authoring.md) invokes a dedicated Bot routine through an authenticated webhook. A restricted MCP tool accepts its result at our API. HTTP 200 from the trigger is not completed validation. The input/result contract, durable queue, callback authentication and approval gate pass controlled tests. The callback-only profile now runs on native source `fb45033`. Public HTTPS authentication and tool checks pass. The Bot connector reports Connected. The routine and genuine run remain unfinished.

No task was sent to Bot, no credits were purchased and no API key was placed in Bot chat. The user installed Bot and reports exhausted usage. The approved connector reports Connected. A genuine review/export and measured total cost remain pending. The direct xAI API key does not replace Bot's own usage allowance.

## Planned bounty README text

Our app will invoke Grok Bot to compare a buyer's brief with proposed checker constraints. The Bot will return semantic gaps or clarification questions through a restricted backend tool. Our deterministic engine will validate the rules and examples, while the buyer retains approval and funding authority. A hash-bound Bot review and genuine conversation export will document the live validation step.

Use present tense only after the complete workflow runs. The [official guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit?usp=sharing) requires core Bot use, a genuine chat export and a three-to-four-sentence role README. Judges decide eligibility.

## Input pins

- Semantic input hash: `0xd1457873eb4b4f4be4612c8f8a1358333ba175a82dc826bf311973a312679cb7`.
- Packet file SHA-256: `1bb3320de59185ef3320b46549b79ff344bc30b17b7e1d5001dcbcc7e2d5e619`.

These pins identify an input. They do not establish Bot execution, semantic success, measured cost or funding approval.

## Native API input

[native-review-input-fb45033.json](native-review-input-fb45033.json) preserves the actual synthetic input captured from the native API. Its semantic hash is `0xfbfef90132f5a8cbfb69ea3f0da0a6e4696ef245eb09cffaa607872aa8b09047`. It remains 1,185 canonical UTF-8 bytes.

The prepared packet above hashes the raw catalog file bytes. The native API hashes canonical catalog JSON. Catalog contents agree, but these digests and input hashes differ. Preserve both labels. See the [native preflight](../../agents/anish/reports/hosted-bot-native-preflight-2026-11-17.json) and [public callback checks](../../agents/anish/reports/hosted-bot-public-callback-2026-11-17.json). Neither input establishes a genuine Bot review.

The user approved connector setup and one measured review under a $1 account cap, accepting possible in-flight overrun. The connection reports Connected. The account cap remains unconfigured. No credit purchase is authorized. Keep the production $0.10 complete-run ceiling.
