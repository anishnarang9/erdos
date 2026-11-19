# Authoring example gate audit, 2026-11-18

The private scorer used native validation, coverage, verified quotes, and hidden oracle outcomes. It omitted the API's `exampleApprovalReady` flag. The table adds that flag and the buyer fixture gate when fixtures exist. It uses the same saved tasks, corpus, and hidden outcomes. No task was rerun.

| Frozen trials | Tasks | Matched draft checks and oracle | Ready for buyer review |
| --- | ---: | ---: | ---: |
| Sixth (r7) | 5 | 3 | 2 |
| Independent pier (r8–r9) | 2 | 1 | 0 |
| Seventh (r10) | 5 | 4 | 2 |
| Eighth (r11) | 5 | 4 | 2 |
| Ninth (r12) | 10 | 6 | 3 |

In the ninth trial, lab, clinic, and firmware note had usable native examples. Pier, lot, and clearance matched all hidden outcomes but had zero usable passing or failing examples. The provider selected invented fixture names without buyer fixtures. Some generated pier examples also used JSON numbers for fields that require decimal strings.

The provider schema now requires generated files when the buyer supplies no fixtures. When the buyer supplies fixtures, the selection branch lists only those fixture names. The prompt shows how to encode an i64 in generated JSON. Native example checks still govern readiness. Trial results now record oracle agreement and review readiness as distinct stages.

The native compiler reports a collection body type error at the aggregate node. The repair feedback now explains the Boolean predicate requirement for category-clear, the i64 requirement for berth-fee's sum, and the collection scope rule for badge-zone. The nights brief did not state that unknown programs must reject instead of returning verdict 0. Its original frozen result remains an oracle mismatch. Any future clarification of that brief needs a new input identity.

The original journals and reports remain available. Total attributable campaign API usage is $0.777842. Review-ready here is a draft stage. Exact Bot review, buyer approval, compile, proof, settlement, and recovery still require live qualification on the release candidate.
