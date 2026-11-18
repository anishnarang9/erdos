# Agent kit readiness evidence

Checked on 2026-11-18. Branch: `codex/hosted-release`. The API, runner, and engine use source `33a9883e729b17da8fd97bc5a8981ee989dc9a36`. The corrected public guide uses documentation source `3d463504102d5916191c5699f128fe28ff7158ca` and names those exact runtime pins. Public buyer routes still return HTTP 503.

| Gate | Evidence | Status |
| --- | --- | --- |
| Public roles | [Buyer](public/buyer.md) and [solver](public/solver.md) guides have separate prompts. The solver prompt has no task or answer. | Published with the corrected developer guide at `/downloads/docs/3d463504102d5916191c5699f128fe28ff7158ca/`. External HTTPS checks returned 200 and matched each file hash. |
| Runner pin | The published Linux archive SHA-256 is `e2e69cc55ea2788fd1d0b475613397bc524b30f5009ba534c1301513814c61fd`. Its installed `ubc26-release.json` SHA-256 is `d39989cf405fc432c2da350b9dd997a150b224a6841f1fd05e13f1a303d028aa`. | Source-pinned download, reproducible archive, offline Linux install, and VPS `verify-install` passed. Complete funded operator use remains untested. |
| Engine and prover pins | The Linux engine SHA-256 is `be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7`. The VPS runs `r0vm` 3.1.0 and Groth16 image `sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583` on amd64. | The engine file now has mode 0555. One synthetic proof returned verdict 1 and decrypted the exact four-byte `Done` file. See the [proof report](../agents/anish/reports/hosted-solver-preflight-2026-11-18.json). |
| Resources | The VPS has 7.8 GiB RAM, an active 8 GiB swap file, and 120 GiB free root disk after the proof. The swap file has mode 0600 and an `/etc/fstab` entry. | The proof used 4.5 GiB peak memory and 28.4 MiB peak swap. No reboot was performed to test persistence. |
| Private state | `configure` creates private work, journal, and prover directories. The operator uses a shared prover lock and retains send journals. | Source and installed-runner checks passed. Create and inspect fresh private directories for each cold agent. |
| Discovery handoff | Open-job discovery supplies confirmed public fields. The solver guide derives local terms and funding files from those fields. | The mapping passed on a synthetic public record. A fresh funded public job remains untested. |
| Public brief | The buyer can publish one immutable brief after confirmed funding. | Focused tests passed. Fresh public publication remains untested. |
| Independent recovery | `buyer-recover` reads confirmed Arc claim and release data, then checks SDK and engine recovery without solver files. | Focused tests passed. Fresh funded recovery remains untested. |
| Public routing | The corrected docs version serves `README.md`, `buyer.md`, `solver.md`, `release.json`, and `SHA256SUMS` over HTTPS. | External hashes matched. `/healthz` returned 200; `/readyz` and discovery returned 503. |

The final test still needs a qualified public authoring policy, controlled Bot account, fresh external wallet authentication, and the funded Arc lifecycle. The synthetic proof does not replace that test.
