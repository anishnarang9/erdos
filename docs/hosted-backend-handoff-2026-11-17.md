# Hosted backend sprint handoff

Updated on November 17, 2026, at 16:55 -0500. The user requested a pause and a detailed handoff for a new chat. The goal is **paused** and the sprint is incomplete.

## Start here

Use the existing checkout at:

```text
/Users/anishnarang/.codex/worktrees/hosted-backend/UBC-26
```

Its branch is `codex/hosted-backend`. The last implementation commit is `2faedd2832fe80e7ede016bc246020b8c2a8bef5`. A documentation checkpoint containing this handoff follows it. Check the actual current HEAD before changing files.

The open draft is [PR #8, Add hosted backend and installable agent runner](https://github.com/anishnarang9/UBC-26/pull/8). It remains a draft and has not merged. Continue in this worktree. Preserve unrelated work in the main checkout at `/Users/anishnarang/UBC-26`.

The original plan is:

```text
/Users/anishnarang/Documents/ChatGPT/UBC26/docs/superpowers/plans/2026-11-16-hosted-backend-sprint.md
```

Read the applicable repository instructions, `agents/AGENTS.md`, the original plan and `agents/anish/status.md` before resuming. The [release ledger](../agents/anish/reports/hosted-release-readiness-2026-11-17.json) has detailed historical evidence. Its newest `revisedCostDecision` and `currentPilot` fields describe the revised cost policy. Earlier strict-ten-cent fields describe previous policy and evidence.

## Product objective and user decisions

The backend should support wallet-owned buyer jobs, Grok constraint authoring, buyer approval, deterministic native compilation, downloadable packages, local proof generation, Arc Testnet settlement and exact recovery. Grok Bot must perform a meaningful constraint-validation step inside the workflow.

The user rejected decorative Bot integration and development-only Bot use. The intended sequence is a fresh API draft, deterministic validation, Bot review of the exact brief and rules, buyer approval, compilation and proof verification.

The initial requirement was a strict 10¢ maximum for a complete authoring run. The user later explicitly selected **5–10¢ on average**, allowing individual runs above 10¢, and approved the pilot below. Do not restore the superseded strict product requirement when discussing this pilot.

The user prefers small, clearly defined review tasks through Antigravity CLI using `claude-opus-4-6-thinking`. Grok CLI workers exhausted their usage. The user instructed us to continue without further Grok CLI calls. Avoid a large group of Codex subagents. The user also prefers autonomous terminal work and dislikes repeated manual setup requests.

The 180-trial paid qualification remains deferred. The user rejected the proposed $20 campaign and daily budgets. No purchase of API or Bot credits is authorized. Fresh Arc transfers and Circle payments have their own spending requirements.

## Current live deployment

The public hostname is [ubc26-159-89-149-133.sslip.io](https://ubc26-159-89-149-133.sslip.io/healthz). The DigitalOcean Droplet is named `ubc26-hosted-backend`, at `159.89.149.133`.

| Component | Verified identity or state |
| --- | --- |
| Main API source | `9dc289dda37e74b5258592654e3bd51e85ff92e8` |
| Main API image | `sha256:4a69ca09aee0495c7214bffdd7d06fa689e92c26d5aa43159d80d2cf2d1d607a` |
| Main API container | `ubc26-hosted-api-1`, running and Docker-healthcheck healthy |
| Main API container ID at pause | `1347995c21ef8ad9faf62d04e52289c10611ae6464dcf5aa6666a9c320fd1319` |
| HTTPS container | `ubc26-hosted-https-1`, running |
| Current ingress source | `6b4eec1118eb176ef49834f88baef77bf3faf5cd` |
| Current ingress directory | `/opt/ubc26-release/ingress-6b4eec1` |
| Previous ingress directory | `/opt/ubc26-release/ingress-0b98c3b` |
| Main Compose project | `ubc26-hosted` |
| Compose environment file | `/etc/ubc26/host.env` |
| Main API environment file | `/etc/ubc26/api.env`, private |
| Public buyer readiness | Disabled, HTTP 503 |
| Bot integration | Authenticated result callback works, general dispatch disabled |
| x402 on the main API | Unconfigured |
| Current resource state | Existing Droplet remains running and accrues its normal hosting charges |

The deployed ingress serves exact `GET /healthz` independently of buyer readiness. External verification returned 200 with `{"ok":true}`. `/readyz`, buyer job routes, `POST /healthz` and `/healthz/extra` returned 503. An unauthenticated request to the exact Bot callback returned 401. All 16 published runner, engine and documentation asset hashes matched after this ingress deployment.

The 503 buyer gate is deliberate. Process liveness does not establish usable public authoring.

## New operator pilot and the immediate failure

The user approved [the complete authoring pilot](grok-bot/combined-authoring-pilot.md), originally proposed in `47a8a3d`, with this answer:

> Approve pilot with possible in-flight overrun

The approved scope is at most three fresh direct API drafts and three Bot reviews, one complete attempt at a time. The planning allowance is $0.50 incremental inference usage. The estimated total was $0.289736, or about 9.66¢ per attempted run. An individual attempt above 15¢, an uncertain dispatch or charge, missing usage evidence, changed provider terms or an invalid callback stops later calls.

There are no paid repairs, clarification calls or automatic retries. The scope includes native validation, compilation and one local proof. It excludes credit purchases and chain transactions. The provider can finish an active task after the allowance is crossed. The approval explicitly accepts that risk.

A fresh source-pinned image was built on the VPS:

| Pilot component | Value |
| --- | --- |
| Source | `2faedd2832fe80e7ede016bc246020b8c2a8bef5` |
| Image | `sha256:5312fa9e6b2a441e4cc3bab24096af877cc034fb91e64743be7cd4dd74c670f7` |
| Image tag | `ubc26-runtime:pilot-2faedd2` |
| Build unit | `ubc26-runtime-build-pilot-2faedd2.service`, completed successfully |
| Build log | `/root/ubc26-runtime-build-pilot-2faedd2.log` on VPS |
| Pilot container | `ubc26-authoring-pilot-2faedd2` |
| State directory | `/srv/ubc26-state/pilot-2faedd2` on VPS |
| Private environment | `/etc/ubc26/authoring-pilot-2faedd2.env` on VPS |
| Network | Existing private Compose network, no published host port |
| Deployment mode | Local operator mode |
| Pause state | Container stopped, restart policy `no` |

The pilot has its own database and state directory. It uses the real native engine and an explicitly configured xAI credential. The main API retains its prior image. The public Bot callback still points to the main API. No pilot callback cutover occurred.

The first queued draft used the `voyage-fee` brief. Its task ID is `01M7NQRG2BXWM30NJ2WTNAYTZE`. The task failed after one attempt, with an adapter reason of `http_error` and latency of 147 ms. The adapter did not preserve the original HTTP status or response reason in the stored diagnostic record.

The provider returned no usable usage data. The durable reservation therefore remains:

```json
{
  "state": "uncertain",
  "ceiling_micro_usd": 60000,
  "settled_micro_usd": null,
  "usage_json": null
}
```

The 6¢ value is a retained reservation. Actual billing is unknown. There was one submitted API request, zero new Bot runs, zero new proofs and zero chain transactions in this pilot.

The approved stop rule took effect. The remaining two API slots and three Bot slots have not been used. Preserve the existing failed task, its idempotency key and its reservation. Resolve the uncertain outcome before another paid request. Existing approval persists within its scope when work resumes. A material change to its limits or stop rules requires a decision from the user.

Read-only checks from the pilot container subsequently returned HTTP 200 for model listing and API-key status. The reviewed model is listed, the key and team are unblocked, and endpoint/model wildcard permissions are present. These checks do not prove that the API account has spendable credit.

The Grok Bot billing baseline was $4.56 in credits, $0.60 monthly additional usage and a $1 monthly limit. Weekly included usage was exhausted. Auto top-up was previously disabled. This Bot balance does not establish API billing capacity.

Browser automation encountered concurrent user browsing. No API billing conclusion was obtained from the console. Avoid taking over the user's active browser repeatedly.

## Implementation added for this pilot

Commit `dc8fae5` adds `AUTHORING_REPAIRS=0`. The default remains `1`. Disabling repairs permits one model call per attempt. The regression checks the synchronous route, queued execution, exact task replay and settled usage after an invalid draft.

Commit `2faedd2` adds:

- `AUTHORING_RESERVATION_MODE=estimated` for local operator pilots. The default is `provider-bound`.
- Rejection of estimated mode in public `createApp` construction and public readiness.
- Continued payload-size estimation, provider rate floors, durable reservations, actual usage settlement and spending-overrun halts.
- `GROK_MAX_COMPLETION_TOKENS`, validated from 1 through 8,192. The pilot uses 2,048.
- Readiness metadata that labels an estimated budget with `state: "estimated"`.

The pilot API request ceiling is 60,000 micro-USD, and its daily API ceiling is 180,000 micro-USD. Input/output planning rates are $2.50/$5 per million tokens. The estimated mode relaxes the one-million-token context reservation. It does not turn its estimate into a guaranteed provider maximum.

All 1,002 API tests and the API typecheck passed. [Commerce CI at 2faedd2](https://github.com/anishnarang9/UBC-26/actions/runs/44182964161) also passed. The original failed tests demonstrated that an estimated request was rejected and public construction reached database opening before the new policy validation. Follow-up tests verify strict defaults, undersized-estimate rejection and spending halt/recovery in both policies.

Opus reviewed the implementation diff. It suggested explicit environment parsing and asked whether daily limits still apply. Explicit parsing was added. Daily limits continue to apply. Other Opus calls sometimes timed out or returned only a narration. Those calls supply no review verdict.

## What has already worked

| Workstream | Evidence and practical scope |
| --- | --- |
| Hosted runtime | Native Linux API, TLS, persistent SQLite state, pinned compiler and container resources |
| Authentication | Wallet API-key issuance/revocation and ownership tests, plus prior native checks |
| Persistence | Durable tasks, replay, usage reservations, uncertain-charge retention, restart and separate restore checks |
| Native compiler | Real cold compilation on the VPS and later native package generation |
| Capability corpus | 40 supported plans, 39 distinct images, 236 guest executions and 80 pre-guest input rejections with no finite-corpus disagreement |
| Bot reviews | Four real fixed-case decisions, including one negative pilot and three positive follow-ups |
| Bot follow-up validity | Three valid reviews, seven rules and 19 independent-oracle comparisons with zero disagreement |
| Bot-reviewed proof path | Three native compiles, three fresh locally verified proofs, 12 Solidity mutation rejections and exact SDK/engine recovery |
| Public runner and engine | Versioned anonymous HTTPS downloads, hash verification and independent installation checks |
| Published guide examples | Offline Linux installed runner returned verdicts 1 and 0 for the positive and negative guide examples |
| Operations | Reboot/restart checks, bounded filesystems, backup/restore, previous-image rollback check, log rotation and process restart drill |
| Cache cleanup | Isolated pinned BuildKit reclaimed 37.77 MB to 8.192 kB under an 8 MiB threshold |
| Circle preparation | Live facilitator capability query, unsigned isolated VPS quote, existing payer balance and operator signing-boundary checks |

The three earlier positive Bot follow-ups changed the rounded account meters by $0.23 total. Their mean is approximately 7.67¢ per review. These are reviews of frozen prewritten plans. They do not establish fresh natural-language authoring or its complete cost.

The three proof contexts were synthetic. The proofs verify the predicates on their committed inputs. They do not establish fresh funded Arc acceptance or external truth/provenance.

Production BuildKit eviction at its configured 10 GiB threshold and eviction under host free-space pressure remain untested. The isolated cache drill establishes automatic reclamation at a reduced threshold.

Useful reports:

- [Bot follow-ups](../agents/anish/reports/hosted-bot-follow-up-reviews-2026-11-17.json)
- [Bot-reviewed compile/proof/recovery](../agents/anish/reports/hosted-bot-end-to-end-2026-11-17.json)
- [Current pilot record](../agents/anish/reports/hosted-combined-authoring-pilot-proposal-2026-11-17.json)
- [Public guide installation](../agents/anish/reports/hosted-public-guide-installed-runner-2026-11-17.json)
- [Log rotation and restart](../agents/anish/reports/hosted-log-rotation-restart-drill-2026-11-17.json)
- [Cache reclamation](../agents/anish/reports/hosted-buildkit-gc-drill-2026-11-17.json)
- [Previous-image rollback](../agents/anish/reports/hosted-previous-image-rollback-drill-2026-11-17.json)

## Remaining work, in dependency order

### 1. Diagnose and reconcile the first API failure

Preserve the failed attempt. Find the original provider rejection and determine its billing outcome through supported account/console usage or request diagnostics. The current adapter collapses the HTTP status into `http_error`, so improve sanitized diagnostic retention before another approved attempt. Keep provider credentials and raw private response bodies out of public logs.

The model is listed and the key is active. Insufficient API credit, endpoint compatibility and request validation are possibilities. None is established as the cause. Review the current API contract before changing payload fields.

The [current provider guide](https://docs.x.ai/developers/model-capabilities/text/best-practices) describes Chat Completions as a legacy endpoint. The adapter currently uses it. This alone does not establish the cause of the failed request.

Do not send a new generation request solely to discover the old request's status. Once the charge is resolved, resume within the existing scope or ask about a material change to the stop policy.

### 2. Complete the approved authoring pilot

Obtain successful new API drafts through normal hosted routes. Validate the exact generated rules and examples. Preserve requirement coverage and source-quote checks. Request new Bot reviews for the exact generated revisions.

Before a pilot Bot trigger, finish the callback transport setup. The current public connector uses the main API's result endpoint, while the pilot has a separate review store. Choose and verify the callback route before dispatch. Keep delivery claims and tickets durable, and restore normal ingress after a temporary cutover. No cutover has been performed yet.

Compile accepted plans on the VPS, compare independent-oracle outcomes and generate one fresh local proof with exact recovery. Capture costs after each complete attempt. Include failed attempts in cost and success-rate reporting. The average target is still unproven.

### 3. Qualify a production authoring policy and Bot account

The operator pilot runs in local mode behind SSH. Public mode currently rejects its estimated policy. A production policy still needs explicit implementation and qualification under the user's average-cost requirement.

The Bot account also has unrelated connected apps. The provider documents account-wide shared apps/computer state. Public customer dispatch requires the intended review tools and an appropriate account boundary. Exact Bot billing attribution and a genuine runtime conversation export remain pending.

### 4. Complete public buyer acceptance

Enable public authoring only after the provider path and spending policy qualify. Test external wallet authentication, authoring, clarification, permitted repair, approval, compilation and package downloads. Stop any laptop API and repeat those hosted checks. Existing static downloads and callback access cover only their own routes.

### 5. Run later qualification only within approved spend

The plan requires 60 requests over three trials, or 180 genuine deployed trials. Completed genuine application qualification trials remain zero. The three-attempt pilot does not replace them. Mass testing needs later authority and a concrete cost proposal.

### 6. Complete fresh Arc acceptance

The fee-case job `01M7NC38YR6M2KG1E86MYY1SJX` has durable native funding terms and an unchanged Bot receipt. Its owner is `0xb325867d6e52d28d2bd8a7e65d4c41f211639fc0`. That owner had zero testnet balance at preflight.

The prepared bounty is 0.01 testnet USDC. Its saved expiry is `1795035459`, approximately November 18, 2026, at 20:57:39 UTC. Check current confirmed chain time and validity before use. Never silently alter an existing intent to extend it.

The earlier preview proposed a 0.055 testnet USDC top-up from the historical funded buyer. Its transfer gas ceiling was 30,000 gas at 25 gwei. The overall proposed fee-case gas allowance was 0.06775 native testnet USDC including a refund. This preview has no current signing/transfer approval.

A future approved funded flow must generate a new proof from the actual funded context, confirm claim and release, check exact payment and recover through SDK and engine. Separate rejection, refund, restart/replay and second-solver handling remain release gates. Historical Arc acceptance exists from November 16, but does not close this sprint's fresh hosted gate.

See [Arc preview](../agents/anish/reports/hosted-arc-fee-read-only-preview-2026-11-17.json), [wallet preflight](../agents/anish/reports/hosted-arc-fee-wallet-preflight-2026-11-17.json) and [funding terms](../agents/anish/reports/hosted-arc-fee-terms-acceptance-2026-11-17.json).

### 7. Complete separate Circle paid compilation

The main VPS API has no x402 configuration. A network-disabled disposable copy of the deployed image issued the correct 402 twice with an identical payment header/body and zero payment rows.

The proposed separate compile charge is one atomic USDC unit, or 0.000001 testnet USDC. The existing payer is `0x638202cCB15315dBc5b22e02717B908bEAc3AeBd`. The recipient is `0x5c8E2f73Eb2A4E8222b381e2fcb84e5769Ad8c85`.

The latest balance query returned 0.009999 testnet USDC for the payer and 0.000001 for the recipient, both with zero pending batch. A new deposit was unnecessary at that observation. Revalidate before signing.

The worker accepted the captured quote at a signing stub and rejected altered amount, recipient and domain before reaching that stub. No signature or payment was created. A live charge requires fresh scoped authority, the deployed challenge, one persisted authorization, real native compilation, exact paid-response replay and eventual confirmed Circle batch/balance evidence. Payment for compilation is separate from the escrow bounty.

The challenge is issued by our API. Circle's facilitator verifies and settles the authorization. An Opus response conflated those roles while flagging the missing live acceptance; preserve the role distinction.

See [Circle preflight](../agents/anish/reports/hosted-circle-facilitator-preflight-2026-11-17.json) and [protected operator guide](overnight/open-claim-live-operator.md).

### 8. Finish release review and publication

Run the required final CI groups at the actual release SHA. Reconcile separate component pins for API, ingress, runner, engine and docs. Update the capability limits, operational report and Neil's backend handoff. Keep PR #8 a draft until its release gates are met. Merge authorization has not been given.

## Private operator files and safe access

Private operator material is under:

```text
/Users/anishnarang/.local/share/ubc26/hosted-operator/
```

Use the existing `remote.py` SSH helper. It pins the verified host key and disables agent forwarding. The verified ED25519 host fingerprint is:

```text
SHA256:DewD6tS1XaUI9dtYkP7py4OGxfxm9gIlFyZLZfoO944
```

The private `combined-authoring-pilot/` directory contains `approval.json`, `baseline.json`, `build.json`, `identity.json`, `buyer-token`, `run.ts`, `voyage-fee.json` and the source archive. The identity and token files contain credentials. Never print or commit them.

The private parent also contains the xAI key, Bot webhook configuration, callback credential, native check scripts and earlier pilot records. Access only the files needed for the resumed task. Preserve historical keystores and payment journals. Do not scan unrelated credential stores or reconstruct signing authority from old test runs.

The VPS's pilot environment file still holds its credential configuration, protected with mode 0600. The container is stopped with restart disabled. Preserve the pilot database for billing reconciliation. The main API and HTTPS proxy continue running.

The build unit is terminal with `Result=success` and `SubState=exited`. Its `RemainAfterExit` setting can make systemd display `active`; this does not mean a build process is still running.

## Suggested first prompt in the new chat

```text
Resume the hosted backend sprint from
/Users/anishnarang/.codex/worktrees/hosted-backend/UBC-26/docs/hosted-backend-handoff-2026-11-17.md

Read the handoff and current repository instructions first. Continue in the existing
codex/hosted-backend worktree. Start by diagnosing and reconciling the first approved
pilot API request, whose task failed with http_error and uncertain usage.
Preserve its reservation and idempotency identity. Follow the existing approval
and stop rules. Use Antigravity Opus 4.6 for small bounded verification tasks.
```
