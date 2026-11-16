# Phase 1 seeded cases

Integrate `engine/guest-runtime/tests/seeded.rs` into the matching path.
The file needs no Cargo changes. The current crate already supplies its dependencies.

Source: `/Users/anishnarang/UBC-26-engine`, commit
`adda3a3c52fd8cebe594aba42d3e43f47a7baf0e`.
The source checkout remained clean. Tests ran from
`/tmp/ubc26-seeded-workspace/engine` with a separate Cargo target directory.

## Result

The final run passed all 10,000 generated cases in 9.33 seconds.
Each of 40 families supplies 250 cases. The report contains 95 input categories.
The suite covers all 23 runtime operations.

| Result | Cases |
| --- | ---: |
| Pass verdict | 4,093 |
| Fail verdict | 2,780 |
| Arithmetic overflow | 919 |
| Invalid file contents | 750 |
| Invalid lookup | 500 |
| Invalid file set | 250 |
| Invalid parameters | 250 |
| Oversized delivery bundle | 83 |
| Invalid compiler plan | 350 |
| Unsupported compiler operation | 25 |
| Oracle mismatches | 0 |

The suite uses these independent expectations:

- Arithmetic uses i128 calculations and explicit i64 range checks.
- Comparisons, Boolean rules, and key equality use native Rust values.
- Counts, sums, and quantifiers use direct calculations over generated vectors.
- Nested scope rules count records below another record.
- Invalid cases use fixed rejection categories.
- File sizes use byte lengths. Hash expectations use the SHA-256 primitive directly.

Every accepted plan runs through `check` and `check_generated`.
The latter receives lowered nodes that match the committed structure.
Both paths share the runtime evaluator. Their agreement is not the correctness oracle.
This suite does not compile emitted Rust or execute a zkVM proof.
It does not replace the evidence signature tests.

Boundary cases include i64 limits, multiplication thresholds, prefix sum overflow,
empty collections, a valid 256-row collection, invalid 257-row collections,
duplicate lookup keys, Unicode text, opaque bytes, malformed decimal strings,
invalid JSON, missing files, surplus files, rule depths 32/33, rule nodes 256/257,
and delivery bundles of 16,383/16,384/16,385 bytes.
The suite checks eager evaluation after decisive Boolean and quantifier results.

## Commands

Run from the `engine` directory:

```sh
UBC26_SEEDED_REPORT=/tmp/seeded-coverage.json cargo test -p ubc26-guest-runtime --test seeded -- --nocapture
UBC26_SEEDED_CASE=3 cargo test -p ubc26-guest-runtime --test seeded -- --nocapture
cargo clippy -p ubc26-guest-runtime --test seeded -- -D warnings
cargo fmt --all -- --check
```

All four checks passed. A single-case replay preserves its original seed.
`coverage.json` and `test.log` record the final full run.
The corpus seed is `0x55424332365f7631`. Case ID `n` uses that seed plus `n`.
The test defines SplitMix64, so it does not depend on a random crate version.

## Failure files

`UBC26_SEEDED_FAILURE_DIR` selects the output directory.
The default is `target/seeded-failures`, relative to the test process directory.
Each mismatch stores its seed, replay command, original plan, lowered plan,
delivery bundle, reference bundle, and exact parameter bytes.
For valid inputs, the reducer removes unused declarations and corresponding data.
It retains a reduction only when the same mismatch remains.
The reducer preserves rule limits and collection rows. It does not claim global minimality.

A temporary forced mismatch tested this path. The harness produced all failure files.
The reducer shortened that plan from 605 to 381 bytes in its JSON form.
Only the copied test contained the forced mismatch. The delivered source contains no injected mismatch.
The restored case replay passed. The `harness-selftest` directory contains this deliberate test output.

These cases found no production defect. They do not establish universal correctness.
