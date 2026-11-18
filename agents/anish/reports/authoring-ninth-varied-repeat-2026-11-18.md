# Ninth varied authoring trial, 2026-11-18

**Example gate audit:** Six drafts matched the original draft checks and oracle. Three also had usable examples and were ready for buyer review. The [audit](authoring-example-gate-audit-2026-11-18.md) records the corrected stage counts.

Ten frozen supported briefs ran once each against isolated source `086fbae20d5ef5b873081eb00f653324971d5785` after exact-source commerce, engine, and contracts CI passed. The Linux image was `sha256:bda57c43b9a19a2ac2e291ef5d9f5c39f2dd4a1e0b4a7adc440d6c21d91aa352`, with engine SHA-256 `be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7`. The output-contract corpus digest was `5a3553958b0e674fe1c0e514d39e64138549d885084ae640c25b4a281e8c35f0`. New wallet `0x9e378B5Bd5eB6E4691d8301Bbe69BF35E461a37D` authenticated to a fresh database. Hidden candidates stayed outside model input.

| Case | Task ID | Draft-stage result | Model latency | API cost |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-r12` | `01M7R2BG07RT2C07YFXD44V1Y9` | Pass | 8,124 ms | $0.004055 |
| `clinic-supplies-receipt-1-r12` | `01M7R2BSS28ET1BV1BD1JCSJ9X` | Pass | 8,035 ms | $0.008621 |
| `pier-variance-r12` | `01M7R2C3E7C1FC3F4A55ZEW8TV` | Pass | 17,657 ms | $0.016201 |
| `lot-expiry-1-r12` | `01M7R2D2VQZ2Z1PP4PFZ9EY4JH` | Pass | 12,857 ms | $0.010280 |
| `clearance-1-r12` | `01M7R2DJJBBYXEC9JNBPE4JYM2` | Pass | 11,750 ms | $0.013658 |
| `badge-zone-1-r12` | `01M7R2E0NK7YSNX2EEEFFG7D61` | Fail: `plan_invalid` record scope | 15,539 ms | $0.015848 |
| `nights-1-r12` | `01M7R2EP2AQ1BVADKCJYG4R8JM` | Fail: hidden oracle disagreement | 8,613 ms | $0.007019 |
| `category-clear-1-r12` | `01M7R2F15R3S9PFTCMF1J2FXK6` | Fail: `plan_invalid` collection type | 15,501 ms | $0.014448 |
| `firmware-note-1-r12` | `01M7R2FJ8G4B9JC2DRB2ZA1KKT` | Pass | 7,408 ms | $0.011153 |
| `berth-fee-1-r12` | `01M7R2G10ZYJ8J60B3AVV4TCZZ` | Fail: unnecessary clarification | 11,749 ms | $0.012598 |

Six of ten tasks passed native validation, coverage, verified quotes, buyer fixtures where supplied, and every independent hidden oracle candidate. Badge-zone failed after repair because a record field was outside its collection scope. Category-clear failed after repair because a collection expression had the wrong type. Nights produced a native-valid draft, but it returned rule failure for an unknown program; the independent oracle requires input rejection. Berth-fee asked for three data types already represented in the supplied reference values. This was not a valid clarification under the frozen expected outcome. Preserve all four failures.

The ten tasks used 17 provider calls. Across the campaign, 60 task IDs and 100 provider trace IDs are unique. All ten new reservations settled once. This cohort cost **$0.113881**. Fourth-campaign attributable API usage is now **$0.777842** against the user's $10 cap. Median model latency was 11,749.5 ms. The account-wide meter remains unavailable.

This cohort had zero complete Bot-to-proof successes, zero valid clarifications, zero correct unsupported decisions, one oracle disagreement, two plan-invalid results, one unnecessary clarification, zero Bot decisions, zero compile or proof attempts, and zero Arc sends. The accepted public release and general authoring gate remain unchanged. Protected journals are under `~/.local/share/ubc26/hosted-operator/authoring-ninth-wallet11-086/`.

Next: inspect the four retained failed provider replies and their public references. Fix only source-grounded causes with regressions. Then freeze a changed-source varied cohort. One six-of-ten draft result does not meet release readiness.
