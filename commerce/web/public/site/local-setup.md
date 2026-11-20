# Erdos local setup

Use these steps from a Bash shell on Linux or macOS with Docker running. On Windows, run Bash in a WSL distribution that has Docker Desktop integration. The image runs Linux x64. On Apple Silicon, enable amd64 emulation in Docker Desktop. Allow time for proving and keep only one prover active on your machine.

## Build the image

```bash
export SITE=https://ubc-26-gamma.vercel.app/site
export API=https://ubc26-159-89-149-133.sslip.io
export IMAGE=erdos-solver:0b35d3a
umask 077
export WORK=$(mktemp -d "$HOME/erdos-work.XXXXXX")
mkdir "$WORK/build"
curl -fsS "$SITE/solver-runtime.Dockerfile" -o "$WORK/build/Dockerfile"
curl -fsS "$SITE/test-wallet.mjs" -o "$WORK/build/test-wallet.mjs"
docker build --platform linux/amd64 --tag "$IMAGE" "$WORK/build"
curl -fsS "$API/readyz"
```

The build verifies the runner, engine, RISC Zero archive, and wallet library against fixed SHA-256 hashes. The image installs `ubc26`, `ubc26-engine`, `r0vm`, and `erdos-test-wallet`.

Define this function to run buyer commands in the same private directory. It uses your local user ID and runs without Docker socket access.

```bash
erdos() {
  docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$WORK,dst=$WORK" --workdir "$WORK" \
    "$IMAGE" "$@"
}
erdos ubc26 help
```

## Wallet

Create one wallet for your role. Create buyer and solver wallets in separate private workspaces when testing both roles. The command prints the public address and file paths. Keep the password and keystore files private.

```bash
erdos erdos-test-wallet "$WORK/wallet"
export WALLET=$(cat "$WORK/wallet/address")
export KEY_FILE="$WORK/api-key"
erdos bash -c 'ubc26 auth --api "$1" --wallet "$2" \
  --keystore "$3/wallet/keystore.json" --password-fd 3 --key-out "$3/api-key" \
  --idempotency auth-001 3<"$3/wallet/password"' bash "$API" "$WALLET" "$WORK"
```

A buyer can authenticate, import, and compile before adding test USDC. To fund or solve a job, request test USDC at the [Circle Faucet](https://faucet.circle.com/). Select Arc Testnet and enter the public address from `$WORK/wallet/address`. A human must complete any faucet verification. Keep the wallet on Arc Testnet (chain ID 5042002).

For an open bounty, the funding preview uses the buyer address. The current runner also requires a distinct address in its local solver configuration. Set that field to a separate test address. It does not restrict who can claim the open bounty. You do not need its keystore to fund.

## Groth16 smoke test

This test proves and recovers one synthetic delivery. It signs no transactions and uses no wallet. The Groth16 container must see the same absolute working path as the runner. Keep the working directory under your home directory so Docker Desktop can mount it.

```bash
export SMOKE=$(mktemp -d "$HOME/erdos-smoke.XXXXXX")
mkdir "$SMOKE/groth16"
curl -fsS "$SITE/prover-smoke.sh" -o "$SMOKE/prover-smoke.sh"
curl -fsS "$SITE/prover-smoke/SHA256SUMS" -o "$SMOKE/SHA256SUMS"
for file in job.json package/guest.elf package/manifest.json \
  package/parameters.jcs package/structure.jcs delivery/expenses.json; do
  mkdir -p "$SMOKE/$(dirname "$file")"
  curl -fsS "$SITE/prover-smoke/$file" -o "$SMOKE/$file"
done

PROVER=risczero/risc0-groth16-prover
PIN=sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583
docker pull --platform linux/amd64 "$PROVER@$PIN"
docker tag "$PROVER@$PIN" "$PROVER:v2026-10-20.1"

docker run --rm --platform linux/amd64 \
  --mount "type=bind,src=$SMOKE,dst=$SMOKE" --workdir "$SMOKE" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --env "RISC0_WORK_DIR=$SMOKE/groth16" --env DOCKER_DEFAULT_PLATFORM=linux/amd64 \
  "$IMAGE" sh ./prover-smoke.sh
```

Require verdict 1, a 260-byte seal, and `recoveryMatches:true`. Give Docker socket access only to the reviewed proving runtime in this command. Run buyer commands and manage wallet files without that socket.

## Use the container with the role guides

Use `erdos ubc26` for buyer commands in the [buyer guide](https://ubc26-159-89-149-133.sslip.io/downloads/docs/552ff1f9d3c8fe7352f433306f28ddf9039a51d4/buyer.md). To use an inherited password descriptor, put the shell redirection inside the container as shown in the wallet example.

The [solver guide](https://ubc26-159-89-149-133.sslip.io/downloads/docs/552ff1f9d3c8fe7352f433306f28ddf9039a51d4/solver.md) describes job discovery, checking, and settlement. For a job, create a new mode-0700 Groth16 directory under that job's workspace. Use the following engine config. Replace <ABSOLUTE_JOB_WORKSPACE> with the directory mounted at the same path on your host and in the container.

```json
{
  "mode": "native",
  "executable": "/usr/local/bin/ubc26-engine",
  "executableSha256": "be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7",
  "wrapperSha256": "837247389b69287352445191229b41cc998285d8253b464339d84a8a3944fee5",
  "environment": {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "RISC0_SERVER_PATH": "/usr/local/bin/r0vm",
    "DOCKER_DEFAULT_PLATFORM": "linux/amd64",
    "RISC0_WORK_DIR": "<ABSOLUTE_JOB_WORKSPACE>/groth16"
  }
}
```

Compare `erdos ubc26 wrapper-digest` with the digest above. Save the config as `engine.json` in the role workspace. Mount the Docker socket for `operator prepare` only when needed for proving. Use the same workspace and config for `operator run` and subsequent retries.

For an HTTP 429, wait at least the number of seconds in `Retry-After` when present. Retry with the same request body and idempotency key. If the service returned a task ID, poll that task.
