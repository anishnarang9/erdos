#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 ENGINE NEW_SCRATCH_DIR [all|reconciliation|signed-text|limits]" >&2
  exit 2
fi
selection=${3:-all}
case "$selection" in
  all|reconciliation|signed-text|limits) ;;
  *) echo "Unknown fixture selection: $selection" >&2; exit 2 ;;
esac
engine=$(cd -- "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1")
if [[ ! -f "$engine" || ! -x "$engine" ]]; then
  echo "Expected an executable engine binary" >&2
  exit 2
fi
engine_dir=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
mkdir -- "$2"
scratch=$(cd -- "$2" && pwd -P)
export UBC26_ENGINE_CACHE="$scratch/cache"

compile_case() {
  local case_dir=$1 plan=$2 reference=$3
  "$engine" compile --plan "$plan" --reference "$reference" --out "$case_dir/package" >"$case_dir/manifest.json"
  "$engine" compile --plan "$plan" --reference "$reference" --out "$case_dir/warm-package" >"$case_dir/warm.json"
  python3 - "$case_dir" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])

def read(name):
    return json.loads((root / name).read_text())

cold = read("manifest.json")
warm = read("warm.json")
if cold.get("cacheHit") is not False or warm.get("cacheHit") is not True:
    raise SystemExit("Expected a cold cache miss and a warm cache hit")
manifests = (warm, read("package/manifest.json"), read("warm-package/manifest.json"))
for field in ("imageId", "buildFingerprint", "structureHash", "rulesHash", "referenceHash",
              "guestSha256", "structureSha256", "parametersSha256"):
    if not cold.get(field) or any(manifest.get(field) != cold[field] for manifest in manifests):
        raise SystemExit(f"Compile reports and package manifests disagree on {field}")
PY
}

check_proof() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

submission = json.loads(Path(sys.argv[1]).read_text())
verdict = int(sys.argv[2])
journal = bytes.fromhex(submission["journal"][2:])
context = bytes.fromhex(submission["context"][2:])
if (submission["version"] != 1 or submission["verdict"] != verdict
        or len(journal) != 234 or len(context) != 169
        or journal[:169] != context or journal[169] != verdict
        or not submission["seal"].startswith("0xe71e6620")):
    raise SystemExit("Unexpected proof version, verdict, journal, or seal selector")
PY
}

recover() {
  local attempt=$1 original=$2 recovered=$3
  "$engine" decrypt --submission "$attempt/proof.json" \
    --key-file "$attempt/release-key.hex" --out "$recovered"
  diff -qr -- "$original" "$recovered"
}

if [[ "$selection" == all || "$selection" == reconciliation ]]; then
  fixture="$engine_dir/fixtures/reconciliation"
  case_dir="$scratch/records"
  mkdir -- "$case_dir"
  compile_case "$case_dir" "$fixture/plan.json" "$fixture/reference"
  node "$engine_dir/tests/prepare-job.mjs" "$case_dir/package/manifest.json" \
    5042002 0x1111111111111111111111111111111111111111 8 \
    0x2222222222222222222222222222222222222222 >"$case_dir/job.json"
  for scenario in pass fail; do
    "$engine" prove --package "$case_dir/package" --job "$case_dir/job.json" \
      --deliverables "$fixture/$scenario" --reference "$fixture/reference" \
      --out "$case_dir/$scenario" >"$case_dir/$scenario.run.json"
    if [[ "$scenario" == pass ]]; then
      check_proof "$case_dir/pass/proof.json" 1
      recover "$case_dir/pass" "$fixture/pass" "$case_dir/recovered"
    else
      check_proof "$case_dir/fail/proof.json" 0
      if "$engine" decrypt --submission "$case_dir/fail/proof.json" \
        --key-file "$case_dir/fail/release-key.hex" --out "$case_dir/fail-recovered" \
        >"$case_dir/fail-decrypt.stdout" 2>"$case_dir/fail-decrypt.stderr"; then
        echo "Decrypt accepted a failing proof" >&2
        exit 1
      fi
      python3 - "$case_dir/fail-decrypt.stderr" <<'PY'
import json
import sys
from pathlib import Path

if json.loads(Path(sys.argv[1]).read_text())["code"] != "invalid_submission":
    raise SystemExit("Unexpected failure from decrypt")
PY
    fi
  done
fi

if [[ "$selection" == all || "$selection" == signed-text ]]; then
  case_dir="$scratch/signed"
  issuer="$engine_dir/tests/evidence-fixture.cjs"
  node "$issuer" prepare "$case_dir" ed25519/v1
  compile_case "$case_dir" "$case_dir/plan.json" "$case_dir/reference"
  node "$issuer" sign "$case_dir"
  "$engine" prove --package "$case_dir/package" --job "$case_dir/job.json" \
    --deliverables "$case_dir/delivery" --reference "$case_dir/reference" \
    --evidence "$case_dir/evidence" --out "$case_dir/pass" >"$case_dir/pass.run.json"
  check_proof "$case_dir/pass/proof.json" 1
  recover "$case_dir/pass" "$case_dir/delivery" "$case_dir/recovered"
fi

if [[ "$selection" == all || "$selection" == limits ]]; then
  case_dir="$scratch/limits"
  mkdir -p -- "$case_dir/reference" "$case_dir/delivery"
  python3 - "$case_dir" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
name = "blob.bin"
# Account for the version, file count, name length, name and content length.
payload_bytes = 16 * 1024 - (1 + 2 + 2 + len(name) + 4)
(root / "delivery" / name).write_bytes(b"\x7f" * payload_bytes)
(root / "plan.json").write_text(json.dumps({
    "version": 1,
    "deliverables": [{"name": name, "parser": "opaque/v1"}],
    "references": [],
    "rules": [{
        "op": "eq",
        "left": {"op": "file_size", "source": "deliverable", "file": name},
        "right": {"op": "literal", "type": "i64", "value": str(payload_bytes)},
    }],
}))
PY
  compile_case "$case_dir" "$case_dir/plan.json" "$case_dir/reference"
  node "$engine_dir/tests/prepare-job.mjs" "$case_dir/package/manifest.json" \
    5042002 0x1111111111111111111111111111111111111111 10 \
    0x2222222222222222222222222222222222222222 >"$case_dir/job.json"
  "$engine" prove --package "$case_dir/package" --job "$case_dir/job.json" \
    --deliverables "$case_dir/delivery" --reference "$case_dir/reference" \
    --out "$case_dir/pass" >"$case_dir/pass.run.json"
  check_proof "$case_dir/pass/proof.json" 1
  python3 - "$case_dir/pass/proof.json" <<'PY'
import json
import sys
from pathlib import Path

proof = json.loads(Path(sys.argv[1]).read_text())
if len(bytes.fromhex(proof["envelope"][2:])) != 16 * 1024 + 12 + 16:
    raise SystemExit("Expected an envelope for a 16 KiB delivery bundle")
PY
  recover "$case_dir/pass" "$case_dir/delivery" "$case_dir/recovered"
fi
