# Seventh authoring trial, 2026-11-18

The five frozen cases ran once each against isolated source `d0b6b97f881d5a38ff014c062c4e981448ed73f0` after its commerce, engine, and contracts CI passed. The Linux image was `sha256:8a8d1a0951eb2896683009457072739d16308009726fc29cdbf96c8486ecfb97`, with engine SHA-256 `be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7`. The public contract corpus digest was `5a3553958b0e674fe1c0e514d39e64138549d885084ae640c25b4a281e8c35f0`. A new wallet `0x4c1f8ca1Dc39b9fd1F2Bcd50d5ba763ab4bd5bBC` authenticated to a fresh database. Hidden candidates were private to the scorer.

| Case | Task ID | Draft-stage result | Hidden oracle | Model latency | API cost |
| --- | --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-r10` | `01M7R0W5FYH4DXPK3MKZAHNZ14` | Pass | 9/9 agree | 10,260 ms | $0.007818 |
| `clinic-supplies-receipt-1-r10` | `01M7R0WMD8NENP69GKWZHB1ZPB` | Pass | 9/9 agree | 10,977 ms | $0.008824 |
| `pier-variance-r10` | `01M7R0X4P16QR41R0VK743A5AV` | Pass after example repair | 7/7 agree | 22,731 ms | $0.013602 |
| `lot-expiry-1-r10` | `01M7R0Y1K0RMVVMMXVSR8J7QEY` | Fail: `plan_invalid` | No valid plan | 16,609 ms | $0.015139 |
| `clearance-1-r10` | `01M7R0YR4A5TAX4YBANW3D2HR9` | Pass after type repair | 7/7 agree | 14,073 ms | $0.009731 |

Each passing case passed native validation, coverage, verified quotes, buyer fixtures where supplied, and every hidden oracle candidate. The first lot plan put an `i64` lookup under Boolean `and`. The repair request carried the new precise hint at `/plan/rules/2/where`. The second plan retained the same error at `/plan/rules/0/where`. Preserve this original failure. Clearance's first plan had the same shape; its repair request carried the hint, and its second plan passed. This shows the hint reached both repairs. The differing outcomes do not prove the hint caused clearance's success.

The five tasks used nine provider calls. Task IDs and all provider trace IDs are distinct from the 40 prior unique campaign tasks and from one another. All five reservations settled once. This cohort cost **$0.055114**. Fourth-campaign attributable API usage is now **$0.617059** under the user's $10 cap. The account-wide meter remains unavailable, so this is not an account balance.

This cohort has four draft-stage passes and one failure. There were zero complete Bot-to-proof successes, zero Bot decisions, zero compiles or proofs, and zero Arc sends. The accepted public release and general authoring gate remain unchanged. Protected journals and provider recordings are under `~/.local/share/ubc26/hosted-operator/authoring-seventh-wallet9-d0/` and `~/.local/share/ubc26/hosted-operator/authoring-seventh-d0b6b97/recordings/`.

Next: test a narrow, semantics-preserving removal of a redundant lookup operand offline. The other Boolean branch must compare the same lookup, so a missing key still rejects. Do not count the retained lot failure as a pass. Then test repeat reliability on a changed source before any release proposal.
