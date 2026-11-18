# Lookup guard trial, November 18

All six cases ran on `eb22e28` after exact-source commerce, engine, and contracts CI passed. See the [frozen diagnostic](../../../docs/authoring-lookup-guard-trial-2026-11-18.md).

| Case | Task ID | Outcome | Latency (ms) | API cost |
| --- | --- | --- | ---: | ---: |
| `lab-supplies-receipt-1-membership-r17` | `01M7R530RR9688XWC1NMGVB1JA` | Review ready | 9,570 | $0.009332 |
| `pier-variance-membership-r17` | `01M7R53BZ7CEYT30V2GN2WX8GJ` | Review ready after lookup normalization | 19,076 | $0.017976 |
| `clearance-1-membership-r17` | `01M7R541CXK49Z8EZH52NDWGCT` | Undeclared record field | 12,809 | $0.009393 |
| `badge-zone-1-membership-r17` | `01M7R54GXFNPDY7C1022A9GB1X` | Invalid collection operand | 13,375 | $0.015286 |
| `category-clear-1-membership-r17` | `01M7R54YWKJ7M3C23K751NM128` | False accept: duplicate line | 5,546 | $0.002742 |
| `nights-1-membership-r17` | `01M7R556ZZE696DZBKEAQDW63Q` | Oracle match, unverified quote | 11,806 | $0.012854 |

Four plans were native valid. Three matched all hidden oracle outcomes. Two also passed coverage, quotes, and both example verdicts. Lab passed with no repair or normalization. Pier's repaired raw plan used a numeric lookup directly under a top-level `all`. The service recorded the new guard normalization at `/rules/3/where` and the existing conjunction normalization at `/rules/0/where`. The selected plan matched all seven independently scored outcomes and both examples. This is one live exercise of the fix. Category still accepted a duplicate line. Nights matched the oracle but had a quote absent from the request, so the service blocked review readiness.

The six tasks used ten provider calls. All six reservations settled. The total was $0.067583. Campaign API usage is $1.181259 and median task latency was 12,307.5 ms. This cohort made no Bot dispatch, approval or Arc send.

Separately, the prior isolated `fe446c1` API restarted with all six tasks terminal. Authenticated GETs for all six saved IDs matched the original journals before and after restart. The aggregate response SHA-256 stayed `7706566afc5dcaa1cb7be8964557a3a8699ae5aecbe11163ce733767af14af63`. Its database retained six settled reservations totaling $0.070415 and zero pending tasks. This verifies terminal reads and settlement persistence. The probe sent no new task POST.

The exact pier revision compiled locally from an empty cache in 45,128 ms. Independent oracle evaluation of its model-generated positive example passed before proof work. The local synthetic proof and byte recovery run has started. It uses no funded job or Bot review.
