# Complete authoring input and examples

Status: implemented and checked locally through 2026-11-17. Paid qualification remains pending. It adds authoring adapters for existing engine features. It adds no compiler, guest, signature profile or verifier capability.

## Why this adapter is needed

The initial API review found twenty corpus envelopes without output declarations, one opaque-reference gap, four missing public-key inputs and an evaluator that omitted evidence/context. Those input and transport gaps are now repaired. Native host/oracle agreement does not close these authoring gaps. See [the envelope review](../agents/anish/reports/hosted-authoring-envelope-review-2026-11-16.json).

Keep all predicates, hidden candidates and thresholds. Complete the public request metadata before freezing the next corpus digest. Record every input correction. Do not relabel a required engine-supported case to hide an adapter limitation.

## Full references

The public draft request keeps `references:[{name,contentBase64}]`. Preserve those exact decoded bytes in the job and its reference commitment. UTF-8 references keep their full text in model input. For other bytes, give the model an explicit base64 representation with name, encoding, byte length and SHA-256. Keep the complete permitted content. Reject oversize input before dispatch.

Computed byte length and SHA-256 describe byte identity. They do not establish document, image or model semantics. Use the existing opaque/hash/size rules when the request concerns bytes. Ask for clarification or return unsupported when the request needs an unavailable semantic parser or external truth. Do not present a textual summary as inspected binary content.

## Explicit example files

Use one bounded file representation for generated examples and buyer-supplied fixtures:

```ts
type ExampleFile = {
  name: string;
  content: string;
  encoding?: "utf8" | "base64"; // Default: utf8 for legacy local fixtures.
};
type ExampleFixture = {
  name: string;
  predictedVerdict: 0 | 1;
  files: ExampleFile[];
  evidence?: ExampleFile[];
  context?: string; // Exact version-1 FundedContext bytes, used only for preview.
};
```

Add optional `exampleFixtures:ExampleFixture[]` to the draft request and model input. Bound fixture count, names, base64 decoding and total decoded bytes with the existing authoring and protocol limits. Keep source bytes intact. Fixtures are public illustrative inputs supplied by the buyer. They must contain no private signing material.

A model example may select a fixture with `{name,predictedVerdict,fixtureName}` instead of duplicating its bytes. Resolve only a unique fixture name from the current request. Check the label against the real evaluator. Otherwise accept generated `{name,predictedVerdict,files,evidence?,context?}` and apply the same file/context checks. Keep legacy local text examples compatible. Update the strict provider response schema and prompt together.

The owner-only task response returns `exampleInputs` with exact permitted files, evidence, preview context and any selected fixture name for buyer review. A fixture reference must be traceable to the immutable request. Do not let a later request replace its bytes under an existing draft ID or task replay key.

## Signed examples and preview context

The model receives approved public keys. It receives no signing key, wallet, spending authority or signing tool. A buyer may supply public signed example attestations and their example context. The model can select these fixtures. It must not invent a signature or a trusted identity.

Extend the API's real engine evaluation adapter with optional evidence files and a preview context. Write them to fresh bounded temporary paths. Invoke the existing `engine eval --evidence ... --job ...` flags without a shell. The engine already supports these flags. It checks the original generated plan and actual signatures.

The existing eval command permits an explicit illustrative context and discards its preview ciphertext. Its guest runtime checks the exact rules hash and reference hash against that context. Synthetic chain, escrow, job and provider bytes do not establish a funded chain job. A supplied context must retain both hashes. Label this context as an example. Funding and proving must still use the exact real chain context and existing manifest checks. Do not change the engine to make an example pass.

Before approval, require a genuinely passing example and a structurally valid verdict-0 example. An invalid signature, missing evidence or malformed bundle is a rejection, not a negative verdict. A missing trusted witness must remain visible and block incomplete authored approval. Use the one repair for genuine plan/example disagreement when its full cost and time fit.

## Corpus and benchmark boundary

Give each ambiguous/unsupported request explicit output names and formats that match its stated task. Give every signed request its approved public key. For signed preview examples, create separate public illustrative files and valid attestations under the existing synthetic fixture issuer. Use a clearly synthetic static preview context. Include one valid negative attestation whose rule verdict is 0.

These public examples must differ from the held-out candidate files. Keep the hidden plans, oracles, candidate answers and mutation sets out of model inputs. Preserve the 40/10/10 split, ten families, all original predicates, and the 95% and zero-false-accept gates. Freeze all visible request fields, including outputs and example fixtures, under the corrected digest before any paid call.

Run a real local API envelope check for all sixty requests with a controlled model before spending. Separately verify public signed fixtures and held-out candidates with the native engine and independent oracle. These local checks do not count as the 180 fresh Grok API trials.


Immutable buyer witness completion now uses `POST /v1/drafts/:draftId/example-checks`. It never changes the returned plan or original task. Approval can select the resulting owner-bound check id. See [the coverage and witness contract](hosted-authoring-coverage.md) and [four-workload native API evidence](../agents/anish/reports/hosted-native-buyer-checks-2026-11-17.json).
