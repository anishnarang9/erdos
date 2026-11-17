# Gas measurements for `submit` (S15)

Owner: track T4 (tests). Source: `contracts/test/settlement/Wire.t.sol` (`test_S15_*`).
Date: 2026-11-14. Toolchain: `arc-forge` v0.8.0 in WSL2, solc 0.8.28, evm cancun, optimizer off (the compiler settings of Circle's core).

Command:

```text
wsl -e bash -lc "cd '/mnt/c/Users/nslep/Desktop/VS Code Projects/UBC-26/contracts' && arc-forge test --skip 'script/*' --match-path 'test/settlement/Wire.t.sol' --match-test S15 -vv"
```

Method: `gasleft()` delta around one `core.submit(...)` call through the ERC1967 proxy (patched core, hook, `MockRiscZeroVerifier`), with calldata prepared before the measurement. The measurement covers the core, both hook callbacks (`beforeAction` with `sha256` of the envelope and the 234-byte journal, `afterAction` storage writes) and the verifier call. It excludes the 21,000 base transaction cost and the per-byte calldata cost, both of which Foundry does not include in an in-contract `gasleft()` delta.

| Envelope size | `submit` gas, mock verifier |
| --- | --- |
| 256 B | 95,415 |
| 1 KiB (typical) | 97,090 |
| 8 KiB | 115,849 |
| 16,412 B (`MAX_ENVELOPE_BYTES`, team cap) | 142,927 |

Envelope size costs about 2.9 gas per byte (16,384 B measured 142,810 before the cap moved to 16,412) in execution (`sha256` over the envelope plus memory expansion and the `abi.decode` copies).

## Real verifier estimate

The mock verifier does almost no work. The real Groth16 verifier measured 242,548 gas for one valid `verify` call (external call including overhead, `test/verifier/Groth16Verifier.t.sol`). A reasonable execution total for a typical 1 KiB `submit` is therefore about 97,090 + 242,548, roughly 340,000 gas. At the 16,412-byte cap it is 142,927 + 242,548 = 385,475 gas. This is an estimate that adds two separate measurements. It is not a measured end-to-end figure. The end-to-end figure needs the real verifier plus a real receipt and is UNVERIFIED until the engine delivers one (see the "Real receipts" gate in SETTLEMENT-IMPLEMENTATION.md Section 11).

## Full `submit` at the cap, including calldata

The cap is 16,412 bytes. Derivation: 16,384-byte delivery bundle + 12-byte nonce + 16-byte Poly1305 tag. `ZKVM-IMPLEMENTATION.md` confirms the envelope layout `nonce[12] || ciphertext || tag[16]` and a 16 KiB ceiling on the encoded delivery bundle, so the arithmetic is consistent. UNVERIFIED derivation, value set by the team.

Calldata length of `submit(uint256 jobId, bytes32 deliverable, bytes optParams)` with `optParams = abi.encode(envelope, seal, keyCommitment)`, envelope 16,412 B, seal 260 B (the same arithmetic as `calldataLength` in `contracts/examples/preflight.ts`):

| Part | Bytes |
| --- | --- |
| selector | 4 |
| `jobId`, `deliverable`, `optParams` offset, `optParams` length | 4 x 32 = 128 |
| `optParams` head (3 words) | 96 |
| envelope: length word + 16,412 padded to 16,416 | 16,448 |
| seal: length word + 260 padded to 288 | 320 |
| `optParams` total (96 + 16,448 + 320 = 16,864, already a multiple of 32) | 16,864 |
| **Total calldata** | **16,996** |

Arc charges the EIP-7623 floor (R4): 21,000 + 40 gas per non-zero byte (10 per zero byte). Pricing all 16,996 bytes as non-zero gives an upper bound of 21,000 + 40 x 16,996 = **700,840 gas**. The ABI padding and head words contain roughly 280 zero bytes, so a real submit is about 8,000 gas lower (approximate, not measured).

Execution path for comparison: 21,000 + 4 x (4 x 16,996 tokens = 67,984) = 271,936 standard calldata gas + 385,475 execution = about 678,400 gas. That is below the floor, so **the calldata floor wins and the expected total is about 700,000 gas (upper bound 700,840)**, not 385,000. Calldata dominates at the cap.

Cost at the 20 gwei floor: 700,840 x 20 gwei = 0.014017 USDC (about 0.0138 USDC after the zero-byte discount). Typical 1 KiB submit: execution about 340,000 plus standard calldata, roughly 0.007 to 0.008 USDC. The R4 `eth_estimateGas` figure for a 16 KiB payload is about 1 percent above the exact floor, so size a gas limit from the formula plus margin. `submitGasLimit` in `contracts/examples/preflight.ts` uses calldata floor plus a 1,000,000 execution allowance: 21,000 + 40 x 16,996 + 1,000,000 = 1,700,840 at the cap, comfortably above the ~700,000 needed and far below the 16.78M per-transaction cap (R4). Note that a tampered seal burns the whole allowance, so the most a bad submit can cost at the cap is about 1,700,840 gas (0.034 USDC at 20 gwei).

## Cap decision

Execution plus the real verifier stays far below the 30M Arc block gas limit at 16,412 bytes. S15 confirms `MAX_ENVELOPE_BYTES = 16412` from the contract side: an envelope of 16,412 bytes is accepted (`test_S15_envelopeAtCapAccepted`) and one of 16,413 bytes reverts and leaves the job Funded (`test_S15_envelopeOverCapReverts`). The cap is set by the team at 16,412; the engine's largest real delivery still has to be measured against it.

## Observation about a tampered real seal

From the verifier track: a tampered Groth16 seal can burn nearly all forwarded gas, because the precompile call fails and consumes everything forwarded to it (about 3M of a 3M cap in their test). A failed `submit` with a bad real seal can therefore cost the Solver most of the transaction gas limit, not a few hundred thousand. Clients should simulate with `eth_call` before sending, and any real-verifier test of a bad seal needs an explicit gas cap.
