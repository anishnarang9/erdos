#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
engine_path=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
scratch=$(mktemp -d)
trap 'test -d "$scratch" && python3 -c "import shutil, sys; shutil.rmtree(sys.argv[1])" "$scratch"' EXIT
mkdir "$scratch/reference" "$scratch/delivery"

printf '%s\n' '{"totalCents":"9400","markedComplete":true}' > "$scratch/delivery/expense-report.json"
"$engine_path" compile --plan fixtures/expense-report-plan.json --reference "$scratch/reference" --out "$scratch/package"
python3 - "$scratch" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
manifest = json.loads((root / "package" / "manifest.json").read_text())
context = (
    bytes([1])
    + (5042002).to_bytes(32, "big")
    + bytes.fromhex("11" * 20)
    + (7).to_bytes(32, "big")
    + bytes.fromhex("22" * 20)
    + bytes.fromhex(manifest["rulesHash"][2:])
    + bytes.fromhex(manifest["referenceHash"][2:])
)
(root / "job.json").write_text(json.dumps({
    "imageId": manifest["imageId"],
    "context": "0x" + context.hex(),
}))
PY
"$engine_path" prove --package "$scratch/package" --job "$scratch/job.json" --deliverables "$scratch/delivery" --reference "$scratch/reference" --out "$scratch/attempt"
"$engine_path" decrypt --submission "$scratch/attempt/proof.json" --key-file "$scratch/attempt/release-key.hex" --out "$scratch/recovered"
cmp "$scratch/delivery/expense-report.json" "$scratch/recovered/expense-report.json"
if [[ $# -ge 2 ]]; then
  cp "$scratch/attempt/proof.json" "$2"
fi
if [[ "${CHECK_FAILING_VERDICT:-0}" == 1 ]]; then
  printf '%s\n' '{"totalCents":"10400","markedComplete":true}' > "$scratch/delivery/expense-report.json"
  "$engine_path" prove --package "$scratch/package" --job "$scratch/job.json" --deliverables "$scratch/delivery" --reference "$scratch/reference" --out "$scratch/failing"
  python3 - "$scratch/failing/proof.json" <<'PY'
import json
import sys
from pathlib import Path

submission = json.loads(Path(sys.argv[1]).read_text())
assert submission["verdict"] == 0
assert bytes.fromhex(submission["journal"][2:])[169] == 0
assert submission["seal"].startswith("0xe71e6620")
PY
  if [[ $# -ge 3 ]]; then
    cp "$scratch/failing/proof.json" "$3"
  fi
fi
