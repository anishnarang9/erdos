#!/usr/bin/env python3
"""Post-deploy evidence for the pinned RISC Zero Groth16 verifier on Arc Testnet (read-only).

Run after `01_DeployVerifier.s.sol --broadcast` (see research/ARC-VERIFIER.md). It sends only
`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getCode`, `eth_call` and
`eth_estimateGas`. It never signs or sends a transaction and never touches a key.

What it checks
  1. Chain ID equals config/arc-testnet.json `chainId` (5042002), else abort.
  2. The verifier address (env SETTLEMENT_VERIFIER, else the manifest
     deployments/arc-testnet.json `.contracts.verifier.address`) has code.
  3. Runtime code equals the local build of RiscZeroGroth16Verifier modulo (a) the trailing CBOR
     metadata and (b) the four immutable slots (CONTROL_ROOT_0, CONTROL_ROOT_1, BN254_CONTROL_ID,
     SELECTOR). Those immutables are baked into the runtime code at construction, so a plain
     comparison with the artifact can never match; they are masked in both and then checked by
     calling the public getters against the pinned values in ControlID.sol and the manifest.
  4. SELECTOR() == 0xe71e6620 and VERSION() == "3.1.0".
  5. eth_call verify(...) with the upstream TestReceiptV3_1 receipt succeeds, and each altered input
     reverts with the expected error: flipped journal byte (digest recomputed), changed image ID,
     flipped proof byte (explicit 3,000,000 gas cap; a tampered curve point burns all forwarded
     gas), changed selector byte.
  6. eth_estimateGas for the valid call.

Output: a Markdown evidence block on stdout; `--out FILE` also writes it to FILE. Exit status 0
only if every check passed.

Usage (from contracts/):
  python3 script/verifier-evidence.py [--address 0x..] [--rpc URL] [--out research/ARC-VERIFIER-LIVE.md]
"""
import argparse, glob, hashlib, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
GAS_CAP = 3_000_000

# Selectors (computed with `arc-cast sig`).
SIG_VERIFY = "ab750e75"            # verify(bytes,bytes32,bytes32)
SIG_SELECTOR = "053c238d"          # SELECTOR()
SIG_VERSION = "ffa1ad74"           # VERSION()
SIG_BN254 = "258038e2"             # BN254_CONTROL_ID()
SIG_ROOT0 = "9181e4b1"             # CONTROL_ROOT_0()
SIG_ROOT1 = "8989fa2e"             # CONTROL_ROOT_1()
ERR_VERIFICATION_FAILED = "439cc0cd"   # VerificationFailed()
ERR_SELECTOR_MISMATCH = "b8b38d4c"     # SelectorMismatch(bytes4,bytes4)


class RpcRevert(Exception):
    def __init__(self, data, message):
        super().__init__(message)
        self.data = data or "0x"
        self.message = message


def rpc(url, method, params):
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "ubc26-verifier-evidence/1"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    if "error" in out:
        err = out["error"]
        data = err.get("data")
        if isinstance(data, dict):
            data = data.get("data")
        raise RpcRevert(data if isinstance(data, str) else "0x", err.get("message", str(err)))
    return out["result"]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def hx(b):
    return "0x" + bytes(b).hex()


def unhex(s):
    s = s[2:] if s.startswith("0x") else s
    return bytes.fromhex(s)


def abi_verify(seal, image_id, digest):
    pad = (-len(seal)) % 32
    return unhex(SIG_VERIFY) + (0x60).to_bytes(32, "big") + image_id + digest + len(seal).to_bytes(32, "big") + seal + b"\0" * pad


def strip_metadata(code):
    n = int.from_bytes(code[-2:], "big")
    if n + 2 >= len(code):
        raise SystemExit(f"bad CBOR metadata length {n} for code of {len(code)} bytes")
    return code[: -(n + 2)], n + 2


def mask(code, refs):
    code = bytearray(code)
    for r in refs:
        code[r["start"]: r["start"] + r["length"]] = b"\0" * r["length"]
    return bytes(code)


def load_receipt():
    src = read(os.path.join(ROOT, "test", "verifier", "TestReceiptV3_1.sol"))
    def grab(name):
        m = re.search(r"\b" + name + r"\s*=\s*hex\"([0-9a-fA-F]+)\"", src)
        if not m:
            raise SystemExit(f"could not parse {name} from TestReceiptV3_1.sol")
        return bytes.fromhex(m.group(1))
    return grab("SEAL"), grab("JOURNAL"), grab("IMAGE_ID")


def load_control_ids():
    src = read(os.path.join(ROOT, "src", "verifier", "groth16", "ControlID.sol"))
    def grab(name):
        m = re.search(name + r"\s*=\s*hex\"([0-9a-fA-F]{64})\"", src)
        if not m:
            raise SystemExit(f"could not parse {name} from ControlID.sol")
        return bytes.fromhex(m.group(1))
    return grab("CONTROL_ROOT"), grab("BN254_CONTROL_ID")


