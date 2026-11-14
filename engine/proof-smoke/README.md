# RISC Zero proof smoke check

This standalone workspace checks the first proof handoff to Arc. The guest commits the raw bytes `UBC26/proof-smoke/v1`. This journal uses smoke data and does not implement the engine's 234-byte job journal.

Run this on Linux x86-64 with Docker. On Apple Silicon, start Docker Desktop with amd64 emulation and set `DOCKER_DEFAULT_PLATFORM=linux/amd64`.

Install Rust 1.98.1 and [rzup](https://dev.risczero.com/api/zkvm/install):

```sh
rustup toolchain install 1.98.1 --profile minimal
rzup install rust 1.97.0
rzup install cargo-risczero 3.1.0
rzup install r0vm 3.1.0
r0vm --version
```

Ensure the last command prints `risc0-r0vm 3.1.0`. You can set `RISC0_SERVER_PATH` to the exact path of that binary. The program uses a local `r0vm` subprocess.

Run these commands from this directory:

```sh
unset RISC0_DEV_MODE RISC0_DOCKER_CONTAINER_TAG RISC0_SKIP_BUILD RUST_LOG
bash tests/smoke.sh

image=risczero/risc0-groth16-prover
digest=sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583
docker pull --platform linux/amd64 "$image@$digest"
docker tag "$image@$digest" "$image:v2026-10-20.1"
cargo +1.98.1 run --locked --release -- prove > smoke-proof.json
```

The build uses the amd64 `risczero/risc0-guest-builder` image at digest `sha256:6f6c300e4af57ea3efe62b7f04a17629efe0f0caa6ad3699d6766bf19e0e62fb`. The image contains RISC Zero Rust `r0.1.97.0`. Both Cargo builds use lockfiles.

Execution checks the journal, image ID, and guest exit code. It produces no receipt. Proving requires a real Groth16 receipt, verifies it against the computed image ID, and checks the journal. The host rejects a changed journal and a changed image ID before it prints the result. The JSON contains `imageId`, `journal`, the 260-byte `seal`, `userCycles`, and `proveMillis`. The seal begins with selector `0xe71e6620`. Pass the three hex fields to the matching Arc verifier.

The CPU prover in [RISC Zero v3.1.0](https://github.com/risc0/risc0/releases/tag/v3.1.0) refers to the Docker tag in its source. The smoke host checks that the local tag points to the pinned digest. The exporter uses [the v3.1.0 Ethereum seal encoder](https://github.com/risc0/risc0-ethereum/blob/v3.1.0/contracts/src/lib.rs).

On November 14, 2026, an arm64 Mac ran the native `r0vm` 3.1.0 and used the pinned amd64 CPU prover under Docker Desktop. Its host-built guest took 104.678 seconds to prove and ran for 2,792 user cycles. It produced image ID `0xe0ff5c319550f9eb95a08b26fe53bc05fb6ab02647716fd6cac40373d8fd59eb`. The host verified the receipt and rejected the two mutations. That result does not establish the proving time on Linux or for a full engine guest.

The digest-pinned guest ran for 2,792 user cycles and took 106.922 seconds to prove on the same Mac. Its image ID is `0x75661c85ddcfde61f0ace9e28491de2e4d7a4c73603f0ad5549b8d10819fab18`. The host verified the receipt and rejected a changed journal and a changed image ID. The [synthetic proof fixture](../fixtures/groth16-smoke-v1.json) contains this receipt's EVM inputs. The v3.1.0 Solidity verifier accepted them on a local EVM and rejected mutations to the journal, image ID, and seal. The valid verifier call had an estimated gas cost of 257,760.
