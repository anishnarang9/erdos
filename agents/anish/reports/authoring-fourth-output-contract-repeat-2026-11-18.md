# Fourth campaign: output-contract repeat result

The nine cases in the [frozen repeat](../../../docs/authoring-fourth-output-contract-repeat-2026-11-18.md) ran once each through isolated API image source `fc2e71706bd529c04063f66cb725ed27fdd60f89`. The new public corpus digest was `5a3553958b0e674fe1c0e514d39e64138549d885084ae640c25b4a281e8c35f0`. A fourth wallet produced nine new task IDs and provider traces. The service database now has 28 unique tasks and 28 settled reservations across four wallets, with no unsettled reservation. The exact source CI passed commerce, engine, and contracts checks. The local commerce check passed on rerun after one timing-sensitive API test failed under concurrent load.

The nine tasks used 18 model calls, including one repair for each task. Their settled API charge was 104,980 micro-USD ($0.104980). The fourth campaign's cumulative unique API charge is 416,085 micro-USD ($0.416085). Median task latency was 15,129 ms and maximum latency was 22,546 ms. No Bot review, approval, compile, proof, Arc send, or public deployment ran for this cohort. The separate model-authored lab synthetic proof remains separate evidence.

| Case | Frozen draft-stage outcome | Diagnostic |
| --- | --- | --- |
| `pier-variance-r5` | Fail | Native-valid plan returned `fail` for an unknown drawer. Independent oracle requires input `reject`. |
| `lot-expiry-1-r5` | Fail | Native-valid plan returned `fail` for an unknown lot. Independent oracle requires input `reject`. |
| `category-clear-1-r5` | Fail | Repaired plan still declared an invalid output collection. |
| `clearance-1-r5` | Fail | Native-valid plan rejected one valid output, accepted a low-clearance output, and returned `fail` for an unknown post instead of `reject`. |
| `instrument-1-r5` | Fail | Repaired plan compared operands of different types. |
| `berth-fit-1-r5` | Fail | Repaired plan referred to an undeclared field inside a nested predicate. |
| `mass-1-r5` | Draft-stage pass | Native, coverage, quotes, and every hidden oracle candidate agreed. |
| `seal-1-r5` | Fail | Repaired plan declared an invalid artifact binding in its evidence profile. |
| `firmware-1-r5` | Draft-stage pass | Native, coverage, quotes, and every hidden oracle candidate agreed. |

**Counts:** two draft-stage passes, four invalid plans, three oracle-disagreement cases with five disagreeing candidates, and zero complete Bot-to-proof jobs. The same two brief families passed in the earlier cohort. The changed public output contracts did not make the other seven reliable. All original journals remain in protected local storage and were not rerun to replace failures.

The current prompt says to use nested `all`/`any` for reference membership and to avoid `lookup`. That yields a rule failure for an unknown key. The oracle treats an unknown reference key as invalid input, which must reject. A later prompt candidate should distinguish those outcomes: use `lookup` when missing keys must reject, and use `all`/`any` when absence is a normal failing rule. Verify this distinction with a native engine regression before another paid cohort. The four invalid-plan cases also need targeted diagnosis. General public authoring remains gated.
