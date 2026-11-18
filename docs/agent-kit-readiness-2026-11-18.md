# Agent kit readiness evidence

Checked on 2026-11-17. Branch: `codex/agent-kit`. This review used repository files and local read-only commands. It made no model call, proof, chain transaction, or production change.

| Gate | Evidence | Status |
| --- | --- | --- |
| Public roles | `docs/public/buyer.md` and `solver.md` contain separate guides and cold-start prompts. The solver prompt has no task or answer. | Source ready; public publication pending. |
| Runner pin | Public guide names source `fb450331c014b59d037fb692496bdc4f72b11a9c`, archive SHA-256 `148366c2a62114a8c5d0696fa9c3ee990e06a217d815f4e50c506a856e5a793c`, and release-manifest SHA-256 `fbab4c2c6941115a099aab3b6ab6ca2b4e436066e483f21ce73bcaec1165e447`. Prior native Linux installed checks are in `agents/anish/reports/hosted-runner-native-digitalocean-fb45033-2026-11-17.json`. | Historical release verified. Final release pin pending. |
| Engine pin | `docs/hosted-engine-downloads.md` names Linux x64 engine SHA-256 `be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7`. Its metadata requires glibc. | Historical artifact verified. Final solver host pending. |
| Prover pin | `engine/proof-smoke/README.md` pins `r0vm` 3.1.0 and Docker Groth16 digest `sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583`. Local `docker image inspect` matched this digest. | Local image identity checked. Final Linux prover check pending. |
| Private state | `configure` requires a private work directory and creates mode-0700 `journal` and `prover` directories. Operator code keeps `attempt` state and send journals. It uses one shared prover lock and does not remove stale locks automatically. | Source checked. Final host permissions and shared lock root pending. |
| Resources | This checkout runs on Darwin arm64 with 18 GiB physical RAM and 204 GiB free local disk at review time. Earlier proof work needed a 12-GiB Docker VM. | Final Linux solver memory, free disk, Docker capacity, and proof time remain unverified. |
| Discovery handoff | Public `open-job` returns the chain job ID and committed hashes. The solver guide derives local runner input from this confirmed record. The guide's exact Node command passed on a synthetic public record and created mode-0600 files. | Needs an installed-runner check against a fresh public job. |
| Public brief | `GET /v1/jobs/:id` returns the revision and rules. Open-job discovery does not return the original plain-English brief. | Buyer must publish a public brief that the solver can find without the buyer transcript. |
| Independent recovery | Current `operator recover` reads the solver's private attempt state and expected output files. | Buyer needs a separate public-chain recovery path before the final test. |
| Public routing | Caddy's exact docs allowlist and the controlled proxy asset list include `buyer.md` and `solver.md`. `node --check deploy/check-proxy.mjs` and `git diff --check` passed. | Controlled proxy run and HTTPS publication pending. |

Before the cold test, check `uname -m`, `free -h`, `df -h`, `r0vm --version`, the Docker image digest, installed engine hash, runner `verify-install`, private directory modes, and the shared prover lock root on the actual Linux solver host. Then check the current API and release SHA. The current buyer API returns HTTP 503.
