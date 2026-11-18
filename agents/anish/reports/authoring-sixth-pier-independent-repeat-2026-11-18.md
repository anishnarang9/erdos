# Independent pier draft repeat, 2026-11-18

The two frozen trials used API source `193564bcf873ecd42fba04865cf4d4ea26a3a8b7`, Linux image `sha256:bbc78d8d41a348df0602ca2244d92b2d310a0ae96264d6fbc3f6aab106debc8b`, and public contract corpus digest `5a3553958b0e674fe1c0e514d39e64138549d885084ae640c25b4a281e8c35f0`. Each trial used a separate new authenticated wallet and journal. Neither task ID nor any of the four provider trace IDs matched the 38 prior tasks and their traces. Hidden candidates stayed outside the model input.

| Case | Wallet | Task ID | Result | Native and oracle | Provider calls | API cost | Model latency |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| `pier-variance-r8` | `0x172b891Fa731839f915C837a1333018e05723fD9` | `01M7R08VDVFZDV3NFTQ3JG732G` | Draft-stage pass | Native valid; all seven hidden outcomes match | 2 | $0.012914 | 18,714 ms |
| `pier-variance-r9` | `0x6fD17a667eDe4b378a18c8a9e674a9553d0DDfEb` | `01M7R0ABYY94RNQGKRYXW6HG32` | Draft-stage fail: `plan_invalid` | `/plan/rules/0/where`: operand types mismatch | 2 | $0.014045 | 17,074 ms |

The first `r9` plan used a field from the wrong record scope. The repair input named the exact undeclared field path. The repaired plan then placed an `i64` lookup directly under Boolean `and`. This is a second native type error. The saved `r9` result remains failed. It must not be counted as a pass after a source fix or replay.

Both tasks reached a terminal state. Both reservations settled once. This repeat spent $0.026959. Fourth-campaign unique API cost is now **$0.561945** against the user's $10 testing cap. No uncertain charge remains in these trials. The account-wide meter is unavailable, so this figure is attributable API usage, not an account balance.

Across the three independent `pier-variance` tasks on this source, two passed the draft gate and one failed. This is insufficient for general authoring readiness. These trials used no Bot review, approval, compile, proof, Arc transaction, or public deployment. The accepted public API remains unchanged.

Protected journals and provider recordings remain under `~/.local/share/ubc26/hosted-operator/`. They hold the raw failed result and identity evidence. Next: add targeted native repair feedback for numeric lookups in Boolean positions, test it offline against this saved plan, and freeze a changed-source trial before any new paid request.
