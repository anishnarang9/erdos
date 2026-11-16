#!/usr/bin/env python3
"""Provenance check (S1): compare the locally compiled, unpatched Circle AgenticCommerce
runtime bytecode with the on-chain runtime bytecode of Circle's implementation.

Read-only: uses eth_chainId and eth_getCode (and nothing else) against the RPC.

Method
  1. Load `deployedBytecode.object` and `immutableReferences` from the forge artifact
     (default: out/AgenticCommerce.sol/AgenticCommerce.json, i.e. the pristine copy).
  2. Fetch on-chain runtime code with eth_getCode.
  3. Strip the CBOR metadata tail from both: the last 2 bytes give the CBOR length L;
     the tail is the last L+2 bytes.
  4. Zero every immutable reference range (start, length) in both. Immutables differ per
     deployment (UUPS `__self` = the implementation's own address). Report the value found
     on-chain in each masked range and check it equals the implementation address.
  5. Compare the remaining bytes. Exit 0 on match, 1 on mismatch (prints first diffs).

Usage: python3 script/provenance.py [--artifact PATH] [--address 0x..] [--rpc URL]
"""
import argparse, json, os, sys, urllib.request

EXPECTED_CHAIN_ID = 5042002
DEFAULT_RPC = "https://rpc.testnet.arc.io"
DEFAULT_ADDR = "0xA316fd02827242D537F84730F8a37D0BA5fd351a"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ARTIFACT = os.path.join(HERE, "..", "out", "AgenticCommerce.sol", "AgenticCommerce.json")


def rpc(url, method, params):
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "ubc26-provenance/1"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    if "error" in out:
        raise SystemExit(f"RPC error for {method}: {out['error']}")
    return out["result"]


def strip_metadata(code: bytes):
    n = int.from_bytes(code[-2:], "big")
    if n + 2 > len(code):
        raise SystemExit(f"bad CBOR length {n} for code of {len(code)} bytes")
    return code[: -(n + 2)], code[-(n + 2):]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifact", default=DEFAULT_ARTIFACT)
    ap.add_argument("--address", default=DEFAULT_ADDR)
    ap.add_argument("--rpc", default=DEFAULT_RPC)
    a = ap.parse_args()

    chain_id = int(rpc(a.rpc, "eth_chainId", []), 16)
    if chain_id != EXPECTED_CHAIN_ID:
        raise SystemExit(f"abort: chain id {chain_id} != {EXPECTED_CHAIN_ID}")

    art = json.load(open(a.artifact))
    local = bytes.fromhex(art["deployedBytecode"]["object"].removeprefix("0x"))
    refs = art["deployedBytecode"].get("immutableReferences", {})
    chain = bytes.fromhex(rpc(a.rpc, "eth_getCode", [a.address, "latest"]).removeprefix("0x"))
    if not chain:
        raise SystemExit("abort: no code at address")

    print(f"chain id            {chain_id}")
    print(f"artifact            {os.path.normpath(a.artifact)}")
    print(f"local runtime len   {len(local)}")
    print(f"on-chain runtime len {len(chain)}")

    local_b, local_meta = strip_metadata(local)
    chain_b, chain_meta = strip_metadata(chain)
    print(f"metadata tail len   local {len(local_meta)} / chain {len(chain_meta)} (stripped)")
    print(f"body len            local {len(local_b)} / chain {len(chain_b)}")

    ranges = sorted((r["start"], r["length"]) for lst in refs.values() for r in lst)
    print(f"immutable ranges    {ranges}")
    addr32 = bytes.fromhex(a.address.removeprefix("0x").lower().rjust(64, "0"))
    ok = True
    lb, cb = bytearray(local_b), bytearray(chain_b)
    for start, length in ranges:
        if start + length > len(cb):
            print(f"  range {start}+{length} outside body"); ok = False; continue
        val = bytes(cb[start:start + length])
        expect = addr32[-length:]
        note = "== implementation address" if val == expect else "!= implementation address"
        print(f"  on-chain value at {start}+{length}: 0x{val.hex()} ({note})")
        lb[start:start + length] = b"\0" * length
        cb[start:start + length] = b"\0" * length

    if len(lb) != len(cb):
        print("MISMATCH: body lengths differ"); ok = False
    else:
        diffs = [i for i in range(len(lb)) if lb[i] != cb[i]]
        if diffs:
            ok = False
            print(f"MISMATCH: {len(diffs)} differing bytes; first offsets {diffs[:20]}")
            i = diffs[0]
            print(f"  local {bytes(lb[i:i+32]).hex()}\n  chain {bytes(cb[i:i+32]).hex()}")
    print("RESULT:", "MATCH (modulo metadata and immutables)" if ok else "DIFFERENT")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
