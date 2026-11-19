# Eighth authoring trial, 2026-11-18

The five frozen cases ran once each against isolated source `492a2c8c0ee8402a03217df95f2cd5bb03a6d2f9` after exact-source commerce, engine, and contracts CI passed. The Linux image was `sha256:99d055f638f383d99755e3f408194d201d4300bbfec59a9e30fbc7cfdd774409`, with engine SHA-256 `be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7`. The public contract corpus digest was `5a3553958b0e674fe1c0e514d39e64138549d885084ae640c25b4a281e8c35f0`. A new wallet `0xFF29934c7a5a471EA3AdDc861307d40827d34c93` authenticated to a fresh database. Hidden cases stayed outside model input.

| Case | Task ID | Draft-stage result | Model latency | API cost |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-r11` | `01M7R1KV8R0PPT4954H23CTMA3` | Pass; all 9 hidden outcomes agree | 8,775 ms | $0.008490 |
| `clinic-supplies-receipt-1-r11` | `01M7R1M99V83NYCSAE9QVTSWP2` | Pass; all 9 hidden outcomes agree | 8,819 ms | $0.004188 |
| `pier-variance-r11` | `01M7R1MREFK2GJNMFKZ8DTFM6F` | Pass; all 7 hidden outcomes agree | 16,057 ms | $0.010756 |
| `lot-expiry-1-r11` | `01M7R1NENS9M2TEPGED6APERMB` | Pass; all 7 hidden outcomes agree | 13,606 ms | $0.013164 |
| `clearance-1-r11` | `01M7R1P1XVWEQSK8V23RR7Y4T9` | Fail: `plan_invalid` | 14,615 ms | $0.010304 |

Each passing case passed native validation, coverage, verified quotes, buyer fixtures where supplied, and every hidden oracle candidate. Lot recorded normalization paths `/deliverables/0/fields/0` and `/rules/0/where`. Pier recorded `/rules/0/where`. These paths belong to the approved draft revision, not a later hidden edit.

Clearance's first reply declared reference field `required` as `i64` and used it in a numeric comparison. The service removed a redundant numeric lookup guard. The remaining draft failed its examples gate. Its repair then changed `required` to `string` while retaining a `gte` numeric comparison. Native validation rejected `/plan/rules/0/where` for a type mismatch. This is a provider plan-shape failure in the single allowed repair. Preserve the original failed task. Do not count an offline edit as a pass.

The five tasks used eight provider calls. The 50 campaign task IDs and 83 provider trace IDs are each unique. All five new reservations settled once. This cohort cost **$0.046902**. Fourth-campaign attributable API usage is now **$0.663961** against the user's $10 cap. The account-wide meter remains unavailable. No Bot review, approval, compile, proof, Arc send, or public deploy ran. General public authoring stays gated.

Protected journals and recordings are under `~/.local/share/ubc26/hosted-operator/authoring-eighth-wallet10-492/` and `~/.local/share/ubc26/hosted-operator/authoring-eighth-492a2c8/recordings/`. Next: test reference-field type correction only when actual supplied reference bytes prove one type throughout the collection. Then repeat failed and passing families on a changed source.
