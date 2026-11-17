# Authoring input review

This review reads commits `8407bd0`, `9e70e51`, and `a963b2d` on branch `codex/hosted-backend`. Hosted-backend HEAD during this review is `7d46e8d`. The authoring files match those commits at that HEAD. This review did not edit that tree.

## Defect

The production engine adapter drops example evidence and context.

`commerce/api/src/authoring.ts` lines 550-554 build an eval input from the resolved example. The input carries the decoded deliverables. It adds evidence when the example includes evidence. It adds context when the example has context. Line 554 passes that object to `deps.engine.eval`.

`commerce/api/src/engine.ts` line 70 types `eval` with plan, deliverables, and reference only. Lines 542-549 read those three fields. The child argv is `eval`, `--plan`, `--deliverables`, and `--reference`.

A local stub returned `{"verdict":1}` and exit 0. The call also passed evidence file `custody.json` and a version-1 context. The argv had no `--evidence` flag and no `--job` flag. The adapter returned `{ok:true, verdict:1}`.

A fixture context or signature that would make `engine eval` reject never reaches the child. `usableExamples` can count the stub-style verdict 1 when the prediction is 1.

The handler test records the object given to a substitute `eval`. That test does not spawn `cliEngine`. Public mode uses `cliEngine` through `engineFromConfig`.

## Reproduction

Call `cliEngine` with a local executable and no public pin. The executable writes its arguments, prints `{"verdict":1}`, and exits 0.

Pass plan `{version:1}`. Pass deliverable `result.json` with bytes `{"ok":true}`. Pass an empty reference list. Pass evidence `custody.json` with bytes `{"signed":"public-example"}`. Pass context `0x01` and then 336 hex characters.

On 2026-11-16 the result was `{ok:true, verdict:1}`. The flags were `eval`, `--plan`, `--deliverables`, and `--reference`.

## Other items

No other concrete issue.

Opaque bytes use canonical base64, `byteLength`, and SHA-256 of the same file bytes. `draftProviderPayload` serializes `referenceFiles` and `exampleFixtures`. One added fixture moved `draftCallTokenBound` from 5233 to 5848. The body contained the fixture base64 and the reference identity fields.

`exampleFiles` accepts one evidence file at encoded size 32768. One extra content byte throws `Request validation failed`. The 16-file cap and the 16384-byte file cap follow the same encoded-size formula. `resolveExample` copies the named request fixture, including its evidence bytes and context. `resolveExample` rejects a different predicted verdict.

One disagreeing example sets `blocked` true beside one verdict 1 and one verdict 0. The repair path runs one extra model call. Clarification and unsupported responses carry `qualification` with model, prompt version, catalog version, repair count, trace ids, and usage.

Public approval compares the stored owner, draft id, and revision hash. It rejects a draft whose `exampleApprovalReady` is not true. It also rejects a quote that was not found. `quoteFound` searches the request and UTF-8 reference text. Opaque base64 is not text.

`ruleCoverageComplete` remains false. The coordinator already records that closed approval gate. Buyer example submission and the request deadline remain open work.

The child output decoder is separate for stdout and stderr. The compiler child receives named path, temp, cache, and CA values. This review found no new path or credential leak.

This review ran no guest compilation, proof, model call, RPC, wallet action, or container.
