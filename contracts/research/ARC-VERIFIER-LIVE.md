### Live verifier evidence (read-only, captured by `script/verifier-evidence.py`)

- Verdict: **ALL CHECKS PASSED**
- Chain: Arc Testnet, chain ID 5042002; RPC `https://rpc.testnet.arc.io`
- Verifier address: [`0xCf8D70A203b40D3A17d023c0CDDF752870BC3992`](https://explorer.testnet.arc.io/address/0xCf8D70A203b40D3A17d023c0CDDF752870BC3992)
- Deploy transaction: [`0xd0fb5fb5b4e921df0ee1b0220587f59259f7175cec841a49f3262ccbf2232b6f`](https://explorer.testnet.arc.io/tx/0xd0fb5fb5b4e921df0ee1b0220587f59259f7175cec841a49f3262ccbf2232b6f) (from broadcast/ receipt)
- Deploy block: 72392474 (from the transaction receipt; the deploy script first recorded 72392473, the block it simulated against, and the manifest was corrected)
- Evidence block: 72392546 (`0xd35ff337d810542faf41eaf0ccb82cb5a671aff186364436ab4a993c8e8480c1`, timestamp 1794718454); every call below ran at this block
- Receipt: upstream `TestReceiptV3_1` (image ID `0xc92414d80cdeb43ba0f4ff4882447c21f18b547d41ffa506a84da164e8e31f7d`, journal `just a simple receipt`, 260-byte seal)

| # | Check | Result | Detail |
| --- | --- | --- | --- |
| 1 | Contract has code | PASS | 7480 bytes |
| 2 | Runtime code equals local build modulo CBOR metadata and 4 immutables | PASS | on-chain 7480 B, local 7480 B, metadata 53/53 B, 9 code ranges masked for the 4 immutables; masked sha256 c038eebfd57fd69a |
| 3 | SELECTOR() == 0xe71e6620 | PASS | 0xe71e6620 |
| 4 | VERSION() == "3.1.0" | PASS | 3.1.0 |
| 5 | BN254_CONTROL_ID() equals ControlID.sol | PASS | 0x0ac2eaf9d5ae64ffb75c4747fde32456e9ee6db3b32350cb2a0614ba91d081de |
| 6 | CONTROL_ROOT_0/1 equal the byte-reversed halves of ControlID.CONTROL_ROOT | PASS | 0x5c1fde52087b1c734aed7adb13effee6 / 0x1d553a4d183353d025f673607237b189 |
| 7 | BN254_CONTROL_ID() equals manifest | PASS | 0x0ac2eaf9d5ae64ffb75c4747fde32456e9ee6db3b32350cb2a0614ba91d081de |
| 8 | Valid receipt: eth_call verify() succeeds | PASS | returns; image ID 0xc92414d80cdeb43ba0f4ff4882447c21f18b547d41ffa506a84da164e8e31f7d, journal `just a simple receipt` |
| 9 | Flipped journal byte 0: reverts | PASS | expected VerificationFailed(), got VerificationFailed() |
| 10 | Flipped journal byte 10: reverts | PASS | expected VerificationFailed(), got VerificationFailed() |
| 11 | Flipped journal byte 20: reverts | PASS | expected VerificationFailed(), got VerificationFailed() |
| 12 | Changed image ID (low bit): reverts | PASS | expected VerificationFailed(), got VerificationFailed() |
| 13 | Flipped proof byte 4 (gas cap 3,000,000): reverts | PASS | expected VerificationFailed(), got VerificationFailed() |
| 14 | Flipped proof byte 132 (gas cap 3,000,000): reverts | PASS | expected VerificationFailed(), got VerificationFailed() |
| 15 | Flipped proof byte 259 (gas cap 3,000,000): reverts | PASS | expected VerificationFailed(), got VerificationFailed() |
| 16 | Changed selector byte 0: reverts | PASS | expected SelectorMismatch(bytes4,bytes4), got SelectorMismatch(bytes4,bytes4) |
| 17 | Changed selector byte 1: reverts | PASS | expected SelectorMismatch(bytes4,bytes4), got SelectorMismatch(bytes4,bytes4) |
| 18 | Changed selector byte 2: reverts | PASS | expected SelectorMismatch(bytes4,bytes4), got SelectorMismatch(bytes4,bytes4) |
| 19 | Changed selector byte 3: reverts | PASS | expected SelectorMismatch(bytes4,bytes4), got SelectorMismatch(bytes4,bytes4) |
| 20 | eth_estimateGas for the valid call | PASS | 267,946 gas (eth_estimateGas on a no-value call; includes the 21,000 base and calldata) |

