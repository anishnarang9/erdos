# Fourth campaign: varied authoring cohort result

**Source:** `fc2e71706bd529c04063f66cb725ed27fdd60f89` in the isolated local API image. The 13 briefs were frozen in [the cohort plan](../../../docs/authoring-fourth-breadth-cohort-2026-11-18.md) before dispatch. The corpus digest was `8acf192a48f3c72a200a53ed628246a2fbdcbe339bcc4743253a7789d85f2cd7`. A third wallet produced 13 unique tasks and provider traces. The service database has 19 unique settled tasks across three wallets, with no unsettled reservation.

The cohort made 22 model calls, including nine repair calls. Its exact settled API charge was 129,806 micro-USD ($0.129806). The fourth campaign's cumulative unique API charge is 311,105 micro-USD ($0.311105). Median task latency was 10,669 ms and maximum latency was 20,650 ms. No Bot review, approval, Arc transaction, or public deployment ran. The public API stayed on its accepted release.

## Frozen results and adjudication

The private harness first marked all 13 tasks failed. That raw result remains in each protected journal. The harness incorrectly required `buyerFixtureApprovalReady === true` even when a brief supplied **no** buyer fixtures. Offline adjudication changes only the interpretation of `mass-1` and `firmware-1`: both had native-valid plans, full coverage, verified quotes, and exact agreement with every hidden oracle candidate. They are **two draft-stage passes**, not complete jobs. The private harness now applies the fixture gate only when fixtures exist. No task was rerun or result rewritten.

| Frozen case | Outcome at draft stage | Cause or missing requirement |
| --- | --- | --- |
| `pier-variance` | Fail | Native-valid plan rejected two valid hidden outputs and three rule-failing outputs. Five oracle status disagreements. |
| `lot-expiry-1` | Fail | Repaired plan still had an invalid output collection declaration. |
| `category-1` | Clarification, not a draft | Asked for the output JSON schema and asked how to resolve a contradictory instruction in the buyer brief. See corpus audit below. |
| `clearance-1` | Fail | Repaired plan still had an invalid output collection declaration. |
| `instrument-1` | Clarification, not a draft | Asked for the output JSON schema. See corpus audit below. |
| `berth-fit-1` | Fail | Repaired plan omitted `right` from a rule predicate. |
| `mass-1` | Draft-stage pass after harness correction | Native, coverage, quotes, and all hidden oracle candidates passed. |
| `seal-1` | Fail | Repaired plan declared an invalid artifact binding in its evidence profile. |
| `firmware-1` | Draft-stage pass after harness correction | Native, coverage, quotes, and all hidden oracle candidates passed. |
| `hq-ambiguous-1` | Partial clarification | Asked for the fee rule but omitted the currency unit. |
| `hq-ambiguous-10` | Partial clarification | Asked for a preferred channel and possible values, but did not distinguish `stable` from `beta` as required by the frozen facets. |
| `hq-unsupported-2` | Wrong decision | Asked for ratio details instead of naming missing `div` capability. |
| `hq-unsupported-8` | Unsupported, strict score fail | Explained that SHA3-256 is unavailable, but did not use the engine capability name `sha3_256`. It made no payable draft. Semantically, the unsupported decision was correct. |

**Counts:** supported draft-stage passes 2/9 after harness adjudication; valid clarifications 0/2 under frozen facets; exact unsupported decisions 0/2, with one semantically correct decision; five oracle disagreements in one supported case; complete Bot-to-proof successes 0/13. Bot decisions, package builds, and proofs in this cohort were zero. The separate [model-authored lab proof](model-authored-lab-local-proof-2026-11-18.json) compiled, proved, decrypted, and passed the independent oracle under a synthetic context. It does not complete this cohort or establish Arc funding.

## Corpus and scoring defect

The frozen `category-1` brief says both to enforce a budget and to ignore it. The brief does not declare the `rows` collection of its output JSON and supplies no public example. `instrument-1` also lacks an output schema and public example. The system prompt tells the model to ask for missing output schema instead of inventing it. Thus, a clarification in these two cases can be appropriate even though the frozen corpus labels them supported. A deterministic audit found that 30 of 42 supported briefs omit at least the output collection name `rows` from the prose. Public examples repair that gap for some cases, but most have no public examples. Do not use the raw 2/9 rate as an unbiased measure of model reliability until the corpus supplies a complete public output contract or scores valid schema questions separately.

The `hq-unsupported-8` scorer checks a literal engine identifier. It rejects the standard human spelling `SHA3-256`. Keep the frozen strict failure, and report the semantically correct unsupported decision separately. Do not change the saved outcome after seeing the result.

The next qualification input needs a new frozen corpus revision. Publish explicit output schemas or distinct positive and negative examples for supported cases. Resolve contradictory briefs before scoring them as supported. Keep hidden oracle candidates and expected outcomes outside model and Bot inputs. Run local checks before another paid cohort. General public authoring remains gated.