def find_deploy_tx(manifest):
    v = manifest.get("contracts", {}).get("verifier", {})
    for k in ("deployTx", "deployTxHash", "txHash"):
        if v.get(k):
            return v[k], "manifest"
    for path in glob.glob(os.path.join(ROOT, "broadcast", "01_DeployVerifier.s.sol", "5042002", "run-latest.json")):
        try:
            j = json.loads(read(path))
            for t in j.get("transactions", []):
                if t.get("contractName") == "RiscZeroGroth16Verifier" or t.get("transactionType") == "CREATE":
                    return t.get("hash"), "broadcast/ receipt"
        except Exception:
            pass
    return None, None


def call_ok(url, to, data, block, gas=None):
    tx = {"to": to, "data": hx(data)}
    if gas:
        tx["gas"] = hex(gas)
    return rpc(url, "eth_call", [tx, block])


def classify_revert(r):
    d = r.data
    if d.startswith("0x" + ERR_VERIFICATION_FAILED):
        return "VerificationFailed()"
    if d.startswith("0x" + ERR_SELECTOR_MISMATCH):
        return "SelectorMismatch(bytes4,bytes4)"
    return f"other revert: {d[:74]} ({r.message})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", help="verifier address (default: env SETTLEMENT_VERIFIER, else manifest)")
    ap.add_argument("--rpc", help="RPC URL (default: config rpcUrl)")
    ap.add_argument("--manifest", default=os.path.join(ROOT, "deployments", "arc-testnet.json"))
    ap.add_argument("--artifact", default=os.path.join(ROOT, "out", "RiscZeroGroth16Verifier.sol", "RiscZeroGroth16Verifier.json"))
    ap.add_argument("--out", help="also write the Markdown block to this file")
    a = ap.parse_args()

    cfg = json.loads(read(os.path.join(ROOT, "config", "arc-testnet.json")))
    url = a.rpc or cfg["rpcUrl"]
    explorer = cfg["explorerUrl"]
    manifest = json.loads(read(a.manifest)) if os.path.exists(a.manifest) else {}
    addr = a.address or os.environ.get("SETTLEMENT_VERIFIER") or manifest.get("contracts", {}).get("verifier", {}).get("address")
    if not addr:
        raise SystemExit("no verifier address: deploy step 01 first, or set SETTLEMENT_VERIFIER / --address")
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", addr):
        raise SystemExit(f"not an address: {addr}")

    chain_id = int(rpc(url, "eth_chainId", []), 16)
    if chain_id != cfg["chainId"]:
        raise SystemExit(f"abort: chain ID {chain_id} != configured {cfg['chainId']}")

    # Pin everything to one block so the evidence is internally consistent.
    head = int(rpc(url, "eth_blockNumber", []), 16)
    block = hex(head)
    blk = rpc(url, "eth_getBlockByNumber", [block, False])
    results = []  # (name, passed, detail)

    def record(name, ok, detail):
        results.append((name, bool(ok), detail))

    onchain = unhex(rpc(url, "eth_getCode", [addr, block]))
    record("Contract has code", len(onchain) > 0, f"{len(onchain)} bytes")
    if not onchain:
        raise SystemExit(f"no code at {addr} at block {head}: is the deploy confirmed?")

    # Code comparison modulo metadata and immutable slots.
    if os.path.exists(a.artifact):
        art = json.loads(read(a.artifact))
        local = unhex(art["deployedBytecode"]["object"])
        refs = [r for lst in art["deployedBytecode"].get("immutableReferences", {}).values() for r in lst]
        on_body, on_meta = strip_metadata(onchain)
        lo_body, lo_meta = strip_metadata(local)
        same_len = len(onchain) == len(local)
        same = same_len and mask(on_body, refs) == mask(lo_body, refs)
        record("Runtime code equals local build modulo CBOR metadata and 4 immutables", same,
               f"on-chain {len(onchain)} B, local {len(local)} B, metadata {on_meta}/{lo_meta} B, "
               f"{len(refs)} code ranges masked for the 4 immutables; masked sha256 {hashlib.sha256(mask(on_body, refs)).hexdigest()[:16]}")
    else:
        record("Runtime code equals local build modulo CBOR metadata and 4 immutables", False,
               f"artifact {a.artifact} missing; run `arc-forge build --network arc` first")

    # Immutables via getters, against pinned ControlID.sol and the manifest.
    root, bn254 = load_control_ids()
    try:
        sel = call_ok(url, addr, unhex(SIG_SELECTOR), block)
        ver = call_ok(url, addr, unhex(SIG_VERSION), block)
        bn = call_ok(url, addr, unhex(SIG_BN254), block)
        r0 = call_ok(url, addr, unhex(SIG_ROOT0), block)
        r1 = call_ok(url, addr, unhex(SIG_ROOT1), block)
    except RpcRevert as e:
        for n, ok, d in results:
            print(f"{'PASS' if ok else 'FAIL'}: {n} ({d})", file=sys.stderr)
        raise SystemExit(f"FAIL: {addr} does not expose the verifier getters ({e.message}); not a RiscZeroGroth16Verifier")
    # VERSION() returns an ABI string: offset, length, data.
    vb = unhex(ver)
    version = vb[64: 64 + int.from_bytes(vb[32:64], "big")].decode()
    record("SELECTOR() == 0xe71e6620", unhex(sel)[:4] == bytes.fromhex("e71e6620"), sel[:10])
    record('VERSION() == "3.1.0"', version == "3.1.0", version)
    record("BN254_CONTROL_ID() equals ControlID.sol", unhex(bn) == bn254, bn)
    # splitDigest(): the whole 32-byte root is byte-reversed, then split into two 16-byte halves
    # (CONTROL_ROOT_0 = reversed[16:32], CONTROL_ROOT_1 = reversed[0:16]), i.e. each half of the
    # root reversed on its own.
    record("CONTROL_ROOT_0/1 equal the byte-reversed halves of ControlID.CONTROL_ROOT",
           unhex(r0)[:16] == root[:16][::-1] and unhex(r1)[:16] == root[16:][::-1],
           f"{r0[:34]} / {r1[:34]}")
    man = manifest.get("contracts", {}).get("verifier", {})
    if man.get("bn254ControlId"):
        record("BN254_CONTROL_ID() equals manifest", unhex(bn) == unhex(man["bn254ControlId"]), man["bn254ControlId"])

    # Receipt and altered inputs.
    seal, journal, image_id = load_receipt()
    digest = hashlib.sha256(journal).digest()

    def try_call(seal_, image_, digest_, gas=None):
        try:
            call_ok(url, addr, abi_verify(seal_, image_, digest_), block, gas)
            return "returns"
        except RpcRevert as e:
            return classify_revert(e)

    out = try_call(seal, image_id, digest)
    record("Valid receipt: eth_call verify() succeeds", out == "returns",
           f"{out}; image ID {hx(image_id)}, journal `{journal.decode()}`")

    cases = []
    jpos = [0, len(journal) // 2, len(journal) - 1]
    for i in jpos:
        m = bytearray(journal); m[i] ^= 1
        cases.append((f"Flipped journal byte {i}", seal, image_id, hashlib.sha256(bytes(m)).digest(), None, "VerificationFailed()"))
    cases.append(("Changed image ID (low bit)", seal, image_id[:-1] + bytes([image_id[-1] ^ 1]), digest, None, "VerificationFailed()"))
    for i in (4, 132, 259):
        s = bytearray(seal); s[i] ^= 1
        cases.append((f"Flipped proof byte {i} (gas cap {GAS_CAP:,})", bytes(s), image_id, digest, GAS_CAP, "VerificationFailed()"))
    for i in range(4):
        s = bytearray(seal); s[i] ^= 1
        cases.append((f"Changed selector byte {i}", bytes(s), image_id, digest, None, "SelectorMismatch(bytes4,bytes4)"))
    for name, s, img, dg, gas, expect in cases:
        got = try_call(s, img, dg, gas)
        record(f"{name}: reverts", got == expect, f"expected {expect}, got {got}")

    # Gas for the valid call.
    gas_detail, gas_ok = "", False
    try:
        est = int(rpc(url, "eth_estimateGas", [{"to": addr, "data": hx(abi_verify(seal, image_id, digest))}, block]), 16)
        gas_ok, gas_detail = True, f"{est:,} gas (eth_estimateGas on a no-value call; includes the 21,000 base and calldata)"
    except RpcRevert as e:
        gas_detail = f"estimate failed: {e.message}"
    record("eth_estimateGas for the valid call", gas_ok, gas_detail)

    tx, tx_src = find_deploy_tx(manifest)
    all_ok = all(ok for _, ok, _ in results)

    md = []
    md.append("### Live verifier evidence (read-only, captured by `script/verifier-evidence.py`)\n")
    md.append(f"- Verdict: **{'ALL CHECKS PASSED' if all_ok else 'FAILED, see table'}**")
    md.append(f"- Chain: Arc Testnet, chain ID {chain_id}; RPC `{url}`")
    md.append(f"- Verifier address: [`{addr}`]({explorer}/address/{addr})")
    if tx:
        md.append(f"- Deploy transaction: [`{tx}`]({explorer}/tx/{tx}) (from {tx_src})")
    else:
        md.append("- Deploy transaction: not recorded in the manifest or `broadcast/` (find it on the explorer address page)")
    if man.get("deployBlock"):
        md.append(f"- Deploy block (manifest): {man['deployBlock']}")
    md.append(f"- Evidence block: {head} (`{blk.get('hash')}`, timestamp {int(blk['timestamp'], 16)}); every call below ran at this block")
    md.append(f"- Receipt: upstream `TestReceiptV3_1` (image ID `{hx(image_id)}`, journal `{journal.decode()}`, 260-byte seal)")
    md.append("")
    md.append("| # | Check | Result | Detail |")
    md.append("| --- | --- | --- | --- |")
    for n, (name, ok, detail) in enumerate(results, 1):
        md.append(f"| {n} | {name} | {'PASS' if ok else 'FAIL'} | {detail} |")
    md.append("")
    text = "\n".join(md) + "\n"
    print(text)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {a.out}", file=sys.stderr)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
