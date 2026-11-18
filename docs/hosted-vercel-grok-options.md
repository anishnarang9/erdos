# Vercel deployment and Grok refinement cost

Reviewed 2026-11-17. The user selected Vercel and requested roughly $0.10 per user for constraint refinement. No deployment or paid request ran for this research. Code candidate remains `20b0dc2`.

## Current account and hosting recommendation

Current decision, 2026-11-17: The user chose DigitalOcean after reconsidering the compiler deployment risk. Follow the [DigitalOcean setup](hosted-digitalocean.md). Keep the Vercel investigation below as history. No Sandbox was created. Vercel login remains available for the later frontend.

Latest correction: Vercel is a viable target after adapting this backend. The user asked why it could not stay there. The initial recommendation did not inspect Sandbox's Docker support. The [official Docker announcement](https://vercel.com/changelog/run-docker-containers-inside-vercel-sandbox) explicitly supports installing Docker and running its daemon inside a Sandbox. Its August update uses Ubuntu-based managed images. Do not treat a second provider as a prerequisite.

Prioritize a compatibility check for the user's Vercel preference. The proposed mapping is:

| Current implementation | Vercel-oriented replacement |
| --- | --- |
| HTTP API process | Vercel HTTP service or Functions |
| Local synchronous SQLite/WAL database | Managed relational database through Marketplace, such as Neon Postgres |
| Local committed package files | Vercel Blob with immutable identities and controlled access |
| Process-local task pump and compiler ownership | Durable queue/workflow with database-backed claims and spend reservations |
| Host Docker socket and BuildKit cache | Bounded Vercel Sandbox running Docker, with reviewed snapshot/cache handling |

