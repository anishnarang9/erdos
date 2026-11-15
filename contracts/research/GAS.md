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
| 16,384 B (`MAX_ENVELOPE_BYTES`) | 142,810 |

Envelope size costs about 2.9 gas per byte in execution (`sha256` over the envelope plus memory expansion and the `abi.decode` copies).

## Real verifier estimate

The mock verifier does almost no work. The real Groth16 verifier measured 242,548 gas for one valid `verify` call (external call including overhead, `test/verifier/Groth16Verifier.t.sol`). A reasonable total for a typical 1 KiB `submit` is therefore about 97,000 + 242,500, roughly 340,000 gas. At the 16 KiB cap it is about 385,000 gas. This is an estimate that adds two separate measurements. It is not a measured end-to-end figure. The end-to-end figure needs the real verifier plus a real receipt and is UNVERIFIED until the engine delivers one (see the "Real receipts" gate in SETTLEMENT-IMPLEMENTATION.md Section 11).

Calldata, not execution, is the larger cost at the cap. At 16 gas per non-zero byte, a 16 KiB envelope costs about 262,000 gas in calldata, plus 260 bytes of seal. Task R4 (`eth_estimateGas` with 16 KiB calldata on Arc and any transaction size limit) is UNVERIFIED here.

## Cap decision

Execution plus the real verifier stays far below the 30M Arc block gas limit at 16,384 bytes. S15 confirms `MAX_ENVELOPE_BYTES = 16384` from the contract side: an envelope of 16,384 bytes is accepted (`test_S15_envelopeAtCapAccepted`) and one of 16,385 bytes reverts and leaves the job Funded (`test_S15_envelopeOverCapReverts`). The cap stays at 16384 pending the R4 calldata measurement on Arc and the engine's largest real delivery.

## Observation about a tampered real seal

From the verifier track: a tampered Groth16 seal can burn nearly all forwarded gas, because the precompile call fails and consumes everything forwarded to it (about 3M of a 3M cap in their test). A failed `submit` with a bad real seal can therefore cost the Solver most of the transaction gas limit, not a few hundred thousand. Clients should simulate with `eth_call` before sending, and any real-verifier test of a bad seal needs an explicit gas cap.
