# commerce (workstream 3)

Agent-to-agent commerce for proof-gated payments. The plan is [COMMERCE-IMPLEMENTATION.md](../agents/current%20plan/COMMERCE-IMPLEMENTATION.md).

| Package | Contents | Contract |
| --- | --- | --- |
| `sdk` | Byte codec (engine wire format) and the viem chain adapter. The chain ABI is SIMULATED until settlement publishes the real one. | [sdk/CONTRACT.md](sdk/CONTRACT.md) |
| `api` | HTTP JSON API: drafting with Grok, approval, compile on the real engine, kept packages, quotes, funding linkage | [api/CONTRACT.md](api/CONTRACT.md), [api/CONTRACT-T5-T8.md](api/CONTRACT-T5-T8.md) |
| `worker` | Solver agent: downloads the package, solves, runs `engine prove`, checks the proof, decrypts. It uses a SYNTHETIC funded context until settlement is deployed. | [worker/src/run.ts](worker/src/run.ts) |

## Run the tests

```sh
cd commerce
corepack enable            # or prefix each pnpm command with: corepack pnpm@10.34.9
pnpm install
pnpm typecheck
pnpm test                  # fast suites; the engine is faked, using its real CLI contract
```

You need Node 22.13 or newer (`node:sqlite`). Chain tests start a local anvil from the `@foundry-rs/anvil` npm package. If anvil cannot start, they are skipped and the reason is printed.

## Real engine (WSL2 or Linux)

The API and the worker call Anish's engine CLI (branch `codex/anish-engine`, `engine/README.md`). On Windows the engine runs in WSL2, and Node calls it through `wsl.exe -e env … engine` without a shell.

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
# Build the engine from Anish's branch
git clone <repo> ~/ubc26/engine-wt && cd ~/ubc26/engine-wt && git checkout codex/anish-engine
cargo +1.98.1 build --locked --manifest-path engine/Cargo.toml --bin engine
mkdir -p ~/ubc26/work
```

rzup puts r0vm at `~/.risc0/extensions/v3.1.0-cargo-risczero-x86_64-unknown-linux-gnu/r0vm`, not in `~/.risc0/bin`.

### Environment

Set these in the environment or in `commerce/api/.env` (gitignored). Use Linux paths for the engine and `\\wsl.localhost\Ubuntu\...` host paths for the directories Node writes, so files stay on the case-sensitive WSL filesystem.

| Variable | Example | Used by |
| --- | --- | --- |
| `ENGINE_MODE` | `wsl` (or `native` on Linux, or the default `simulated`) | API, worker, tests |
| `ENGINE_PATH` | `/home/neil/ubc26/engine-wt/engine/target/debug/engine` | API, worker, tests |
| `ENGINE_WSL_DISTRO` | `Ubuntu` (default) | API, worker, tests |
| `ENGINE_R0VM` | `/home/neil/.risc0/extensions/v3.1.0-cargo-risczero-x86_64-unknown-linux-gnu/r0vm` | prove |
| `ENGINE_WORK_DIR` | `\\wsl.localhost\Ubuntu\home\neil밦\work` | temporary engine inputs |
| `PACKAGES_DIR` | `\\wsl.localhost\Ubuntu\home\neil밦\packages` | API: compiled packages kept for workers |
| `WORKER_DATA_DIR` | `\\wsl.localhost\Ubuntu\home\neil밦\attempts` | worker attempts (these hold release keys, so keep them private) |
| `XAI_API_KEY`, `XAI_MODEL` | from console.x.ai | Grok drafting |
| `GROK_RECORD_DIR` / `GROK_REPLAY_DIR` | `test/integration/fixtures/grok` | record or replay Grok calls |
| `BUYER_API_TOKEN` | 16+ random characters | API |

### Real-engine suites

```sh
pnpm --filter @ubc26/api test:engine       # validate, eval, compile, approval binding, kept package (~10 s warm)
pnpm --filter @ubc26/worker test:engine    # compile + two real Groth16 proofs + decrypt (~4 min)
pnpm --filter @ubc26/api record:grok       # needs XAI_API_KEY: records one real draft and one unsupported request
```

### Run the API and the worker by hand

```sh
cd commerce/api && pnpm dev                                  # reads .env; logs which engine and draft model it uses
cd commerce/worker && pnpm prove-synthetic -- --api http://localhost:8787 --job <jobId> --solver reconciliation
```

The worker prints a report: verdict, prove time, cycles, the proof checks, and the recovered file digests. It never prints the release key.

Anything labelled **SIMULATED** (stub contracts, mock verifier, the default simulated engine) is a stand-in until the real piece is deployed. The worker's funded context is **SYNTHETIC** (escrow `0x…5157`, random job ID) until Nick's settlement contracts are live.
