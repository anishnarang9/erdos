#!/usr/bin/env bash
# Replay measured authoring outputs and verify actual published proof artifacts.
set -euo pipefail
set +x
umask 077
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: evaluate.sh NEW_PRIVATE_SCRATCH PINNED_VERIFIER_CHECKOUT [PRIVATE_PROOF_ROOT]' >&2
  exit 2
fi
eval_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
repo_dir=$(cd -- "$eval_dir/../.." && pwd -P)
verifier_dir=$(cd -- "$2" && pwd -P)
private_args=()
if [[ $# == 3 ]]; then private_args=("$(cd -- "$3" && pwd -P)"); fi
mkdir -- "$1"
run_dir=$(cd -- "$1" && pwd -P)
mkdir "$run_dir/logs"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$run_dir/target}"
mkdir -p "$CARGO_TARGET_DIR"
CARGO_TARGET_DIR=$(cd -- "$CARGO_TARGET_DIR" && pwd -P)
export CARGO_TARGET_DIR
export UBC26_SEEDED_REPORT="$run_dir/seeded.json"
unset RUST_LOG RISC0_DEV_MODE
cd -- "$repo_dir"
echo 'Checking the workspace and independent cases.'
cargo +1.98.1 test --locked --manifest-path engine/Cargo.toml --workspace >"$run_dir/logs/rust.log" 2>&1
cargo +1.98.1 build --locked --manifest-path engine/Cargo.toml --bin engine >"$run_dir/logs/build.log" 2>&1
export UBC26_ENGINE_BIN="$CARGO_TARGET_DIR/debug/engine"
node --test "$eval_dir/"*.test.mjs >"$run_dir/logs/node.log" 2>&1
node --experimental-transform-types --test "$eval_dir/"*.test.ts >"$run_dir/logs/typescript-tests.log" 2>&1
"$repo_dir/commerce/api/node_modules/.bin/tsc" -p "$eval_dir/tsconfig.json" >"$run_dir/logs/typecheck.log" 2>&1
node "$eval_dir/run-challenges.mjs" "$UBC26_ENGINE_BIN" "$run_dir/host" >"$run_dir/logs/host.log" 2>&1
echo 'Replaying the 180 measured Luna outcomes without new model calls.'
node --experimental-transform-types "$eval_dir/run-authoring.mjs" "$UBC26_ENGINE_BIN" "$run_dir/host" "$eval_dir/model-records" "$run_dir/authoring" >"$run_dir/logs/authoring.log" 2>&1
export UBC26_AUTHORING_REPORT="$run_dir/authoring/authoring-report.json"
echo 'Executing archived checker packages and verifying all 12 real receipts.'
node --experimental-transform-types "$eval_dir/verify-published-proofs.mjs" "$UBC26_ENGINE_BIN" "$eval_dir/proofs" "$verifier_dir" "$run_dir/proof-verification" "${private_args[@]}" >"$run_dir/logs/proofs.log" 2>&1
echo "Evaluation replay passed. Reports: $run_dir"
