#!/bin/sh
set -eu
umask 077

: "${RISC0_WORK_DIR:?Set RISC0_WORK_DIR to the shared groth16 directory}"
test -d "$RISC0_WORK_DIR"
sha256sum --check SHA256SUMS
mkdir reference
ubc26-engine prove --package package --job job.json \
  --deliverables delivery --reference reference --out attempt
ubc26-engine decrypt --submission attempt/proof.json \
  --key-file attempt/release-key.hex --out recovered
cmp delivery/expenses.json recovered/expenses.json
node --input-type=module -e '
import { readFileSync } from "node:fs";
const proof = JSON.parse(readFileSync("attempt/proof.json", "utf8"));
if (proof.verdict !== 1 || !/^0xe71e6620[0-9a-f]{512}$/.test(proof.seal)) {
  throw Error("Expected a passing RISC Zero 3.1.0 Groth16 proof");
}
console.log(JSON.stringify({ verdict: 1, sealBytes: 260, recoveryMatches: true }));
'