[Marketplace storage](https://vercel.com/docs/storage) supports relational databases and Vercel-managed credentials. Sandbox Docker support establishes platform capability. It does not prove this RISC Zero toolchain's nested BuildKit settings, resource limits, native executable, image pulls, prewarm, cancellation or artifact round trip. Check those before the database migration. Preserve one compiler allocation and exact toolchain/image pins. Keep signers and model credentials outside the compiler sandbox.

A Sandbox is not the primary database. Its [duration and persistence guide](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence) describes session limits, snapshots and Drives. Keep durable ownership, idempotency, payments and spending state in the database. Keep accepted package bytes in durable object storage. A task restart must resume or reconcile instead of creating duplicate compiler work or model charges.

This is a change from the current single-host deployment design. It requires implementation and new restart, concurrency, budget and recovery tests. No compatibility run or migration occurred. First confirm account quotas and a bounded test budget, then test the exact compiler in Sandbox. Keep the DigitalOcean quote below as an optional route that avoids migration. The user did not approve that paid server.

Update 2026-11-17: The user completed Vercel login and asked for the best hosting provider. Read-only `vercel whoami` succeeds as `anishnarang9`. The selected team is `anishnarang9s-projects`. No UBC-26 project appears in its current project list. The team domain list is empty. Existing unrelated projects remain untouched.

The earlier minimal-migration recommendation was a DigitalOcean Basic Droplet for the API, SQLite state, packages and Docker compiler. The [current regular-CPU price](https://www.digitalocean.com/pricing/droplets) is $48/month for four shared vCPUs, 8 GiB RAM, 160 GiB SSD and 5,000 GiB transfer. Compute accrues at $0.07143/hour equivalent, about $1.71 for 24 hours, up to the plan's monthly cap. These are provider list prices, not measured compiler performance.

[Weekly system backups](https://docs.digitalocean.com/products/backups/details/pricing/) cost 20% of compute, giving $9.60 for a full $48 month. Combined base compute and weekly backup cost is $57.60/month before tax, model use, domain charges or usage beyond the included allowances. The service's quiesced SQLite/package backup and restore procedure remains required. Provider image backups alone do not replace that procedure.

The VPS option keeps the verified persistent-host architecture. It avoids the managed-database migration and unverified Docker execution boundary on Vercel. Keep Vercel available for Neil's later frontend. The current backend can serve HTTPS directly through its prepared Caddy ingress. No proxy or UI work is required to release the API.

The user has not selected or funded DigitalOcean. Neither `doctl` nor `hcloud` is installed. No paid server, backup plan, Vercel project or deployment was created. Requested approval of the concrete compute/backup budget or selection of a cheaper provider/Vercel migration. Once approved, establish the chosen provider's authenticated access before provisioning.

Interpret the cost target as model spending for one complete refinement session, including clarification, repair and failed attempts. This is a proposed budget policy. Hosting, compilation, proving and chain fees need separate accounting. A session limit alone does not impose a daily or lifetime limit per person.

## Grok Bot bounty

The [official Devpost page](https://ubc-hackathon-2026.devpost.com/) links the [organizer guide](https://docs.google.com/document/d/1QaySCo7u3VxMVNdk3C5Ab3ewc2E46AuLntti-Uzx5EY/edit). Its Grok Bot section requires:

- Grok Bot as a core part of the project.
- A Bot chat export showing its use or contribution to building the project.
- A README of three to four sentences explaining its role.
- A working implementation that also meets a main track's requirements.

The guide emphasizes useful workflows and agent work. Each winner receives a keyboard and swag. This is an inference from the requirements: ordinary xAI API calls or Grok Build CLI logs alone do not establish Bot use. Judges decide eligibility. The current checkout has no `docs/grok-bot/` evidence directory.

Proposed core role: Grok Bot refines a buyer's task into supported typed constraints, asks about ambiguity, and supplies complete examples. Our deterministic engine validates the plan and examples. The buyer reviews rules, units, coverage and assumptions before funding. Keep the Bot outside the signing boundary.

The [Bot overview](https://docs.x.ai/grok-bot/overview) documents custom API/MCP tools. The [X integration](https://docs.x.ai/grok-bot/tag-on-x) forwards an account owner's tagged post to their Bot. Results appear in the Bot conversation. A genuine account-linked run and its export would provide stronger evidence than a decorative mention. Only synthetic public task data belongs in a public post. This research did not send a post or message.

Bot billing differs from API billing. The [Bot FAQ](https://docs.x.ai/grok-bot/faq) describes shared subscription usage pools, additional usage, and automatic model choice. Its spending cap can allow a running task to exceed the limit. These terms do not establish a strict ten-cent embedded API. [Inference hooks](https://docs.x.ai/grok-bot/inference-hooks) are Enterprise policy checks, not a public API for dispatching arbitrary Bot jobs.

Use a bounded xAI API adapter for automatic in-app refinement. Use actual Bot work and exports for the bounty. An optional buyer-owned Bot flow can generate a plan for the existing typed import path. It avoids a second server-side model call, but still consumes the buyer's Bot allowance. Import provenance must remain `import`. It is not genuine API qualification evidence. Bot-to-service tooling and the complete import/approval workflow still need verification.

## Cost target

The [published API prices](https://docs.x.ai/developers/pricing) for exact model `grok-4.20-0309-non-reasoning` are $1.25 per million input tokens and $2.50 per million output tokens below 200,000 input tokens. Cached input costs $0.20 per million. At the long-context threshold, all tokens use the higher tariff.

These calculations assume global standard requests, uncached input, no tools, and the reviewed non-reasoning output contract:

| Full billable input per call | Output per call | One call | Two calls total |
| --- | --- | --- | --- |
| 8,000 tokens | 2,000 tokens | $0.015 | $0.030 |
| 12,000 tokens | 4,000 tokens | $0.025 | $0.050 |
| 16,000 tokens | 8,192 tokens | $0.04048 | $0.08096 |

These are conditional tariff calculations, not measured cost or reliability. Input must include the schema, catalog, instructions, reference bytes, response schema, clarifications and provider framing. Every follow-up has its own full input charge. The two-call allowance must cover clarification or repair within the same session.

Recommended initial design:

1. Target the middle profile. Permit the larger profile only after checking complete input bounds and output sufficiency.
2. Keep the exact reviewed model. Disable paid search, agent loops, automatic model upgrades and expensive fallback.
3. Keep plans, examples, source quotes and coverage. Reject oversized work before inference. Never discard requirements to meet a token limit.
4. Keep the stable schema/catalog prefix identical to improve caching. Treat cache savings as a bonus, not a condition for admission.
5. Use deterministic schema checks and engine evaluation before one bounded repair. Send concise error details. Do not ask a model to check what the engine can check.
6. Reserve each possible call atomically against the complete session budget before dispatch. Reuse the session across clarification and repair. Keep uncertain charges reserved. Apply owner/day and global caps too.
7. Stop automatic calls when the remaining budget cannot cover the next call. A retry, task replacement, new API key or clarification must not reset spending.
8. Measure the existing 180 genuine trials after access and aggregate budgets are approved. Count unsuccessful calls and repairs in cost and quality results.

The initial [offline payload profile](../agents/anish/reports/hosted-prompt-profile-2026-11-17.json) covers all 60 synthetic corpus inputs. Serialized provider bodies range from 14,211 to 17,701 UTF-8 bytes. Median size is 14,625.5 bytes. This uses the production payload serializer with the checked-in schema/catalog. It excludes repair payloads. It is neither provider tokenization nor a proof of the proposed input limits.

The [billing FAQ](https://docs.x.ai/developers/faq/billing) says inference adds predefined tokens beyond plain-text tokenization. A tokenizer count alone therefore does not prove the full request bound. Establish a reviewed bound or provider-enforced input limit before promising a strict cap.

The current [spending contract](hosted-model-costs.md) reserves the full one-million-token provider context at the highest tariff. Its $2.54096 per-call reservation is conservative admission capacity, not an expected bill. Setting the current request ceiling to $0.10 would reject live dispatch. Do not reduce the reservation from these examples alone. Budget implementation and the qualification guard must change together after review.

First optimize the existing plan format. Introduce a smaller intermediate format only if measurements show a need. Such a format must preserve every requirement and pass the same semantic qualification.

## Vercel fit

Vercel now offers a [Container Runtime](https://vercel.com/docs/functions/runtimes/container) and [Daemons](https://vercel.com/docs/daemons). A blanket claim that Vercel cannot run backend containers is stale. However, [daemon limits](https://vercel.com/docs/daemons/limits) exclude persistent local storage and inbound HTTP. Daemons need a separate HTTP service and durable external storage.

The current backend stores SQLite state and packages locally. It also uses a host Docker socket and a dedicated BuildKit compiler with persistent cache. Building a Dockerfile on Vercel does not establish access to that production host socket. Compatibility with this compiler remains unverified. Sandbox explicitly supports a Docker daemon, as described in the latest correction above.

| Option | Work required | Assessment |
| --- | --- | --- |
| Vercel public app plus persistent Linux API/compiler | Deploy the verified backend, configure public origins and test ingress | Least migration for the existing candidate. Keeps state and compiler recovery. Requires a second hosting provider. |
| Vercel HTTP service plus managed database/artifacts and Sandbox compiler | Replace synchronous SQLite transactions, package storage and process-local task coordination. Verify exact compiler behavior inside Sandbox. | Larger migration. Requires fresh runtime, restart, ownership and spending qualification. Can potentially keep compute and orchestration on Vercel. |

The user's Vercel preference is confirmed. Neither topology is a completed deployment. Confirm whether a supporting host is acceptable before starting a storage migration or provisioning infrastructure. Do not deploy local SQLite on disposable container storage.

Initial read-only access discovery found Vercel CLI 49.1.0 without credentials. The later authenticated result appears above. No Vercel project was created. Hosting provider choice and budget remain pending. Use the account's assigned hostname first if no custom domain is needed. Credentials belong in a secure local or provider configuration, not repository files or chat.

Next: inspect Vercel account quotas and prepare a bounded exact-compiler Sandbox check. If that passes, implement the managed-state/task migration and reviewed bounded-input/session-budget design. Public deployment, genuine model trials and final independent review remain open.
