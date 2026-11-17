# Grok Bot constraint authoring

Status: proposed workflow. No genuine Bot run or paid generation is recorded.

The user requires Grok Bot to perform meaningful work for the bounty. The cost target is about $0.05–$0.10 for constraint refinement. No increased spending limit or mass-test budget is implied.

## Proposed product flow

1. The buyer gives Grok Bot a brief, declared output files and small reference examples.
2. The Bot asks one grouped set of clarification questions when needed. It identifies missing policy instead of inventing it.
3. The Bot produces the supported typed plan, requirement coverage, assumptions and one passing/failing example pair.
4. The buyer's client imports the proposal through the existing typed-import path. The engine checks its schema, supported capabilities and examples.
5. The buyer reviews the normalized constraints and approves them explicitly. The native compiler generates the checker.
6. A concise validation error can support at most one bounded Bot correction. Further work requires a revised request. The compiler does not call a model.

This gives the Bot responsibility for interpreting the request and expressing its acceptance policy. Do not send the resulting plan to the hosted Grok API for a second authoring pass. Keep imported provenance as `import`; a Bot conversation is not genuine hosted API qualification evidence.

Keep wallets, deployment credentials and funding approval outside the Bot. Its output is a proposal. It cannot supply the buyer's approval or authorize payment.

## Cost controls and evidence

Keep the brief and relevant capability context compact. Preserve every requirement. Avoid repository exploration, web research and open-ended agent loops for this task. Reuse an exact approved plan when the buyer requests the same policy. Use code for normalization, validation, example evaluation and compilation.

Grok Bot chooses its model and uses plan-dependent usage metering. Its spending cap can allow an active run to exceed the limit. A fixed prompt or small turn count therefore cannot establish a fixed Bot price. The earlier API tariff examples do not price Bot runs. Avoid duplicate API inference, and record Bot usage separately rather than presenting it as free. See the [official Bot FAQ](https://docs.x.ai/grok-bot/faq).

Before promising a five-to-ten-cent unit cost, measure a small separately approved sample through the actual Bot account. Record failed attempts and corrections too. A measured average is not a maximum. The $20 campaign remains unapproved.

## Bounty record

The [organizer guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit?usp=sharing), linked by [Devpost](https://ubc-hackathon-2026.devpost.com/), requires core Bot use, a genuine chat export, a three-to-four-sentence README and a working main-track submission. Preserve the real export and the exact proposed-plan hash, then link them to the imported revision, engine results and buyer approval. Judges decide eligibility.

Prepare the instructions and synthetic task packet first. Do not fabricate a chat export or substitute CLI/API logs. The current server's public ingress remains unready, so this workflow still needs a public end-to-end run after its authoring mode and access are implemented and reviewed.
