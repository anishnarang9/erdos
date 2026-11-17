#!/usr/bin/env python3
"""Verify a confirmed forkless Arc deployment and write its local manifest.

This script accepts only a loopback RPC. It sends read-only JSON-RPC calls.
"""

import argparse
import json
import os
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
USDC = "0x3600000000000000000000000000000000000000"
LIVE_CORE = "0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8"
IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
ZERO_ROLE = "0x" + "0" * 64


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-url", required=True)
    parser.add_argument(
        "--artifact",
        type=Path,
        default=ROOT / "broadcast/09_DeployOpenClaimLocal.s.sol/5042002/run-latest.json",
    )
    parser.add_argument("--manifest", type=Path, default=ROOT / "deployments/open-claim-local.json")
    args = parser.parse_args()
    if urllib.parse.urlparse(args.rpc_url).hostname not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("only a loopback RPC is allowed")

    def rpc(method: str, params: list | None = None):
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
        request = urllib.request.Request(args.rpc_url, data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.load(response)
        if "error" in result:
            raise RuntimeError(f"{method}: {result['error']}")
        return result["result"]

    cast = os.environ.get("ARC_CAST", "cast")

    def call(address: str, signature: str, *values: str) -> str:
        result = subprocess.run(
            [cast, "call", address, signature, *values, "--rpc-url", args.rpc_url],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip().split(" ")[0].strip('"')

    assert int(rpc("eth_chainId"), 16) == 5_042_002
    assert int(rpc("eth_blockNumber"), 16) < 10_000
    assert rpc("eth_getCode", [LIVE_CORE, "latest"]) == "0x"
    assert call(USDC, "decimals()(uint8)") == "6"
    assert call(USDC, "name()(string)") == "USDC"

    artifact = json.loads(args.artifact.read_text())
    transactions = artifact["transactions"]
    assert len(transactions) == len(artifact["receipts"]) == 6
    assert [tx["contractName"] for tx in transactions[:4]] == [
        "RiscZeroGroth16Verifier", "AgenticCommerce", "ERC1967Proxy", "OpenClaimAdapter"
    ]
    deployer = transactions[0]["transaction"]["from"]
    addresses = {tx["contractName"]: tx["contractAddress"] for tx in transactions[:4]}
    receipts = []
    for tx in transactions:
        receipt = rpc("eth_getTransactionReceipt", [tx["hash"]])
        assert receipt is not None and receipt["status"] == "0x1"
        assert receipt["transactionHash"].lower() == tx["hash"].lower()
        receipts.append({"hash": tx["hash"], "block": int(receipt["blockNumber"], 16), "status": "success"})

    code_hashes = {}
    for name, address in addresses.items():
        assert rpc("eth_getCode", [address, "latest"]) != "0x"
        code_hashes[name] = rpc("eth_getProof", [address, [], "latest"])["codeHash"]

    core = addresses["ERC1967Proxy"]
    adapter = addresses["OpenClaimAdapter"]
    verifier = addresses["RiscZeroGroth16Verifier"]
    implementation = addresses["AgenticCommerce"]
    for actual, expected in (
        (call(adapter, "core()(address)"), core),
        (call(adapter, "verifier()(address)"), verifier),
        (call(adapter, "usdc()(address)"), USDC),
        (call(core, "paymentToken()(address)"), USDC),
    ):
        assert actual.lower() == expected.lower()
    assert call(core, "platformFeeBP()(uint256)") == "0"
    assert call(core, "evaluatorFeeBP()(uint256)") == "0"
    assert call(adapter, "MAX_ENVELOPE_BYTES()(uint256)") == "16412"
    assert call(adapter, "MIN_EXPIRY_MARGIN()(uint256)") == "600"
    assert call(verifier, "SELECTOR()(bytes4)").lower() == "0xe71e6620"
    assert call(verifier, "VERSION()(string)") == "3.1.0"
    assert call(verifier, "BN254_CONTROL_ID()(bytes32)").lower() == transactions[0]["arguments"][1].lower()
    admin_role = call(core, "ADMIN_ROLE()(bytes32)")
    assert call(core, "hasRole(bytes32,address)(bool)", admin_role, deployer) == "false"
    assert call(core, "hasRole(bytes32,address)(bool)", ZERO_ROLE, deployer) == "false"
    assert rpc("eth_getStorageAt", [core, IMPLEMENTATION_SLOT, "latest"])[-40:].lower() == implementation[2:].lower()

    manifest = {
        "schemaVersion": 1,
        "interfaceVersion": "open-claim-v1",
        "network": "local-arc",
        "status": "deployed-verified-local-only",
        "chainId": 5_042_002,
        "usdc": {"address": USDC, "decimals": 6},
        "core": {"address": core, "implementation": implementation, "platformFeeBP": 0, "evaluatorFeeBP": 0},
        "verifier": {"address": verifier, "version": "3.1.0", "selector": "0xe71e6620"},
        "adapter": {"address": adapter, "abi": "abi/OpenClaimAdapter.json"},
        "runtimeCodeHashes": code_hashes,
        "deployer": deployer,
        "receipts": receipts,
        "evidence": "Confirmed on a forkless loopback Arc node. No live Arc transaction or wallet.",
    }
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"status": manifest["status"], "adapter": adapter, "receipts": len(receipts)}))


if __name__ == "__main__":
    main()
