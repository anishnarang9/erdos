# Authoring pilot failure classification

**2026-11-18, Anish.** This is a read-only classification of retained attempts. It does not repair or rerun any case. The first campaign used source `dbfd0781b997d52c4bea50cb13303dc7bfe576a1`. The second campaign used source `fc3ea3eca7f6bc1a5dd7ac3ddfa82c6d29effc6f` and stopped after its first failure.

## First campaign: ten failed cases

| Case | Draft task | Provider trace | Settled API charge | Failure class and evidence | Cause confidence |
| --- | --- | --- | ---: | --- | --- |
| `pier-drawers` | `01M7QC5Q64BG3347YNAF8C0MZY` | `d383c298-1422-900e-92bd-07d555e817ff` | $0.006521 | `invalid_reply`. The copied xAI Console trace has valid outer JSON. Its `planJson` text has an extra closing brace at character 1777. The adapter could not parse the inner plan. | High for this case only. |
| `lot-range-1` | `01M7QC8BBERTMG92N0W0GEFXWN` | `d270ecc5-0eaa-996f-8c6e-cdcafa4e9199` | $0.006519 | Native `plan_invalid` at `/plan/rules/0`: operand types differ. The raw plan compares Boolean `unique` with numeric `count`. The API returned `unsupported`, but the brief belongs to the supported corpus. | High. |
| `category-1` | `01M7QC9W339AXWYP9T7S4RKM7J` | `7f3765a4-6c2c-9b38-9780-f5eb32668108` | $0.007279 | `invalid_reply` before native validation. The retained database records the adapter result and trace ID, but no raw provider body. The exact parse or schema defect is unknown. | High for class; unknown for exact cause. |
| `badge-zone-1` | `01M7QCB6F7HJVC674QR2HSRS0A` | `c485925d-1fd5-9a44-9a5a-aaf99c622485` | $0.006365 | Native `plan_invalid` at `/plan/deliverables/0/collections/0`. The raw plan declares `rows` both as a scalar file field and as a collection. The API returned `unsupported` for a supported brief. | High. |
| `nights-1` | `01M7QCCJ79NGS5AHYWMMQWTZT6` | `65b401e4-0a23-9d64-9d99-1011f174a747` | $0.007042 | Native `plan_invalid` at `/plan/deliverables/0/collections/0`. The raw plan declares `rows` both as a scalar file field and as a collection. The API returned `unsupported` for a supported brief. | High. |
| `berth-fit-1` | `01M7QCDR9ZFMVCEA1P7391TKE3` | `4fe33a63-7d84-92fc-a743-2e51194c005a` | $0.006979 | `invalid_reply` before native validation. The retained database records the adapter result and trace ID, but no raw provider body. The exact parse or schema defect is unknown. | High for class; unknown for exact cause. |
| `route-1` | `01M7QCF25F5MS8H3NXGNQYB3S1` | `5e658edc-18a7-96dd-a765-9a1b89a0cbe5` | $0.009629 | `invalid_reply` before native validation. The retained database records the adapter result and trace ID, but no raw provider body. The exact parse or schema defect is unknown. | High for class; unknown for exact cause. |
| `dilution-1` | `01M7QCGFGNTFYHRTBCKSKTYA0G` | `906a39ac-da3e-998c-95e3-75184d9698a3` | $0.007047 | `invalid_reply` before native validation. The retained database records the adapter result and trace ID, but no raw provider body. The exact parse or schema defect is unknown. | High for class; unknown for exact cause. |
| `firmware-note-1` | `01M7QCHK5HFE882C16GFZAHNNZ` | `65fb5782-24fc-9595-8033-de246a9f7a37` | $0.001956 | Draft, native oracle, and exact Bot review passed. Queued compile task `01M7QCJ917PTXGMS0V06HTG2YQ` failed with `engine_failed/build_failure`. The isolated state lacked `tmp` and `cache`. A separate direct compile worked after creating them. The original attempt stays failed. | High for setup cause; direct compile does not establish queued success. |
| `hq-ambiguous-7` | `01M7QCMESWMGV251AXCSPBSXA6` | `3ad6dbae-6b63-9f41-89b9-e84ac3963523` | $0.004192 | The model returned `unsupported`, saying “reasonable” toll is subjective. The buyer can supply a toll table and currency unit. The required result was a clarification that asks for both. | High. |

The first campaign had **zero complete successes**, one Bot pass, one queued compile failure, and no Arc transaction. Its ten settled API charges total **$0.063529**. The shared Grok Bot meter moved by about $0.06 during its one Bot review, but it has no exact per-review bill. The first campaign's conservative upper bound was $0.233529. These are separate measures; do not add them as exact cost.

## Second campaign: first case failed, then stopped

| Case | Draft task | Provider trace | Settled API charge | Failure class and evidence | Cause confidence |
| --- | --- | --- | ---: | --- | --- |
| `pier-drawers` | `01M7QESVMQR1869QNVPXYVJ2BW` | `53f51c2e-22d4-9ce4-baf9-d024241cfbad` | $0.006600 | The structured reply parsed, then native validation returned `plan_invalid` at `/plan/rules/2/where/where/right/left`. Inside a nested `all`/`any`, the model reversed inner and outer `record_field` levels. It also typed integer decimal-string fields as `string` and invented a `closeout` scalar field in `drawers.json`. | High for retained raw plan and compiler rule. |

The second campaign made one paid draft and no Bot request, approval, compile, proof, or Arc transaction. Its after meter was unchanged at $0.89 additional usage and $4.27 credit balance. The task settled $0.006600 in API charges; the conservative upper bound from two rounded meter reads is $0.026600. The [second-campaign failure record](authoring-round2-first-failure-2026-11-18.json) has the timestamps and source pins. The remaining nine cases were not attempted.

## Evidence and limits

- The [first campaign report](ten-case-authoring-pilot-2026-11-18.json) preserves task IDs, charge amounts, Bot and compile states, and original verdicts. Protected journals and the isolated `service.db` remain under `~/.local/share/ubc26/hosted-operator/ten-case-pilot/` and `/srv/ubc26-state/pilot-ten-dbfd078/`. Read-only queries of `drafts.result_json` gave provider trace IDs and the three native error paths.
- The first `pier-drawers` provider log is preserved as protected `provider-invalid-pier.rtf`. Four other `invalid_reply` provider bodies have not been copied. Their exact failures remain unknown. Do not infer that the first case's extra brace caused all five errors.
- The second campaign's protected journal is under `~/.local/share/ubc26/hosted-operator/ten-case-pilot-round2/`. Read-only inspection of its retained plan supplied the scope and field diagnosis.
- No case proved a genuine engine capability limit. The three first-campaign `plan_invalid` results and the second-campaign failure are malformed model plans. The ambiguous case needed buyer facts. This does not prove that the engine supports every desired real task.
- Keep both campaigns failed. A later prompt or parser change cannot turn these saved attempts into passes.
