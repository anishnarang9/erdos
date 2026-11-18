# Clearance reference type replay, 2026-11-18

The original paid `clearance-1-r11` task `01M7R1P1XVWEQSK8V23RR7Y4T9` remains failed. Its retained second provider plan declared `posts.json` field `required` as `string` while using that lookup directly in a numeric `gte` comparison. The supplied reference bytes contain only canonical signed `i64` decimal strings for that field: `"2"` and `"4"`.

The new normalization changes a declared reference field from `string` to `i64` only when a numeric comparison reads its lookup, every supplied row has a valid signed `i64` value, and no lookup of that field has another use. It records the path in the exact draft revision. It does not change buyer files or infer types from field names.

The offline replay of the retained second plan recorded `/references/0/collections/0/fields/1/type`. The pinned engine accepted the normalized plan. The independent scorer returned seven exact matches: two valid passes, three rule failures, and two input rejections, including unknown-post rejection. This is diagnostic replay, not a new model success or complete job.

Three new regression cases passed. Full `commerce/pnpm check` passed: SDK 535 plus 13 Arc fixtures, API 1,065, web 4, worker 1,051, and all typechecks. No paid call, Bot review, Arc send, or public deploy used this candidate. Fourth-campaign attributable API usage remains $0.663961. Next: build an isolated source-locked image, freeze a changed-source cohort, and measure fresh reliability. General public authoring stays gated.
