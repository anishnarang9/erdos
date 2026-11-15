# Phase 1 challenge corpus

This corpus contains 60 authored natural-language challenges:

| Classification | Count | Expected authoring action |
| --- | ---: | --- |
| Supported | 40 | Produce a typed plan for buyer review |
| Ambiguous | 10 | Ask for the missing policy values |
| Unsupported | 10 | Identify the missing catalog primitive |

The supported set contains 341 candidate deliveries. Every stated acceptance requirement has an isolated counterexample. Input rejection cases also cover wrong types, unknown reference keys, missing files, checked overflow, collection bounds, invalid signatures, and replayed evidence.

All data and signing keys are synthetic. This corpus does not establish production readiness or model authoring accuracy.

## Commands

Use Node 22 or later. The scripts need only Node built-in modules.

```sh
node --test engine/evaluation/challenges.test.mjs
node engine/evaluation/generate-challenges.mjs generate /tmp/ubc26-phase1-suite
```

Use a new output directory for each run. The generator does not remove old files.

The generator writes `suite.json`, challenge prompts, typed plans, reference files, candidate deliveries, and unsupported draft plans. It creates empty evidence directories. The runner signs evidence after it constructs the exact job context.

## Supported families

| Family | Challenges | Candidates | Domain checks |
| --- | ---: | ---: | --- |
| Expenses and budgets | 7 | 77 | Nonempty claims, unique IDs, nonnegative amounts, total cap, item cap, approval |
| Ledger reconciliation | 7 | 56 | Unique IDs, exact row count, exact keyed amounts, exact report text |
| Inventory | 7 | 56 | Unique SKUs, catalog coverage, per-SKU minimum and maximum, storage cap |
| Allocation and scheduling | 7 | 56 | One shift per worker, allowed shift IDs, coverage of both shifts, cost cap |
| File hash and size | 6 | 42 | Exact artifact hash, appendix byte range, package label |
| Signed evidence and bindings | 6 | 54 | Pinned signer, artifact binding, context binding, score threshold, issuer label, approval |

The generator uses six semantic templates. The file family varies the artifact parser among opaque bytes, UTF-8 text, and JSON. The normalizer therefore produces eight structure shapes. Values, labels, and domain data vary within each family. Threshold edits remain runtime parameters.

The scheduling cases check feasibility. They do not claim optimality. The ledger and inventory rules combine unique keys, exact counts, and reference membership to require complete coverage.

The file cases keep the hashed artifact separate from the size-limited appendix. This permits isolated failures for hash, lower size, and upper size requirements. Hashes cover exact bytes, including JSON whitespace and text newlines. The opaque fixtures include non-UTF-8 bytes.

The signed cases use Ed25519 only. They cover different signed policies and mutations. Existing engine tests cover the other signature profiles. This corpus does not replace those tests.

## Generator API

`buildChallenges()` returns all challenge definitions with candidate and reference file bytes.

`writeChallengeSuite(outputDirectory)` writes the corpus. It returns the same manifest that it saves in `suite.json`.

Supported challenge records include:

- `family`, `classification`, `prompt`, and `requirements`.
- `plan`, `planPath`, `referencePath`, `inputTypes`, and `supportedOperations`.
- `templateId` and a domain `oracle` specification.
- Candidate paths and expected outcomes.

Each candidate has `expected.status` as `pass`, `fail`, or `reject`. A passing verdict is `1`. A failing verdict is `0`. Rejection has no verdict. `violatedRequirements` identifies the intended isolated failure. Extra rejection IDs describe input or reference errors.

Ambiguous records include concrete clarification questions. They contain no invented typed plan. Unsupported records include the requested capability and a deliberately unsupported draft. The unsupported label applies to the named primitive in the current catalog. It does not rule out external preprocessing or a separately approved formulation.

## Evidence preparation

Import the helper after the runner validates the plan and constructs a 169-byte version-1 context:

```js
import {writeCandidateEvidence} from './generate-challenges.mjs';

await writeCandidateEvidence(challenge, candidate, candidateDirectory, contextHex);
```

Or use the CLI:

```sh
node engine/evaluation/generate-challenges.mjs sign \
  /tmp/ubc26-phase1-suite signed-1 valid CONTEXT_HEX
```

The helper uses the same test-only Ed25519 seed and domain prefix as `engine/tests/evidence-fixture.cjs`. It avoids that helper's package layout and private-key file requirements. It signs the exact payload bytes with Node crypto. It does not read private keys from the environment.

Re-sign each candidate for its context. The replay candidate deliberately signs a different context hash. The swapped-artifact candidate retains the original artifact hash. The low-score and policy failures retain valid signatures.

## Independent reference oracle

```js
import {evaluateCandidate} from './reference-oracle.mjs';

const expected = await evaluateCandidate(challenge, candidateDirectory, {
  referenceDirectory,
  contextHex,
});
```

The oracle reads actual candidate and reference files. It checks the domain requirements directly. It does not interpret the plan rules, import engine code, run an engine command, or inspect the expected candidate label.

The oracle uses `BigInt` for integer values and checked i64 sums. It checks declared scalar types, collection bounds, exact file sets, byte limits, and UTF-8 parsing. Node crypto independently verifies signatures and hashes.

The oracle covers these generated inputs. It is not a second implementation of every engine parser rule. In particular, its JSON parser does not reject duplicate object keys. The generated corpus contains no duplicate JSON keys. Engine parser tests remain necessary.

## Scope and limits

These are authored cases, not randomly sampled production requests. Related challenges share templates. Do not treat all 40 supported cases as independent samples of arbitrary requirement translation.

The deterministic tests check the corpus structure, every candidate expectation, isolated violations, output generation, and oracle sensitivity to changed bytes. They also check the generator through a symbolic link.

This module does not call a model, build a guest, produce a proof, contact Arc, or test settlement. The evaluation runner must compare engine host and guest outcomes against this oracle. It must report model authoring results separately.
