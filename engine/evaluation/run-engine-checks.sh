#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

if [[ $# != 1 ]]; then
  echo 'Usage: run-engine-checks.sh NEW_SCRATCH_DIRECTORY' >&2
  exit 2
fi
evaluation_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
repo_dir=$(cd -- "$evaluation_dir/../.." && pwd -P)
mkdir -- "$1"
scratch_dir=$(cd -- "$1" && pwd -P)
mkdir -- "$scratch_dir/logs" "$scratch_dir/docker-bin"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch_dir/target}"
mkdir -p -- "$CARGO_TARGET_DIR"
CARGO_TARGET_DIR=$(cd -- "$CARGO_TARGET_DIR" && pwd -P)
export CARGO_TARGET_DIR
export UBC26_ENGINE_CACHE="${UBC26_ENGINE_CACHE:-$scratch_dir/cache}"
export UBC26_SEEDED_REPORT="$scratch_dir/seeded.json"
export ENGINE_DOCKER="${ENGINE_DOCKER:-$(command -v docker)}"
cp -- "$evaluation_dir/../tests/low-memory-docker.sh" "$scratch_dir/docker-bin/docker"
chmod 700 "$scratch_dir/docker-bin/docker"
export PATH="$scratch_dir/docker-bin:$PATH"
unset RUST_LOG RISC0_DEV_MODE
cd -- "$repo_dir"
echo 'Checking the independent challenge and artifact tests.'
node --test "$evaluation_dir/"*.test.mjs >"$scratch_dir/logs/node-tests.log" 2>&1
echo 'Checking the Rust workspace and 10,000 seeded cases.'
cargo +1.98.1 test --locked --manifest-path engine/Cargo.toml --workspace >"$scratch_dir/logs/rust-tests.log" 2>&1
cargo +1.98.1 build --locked --manifest-path engine/Cargo.toml --bin engine >"$scratch_dir/logs/build.log" 2>&1
engine_bin="$CARGO_TARGET_DIR/debug/engine"
echo 'Comparing all challenge candidates with independent expectations.'
node "$evaluation_dir/run-challenges.mjs" "$engine_bin" "$scratch_dir/host" >"$scratch_dir/logs/host.log" 2>&1
echo 'Preparing all approved checker packages.'
node "$evaluation_dir/prepare-packages.mjs" "$engine_bin" "$scratch_dir/host" "$scratch_dir/packages" >"$scratch_dir/logs/packages.log" 2>&1
echo 'Executing the actual generated guests.'
node "$evaluation_dir/execute-packages.mjs" "$engine_bin" "$scratch_dir/host" "$scratch_dir/packages" "$scratch_dir/execution" >"$scratch_dir/logs/execution.log" 2>&1
echo 'Checking exact artifact binding and commitment invariants.'
node "$evaluation_dir/audit-guests.mjs" "$scratch_dir/host" "$scratch_dir/execution" "$scratch_dir/guest-audit.json" >"$scratch_dir/logs/audit.log" 2>&1
node "$evaluation_dir/check-invariants.mjs" "$engine_bin" "$scratch_dir/host" "$scratch_dir/packages" "$scratch_dir/invariants" >"$scratch_dir/logs/invariants.log" 2>&1
echo "Engine checks passed. Reports: $scratch_dir"
