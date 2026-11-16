# commerce (workstream 3)

Agent-to-agent commerce for proof-gated payments. The plan is [COMMERCE-IMPLEMENTATION.md](../agents/current%20plan/COMMERCE-IMPLEMENTATION.md).

## 2026-11-15 — Anish — Current integration

The API and worker use the domain-independent typed-plan [Rust engine](../engine/README.md), including bounded records, aggregates, and evidence. The integration branch `codex/engine-commerce` includes Neil `8584b04`, Nick `57c387f`, and engine `adda3a3` through actual merge ancestry. [PR #6](https://github.com/anishnarang9/UBC-26/pull/6) is open. Normal integration into main is authorized, not completed by this statement.

The isolated core is frozen. A later read-only refresh passed 60 checks at block 72490082; the earlier check at block 72478546 remains historical. Deployment checks are not live funded acceptance or spending permission. The [core sprint runbook](../docs/core-sprint.md) separates tested modules, the partial local report at `9458a81`, timer correction `2d9f2fd`, and the still-pending [Meridian rehearsal](../docs/core-sprint.md#local-first-meridian-rehearsal) and final-head CI. A buyer web UI remains planned. No `commerce/web` implementation is present.

| Package | Contents | Contract |
| --- | --- | --- |
| `sdk` | Byte codec, explicit simulation adapter, and real Arc reader with pinned-block snapshots. | [sdk/CONTRACT.md](sdk/CONTRACT.md), [Arc interface](sdk/src/chain/arc/INTERFACE.md) |
| `api` | HTTP JSON API: drafting with Grok, approval, compile on the real engine, kept packages, quotes, funding linkage | [api/CONTRACT.md](api/CONTRACT.md), [api/CONTRACT-T5-T8.md](api/CONTRACT-T5-T8.md) |
| `worker` | Synthetic proving plus a durable funded lifecycle and capability-gated Arc settlement adapter. Broadcast is disabled by default. | [worker/src/run.ts](worker/src/run.ts), [funded lifecycle](worker/src/funded.ts) |

## Run the tests

```sh
cd commerce
corepack enable            # or prefix each pnpm command with: corepack pnpm@10.34.9
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test                  # fast suites; the engine is faked, using its real CLI contract
```

You need Node 22.13 or newer (`node:sqlite`). Chain tests start a local anvil from the `@foundry-rs/anvil` npm package. If anvil cannot start, they are skipped and the reason is printed.

## Separate operator runner

See the [operator runbook](../docs/core-sprint.md#separate-operator-runner) for seven commands, required files, protected descriptors, and separate funding/provider approvals. `src/cli.ts funded` remains read-only. The separate sprint runner accepts pinned native POSIX engines only and fails closed on WSL. The API/worker WSL support below remains available.

The [local report](../agents/anish/reports/core-sprint-local-2026-11-15.json) has status `partial`. Its lifecycle status is `passed`, and the process exit code is 1. On source `9458a81` the lifecycle recorded a 583188 ms proof, then an unhandled cleanup timer failed the process. The report retains a historical 592.4-second attempt. Timer correction `2d9f2fd` has focused checks only. It is not a fresh full pass, live Arc, or live Grok. The [Meridian rehearsal](../docs/core-sprint.md#local-first-meridian-rehearsal) holds the suite command, guest report, and local fixture timing. No fresh full pass or Meridian proof exists. Final-head CI remains pending. Permanent provider gas reservations receive no finality discount. Do not automatically delete stale account locks.

## Real engine (WSL2 or Linux)

The API and worker call the engine CLI from this integrated checkout. The original engine branch is `codex/anish-engine`. On Windows the engine runs in WSL2, and Node calls it through `wsl.exe -e env … engine` without a shell.

### One-time setup inside WSL (Ubuntu)

```sh
# Docker Engine with buildx (compile builds the guest in Docker; prove runs the Groth16 prover in Docker)
sudo apt-get install -y docker.io docker-buildx && sudo usermod -aG docker $USER   # then reopen WSL
# Rust 1.98.1 and r0vm 3.1.0
rustup toolchain install 1.98.1 --profile minimal
curl -L https://risczero.com/install | bash && ~/.risc0/bin/rzup install r0vm 3.1.0
# The pinned Groth16 prover image (about 5.4 GB)
image=risczero/risc0-groth16-prover; digest=sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583
docker pull --platform linux/amd64 "$image@$digest" && docker tag "$image@$digest" "$image:v2026-10-20.1"
# Build the integrated engine (use the reviewed integration revision)
git clone <repo> ~/ubc26/engine-wt && cd ~/ubc26/engine-wt && git checkout codex/engine-commerce
cargo +1.98.1 build --locked --manifest-path engine/Cargo.toml --bin engine
mkdir -p ~/ubc26/work
```

rzup puts r0vm at `~/.risc0/extensions/v3.1.0-cargo-risczero-x86_64-unknown-linux-gnu/r0vm`, not in `~/.risc0/bin`.

### Environment

Export these variables in the shell for the real-engine test suites; the Vitest suites do not load `.env` files. The API server loads `.env` from its working directory (normally `commerce/api/.env`), and the worker CLI separately loads `.env` from its own working directory (normally `commerce/worker/.env`). Both are gitignored; real environment variables win. Use Linux paths for the engine and `\\wsl.localhost\Ubuntu\...` host paths for the directories Node writes, so files stay on the case-sensitive WSL filesystem.

| Variable | Example | Used by |
| --- | --- | --- |
| `ENGINE_MODE` | `wsl` (or `native` on Linux, or the default `simulated`) | API, worker, tests |
| `ENGINE_PATH` | `/home/neil/ubc26/engine-wt/engine/target/debug/engine` | API, worker, tests |
| `ENGINE_WSL_DISTRO` | `Ubuntu` (default) | API, worker, tests |
| `ENGINE_R0VM` | `/home/neil/.risc0/extensions/v3.1.0-cargo-risczero-x86_64-unknown-linux-gnu/r0vm` | prove |
| `ENGINE_WORK_DIR` | `\\wsl.localhost\Ubuntu\home\<you>\ubc26\work` | temporary engine inputs |
| `PACKAGES_DIR` | `\\wsl.localhost\Ubuntu\home\<you>\ubc26\packages` | API: compiled packages kept for workers |
| `WORKER_DATA_DIR` | `\\wsl.localhost\Ubuntu\home\<you>\ubc26\attempts` | worker attempts (these hold release keys, so keep them private) |
| `XAI_API_KEY`, `XAI_MODEL` | from console.x.ai | Grok drafting |
| `GROK_RECORD_DIR` / `GROK_REPLAY_DIR` | `test/integration/fixtures/grok` | record or replay Grok calls |
| `BUYER_API_TOKEN` | 16+ random characters | API |

### Real-engine suites

```sh
pnpm --filter @ubc26/api test:engine       # validate, eval, compile, approval binding, kept package (~10 s warm)
pnpm --filter @ubc26/worker test:engine    # two synthetic workflows, four real Groth16 proofs + recovery checks; slow
pnpm --filter @ubc26/api record:grok       # needs XAI_API_KEY: records one real draft and one unsupported request
```

### Run the API and the worker by hand

```sh
cd commerce/api && pnpm dev                                  # reads .env; logs which engine and draft model it uses
cd commerce/worker && pnpm prove-synthetic -- --api http://localhost:8787 --job <jobId> --solver reconciliation
```

The worker prints a report: verdict, prove time, cycles, the proof checks, and the recovered file digests. It never prints the release key.

Anything labelled **SIMULATED** uses explicit test adapters. `prove-synthetic` always uses a **SYNTHETIC** context (escrow `0x…5157`, random job ID), regardless of whether contracts are deployed. Its proof cannot settle an independently funded Arc job.

## Real Arc integration and live gates

The API reads `CHAIN_RPC_URL`, `CHAIN_ID`, `CHAIN_CORE`, `CHAIN_HOOK`, and `CHAIN_USDC`; see `.env.example`. An unset `CHAIN_RPC_URL` disables chain routes. A configured Arc chain requires the real native/WSL engine and the real reader before database access or listening. Embedded callers must declare `chain.mode` explicitly. Legacy simulated or unidentified cached artifacts cannot become real funding terms merely by restarting with a real engine; revise, approve, and compile through the real CLI.

Arc selection uses pinned chain time, enforces the deployed funding margin, and requires at least 1,200 seconds (or the deployed minimum plus 120 seconds, if larger). This is a safety floor, not a proving SLA: choose the approved expiry using measured proving time, funding, submission, release, and operational overhead. The worker independently enforces its explicit proving, submit, and release budgets.

The Poster sends exactly `createJob → setBudget → approve → fund`. Only the client (Poster) can call `setBudget` in this patched core. Preserve the API-selected absolute `expiredAt` in every call and comparison. Never replace it with a new relative deadline. Bounty and ERC-20 allowance amounts use six decimals. Native gas amounts use 18 decimals. The sprint funding helper currently restricts the bounty to `1000000` units (1 test USDC), but still requires separate spending approval. A completed local Meridian exit 0 does not name the buyer or provider account, the keystore, or the spending cap. Those values stay a later explicit approval.

Read-only worker commands, from `commerce/worker`:

```sh
pnpm exec tsx src/cli.ts funded inspect --chain-job <id> --rpc <url> --core <address> --hook <address> --usdc <address> --provider <address>
pnpm exec tsx src/cli.ts funded preflight --chain-job <id> --rpc <url> --core <address> --hook <address> --usdc <address> --provider <address> --proof /private/attempt/proof.json
```

`prepare` with `--proof` is also read-only; it does not generate a proof. CLI submit/release/broadcast is deliberately disabled because no safe signer is configured there. A successful read-only preflight does not approve a deployment.

The library exports `createArcSettlementPort`, `runFunded`, and `ArcDeploymentPolicy`. Broadcast requires both `allowBroadcast: true` and an externally managed `ArcBroadcastCapability` that directly signs and broadcasts without simulation or gas estimation. Do not implement it with an arbitrary unlocked RPC account. The final signing boundary enforces exact authorized calldata, job ID, chain, destination, zero native value, gas limits, and fee caps (Arc floor 20 gwei).

Operator-approved deployment policy must pin the actual proxy creation/initialization block, implementation address, verifier address/version/selector, and audited runtime hashes. Before broadcast the worker checks zero fees, hook whitelist, implementation/code identity, and complete role-grant/revocation history with no surviving privileged role holders. It accepts only never-upgraded cores. RPC history must be complete and truthful; runtime hashes are external audit trust roots, not approval inferred from the RPC itself. A final fresh snapshot checks job identity, commitments, and deadline after history verification. RPC checks cannot be atomic with signing or inclusion.

The current manifest records the deployed core as **frozen**. Nick corrected the all-holder script defect. The historical [deployment evidence](../agents/anish/reports/core-sprint-deployment-2026-11-15.json) records 60 passing checks at block 72478546, including four exact runtime/build matches. A later read-only refresh passed 60 checks at block 72490082. The nonauthorizing `parseDeploymentPolicy` function returns candidate pins, not permission. Signing still requires operator approval and fresh deployment/job checks. Do not repeat the freeze.

Attempts persist private state before proving or broadcasting, save transaction hashes before receipt polling, and never blindly resend pending or uncertain transactions. Interrupted preparation/proving, stale locks, and an intent without a durable hash require manual reconciliation. Resume validates private artifacts, buyer approval, chain context, and exact recovery again. Once release dispatch begins, state records the key as potentially public and payment as unconfirmed until authoritative receipt/state checks pass. Even a failed release can disclose the key. Only dummy keys are used in release simulations; `WrongKey` does not prove payout liveness.

Separate sprint modules provide strict private state, a restricted provider broadcaster, encrypted operator keystore loading, and four-call Poster funding. `runFunded` supports `stopAfterProof` with a bounded proving timeout. The recorded lifecycle assertions passed, then the suite process exited 1. Live acceptance remains pending. The [operator runbook](../docs/core-sprint.md#separate-operator-runner) documents the separate runner's seven commands. None of this enables writes in `src/cli.ts funded`.

Optional indexer confirmations are published at `e8b9273`. Server startup passes `3n` for Arc and `0n` for simulation. An embedded caller that omits the option stays at `0n` and must set it explicitly. Three blocks are a bounded lag allowance, not protection against an RPC that omits arbitrary logs. Indexed status and delivery appear only after that delay. Adding the delay does not repair logs the cursor already skipped. A clean local run uses a fresh database. An existing deployment needs a deliberate, approved reindex. Do not reset or delete the cursor automatically. Details are in the [indexer note](../docs/core-sprint.md#indexer-confirmation-lag).

Known `ws` advisories remain open. The controlled local keystore path uses no WebSocket connection. That scope limit does not remediate the dependency or establish production security. Keep signing and release keys outside prompts, logs, environment examples, and public reports.

## Repeatable local settlement verification

From repository root, after installing the pinned `engine/tests` and commerce dependencies:

```sh
node engine/tests/verify-settlement.mjs
# Optional full payout and exact recovery using private keys from the original proof run:
node engine/tests/verify-settlement.mjs --private-root /private/proof-run
```

This starts disposable loopback-only Anvil Cancun, compiles Nick's pinned actual core/hook/verifier, and uses real published Groth16 receipts. Full mode checks payout, exact recovery, rejection, replay, and expiry refunds from Funded and Submitted. It deliberately installs proxy runtime at the receipt's synthetic escrow and impersonates its synthetic provider, using a mock ERC20. It is **not live Arc evidence**, a fresh funded context, or an end-to-end proof-generation/service run. The concrete worker/API paths have separate regression and real-engine integration suites.

Live funding, submission, release, refunds, deployment, and irreversible role renunciation require explicit authorization. Production security approval also remains separate from the local checks; advisory reachability and controlled remediation are tracked in `agents/anish/reports/integration-dependency-triage.json`.
