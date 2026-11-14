#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output=$(cargo +1.98.1 run --locked --release -- execute)
python3 -c '
import json, sys
out = json.loads(sys.argv[1])
assert out["journal"] == "0x55424332362f70726f6f662d736d6f6b652f7631"
assert len(bytes.fromhex(out["imageId"][2:])) == 32
assert "seal" not in out
' "$output"
