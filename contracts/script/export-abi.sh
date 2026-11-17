#!/usr/bin/env bash
# Export the ABIs that the commerce client needs into contracts/abi/*.json.
#
# Run from anywhere inside WSL (needs arc-forge on PATH):
#   wsl -e bash -lc "cd '/mnt/c/Users/<you>/Desktop/VS Code Projects/UBC-26/contracts' && bash script/export-abi.sh"
#
# Every contract is addressed by file path and name, because two contracts are called
# `AgenticCommerce`: the pristine reference copy (src/core/src/AgenticCommerce.sol) and the patched
# core that we deploy (src/core/src/AgenticCommercePatched.sol). Only the patched one is exported.
# The script fails if the exported core ABI is missing a function or event the client depends on.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p abi

FORGE_BIN="${ARC_FORGE:-arc-forge}"
"$FORGE_BIN" build >/dev/null

# <output file>:<source path>:<contract name>
TARGETS=(
  "OpenClaimAdapter:src/OpenClaimAdapter.sol:OpenClaimAdapter"
  "SettlementHook:src/SettlementHook.sol:SettlementHook"
  "AgenticCommerce:src/core/src/AgenticCommercePatched.sol:AgenticCommerce"
  "IRiscZeroVerifier:src/verifier/IRiscZeroVerifier.sol:IRiscZeroVerifier"
  "RiscZeroGroth16Verifier:src/verifier/groth16/RiscZeroGroth16Verifier.sol:RiscZeroGroth16Verifier"
)

for t in "${TARGETS[@]}"; do
  name="${t%%:*}"
  rest="${t#*:}"
  "$FORGE_BIN" inspect "$rest" abi --json | python3 -c '
import json, sys
abi = json.load(sys.stdin)
assert isinstance(abi, list) and abi, "empty ABI"
json.dump(abi, sys.stdout, indent=2)
sys.stdout.write("\n")
' > "abi/${name}.json.tmp"
  mv "abi/${name}.json.tmp" "abi/${name}.json"
  echo "wrote abi/${name}.json"
done

# Keep the SDK's checked-in ABI byte-identical to the contract export.
cp abi/OpenClaimAdapter.json ../commerce/sdk/src/chain/arc/abi/OpenClaimAdapter.json

python3 - <<'PY'
import json
def names(path, kind):
    return {x["name"] for x in json.load(open(path)) if x["type"] == kind}

core_fn = names("abi/AgenticCommerce.json", "function")
core_ev = names("abi/AgenticCommerce.json", "event")
hook_fn = names("abi/SettlementHook.json", "function")
hook_ev = names("abi/SettlementHook.json", "event")
open_fn = names("abi/OpenClaimAdapter.json", "function")
open_ev = names("abi/OpenClaimAdapter.json", "event")

need = [
    (core_fn, {"createJob", "setBudget", "fund", "submit", "claimRefund", "getJob", "jobs", "paymentToken"}),
    (core_ev, {"JobCreated", "BudgetSet", "JobFunded", "JobSubmitted", "JobCompleted",
               "PaymentReleased", "Refunded", "JobExpired"}),
    (hook_fn, {"release", "terms", "submissions", "released", "contextOf", "expectedJournal",
               "MAX_ENVELOPE_BYTES", "MIN_EXPIRY_MARGIN", "supportsInterface"}),
    (hook_ev, {"TermsFrozen", "ProofAccepted", "KeyReleased"}),
    (open_fn, {"register", "claim", "release", "contextOf", "expectedJournal", "terms", "submissions", "released"}),
    (open_ev, {"TermsRegistered", "ClaimAccepted", "KeyReleased"}),
]
for have, want in need:
    missing = want - have
    assert not missing, f"ABI is missing {sorted(missing)}"

# The patched core only differs from the pristine one in setBudget's check, which is not visible in
# the ABI, so assert the build we exported really is the patched file.
import os
assert os.path.exists("out/AgenticCommercePatched.sol/AgenticCommerce.json"), "patched artifact missing"
print("ABI sanity checks passed")
PY
