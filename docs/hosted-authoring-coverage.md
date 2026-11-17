# Buyer review of requirement links

Every live draft response includes `coverage`. Each requirement has an id, text, zero-based rule indices and source-quote indices. The service checks that every rule has a link. Every linked quote must occur in the request or a named UTF-8 reference. Unknown indices, duplicate ids, unlinked rules, assumptions or unresolved requirements prevent `ruleCoverageComplete`.

These finite checks do not prove that the model listed every intended requirement. They do not prove semantic equivalence between a rule and its quote. The buyer must review the source text, checker rules, links, assumptions and examples. The independent qualification oracle remains separate.

Public approval of a model-authored revision requires the exact `coverage.coverageDigest` in the approval body. The digest binds the normalized links, rule count, assumptions, unresolved items and verified quotes. Revision hash and reference digest remain required. The SDK accepts `coverageDigest`. The installed runner accepts `approve --coverage-digest <digest>`.

A missing or different digest returns `approval_required`. An unresolved mapping can use the existing single repair attempt when time and budget permit. The service keeps legacy local records readable. Legacy records without links cannot pass the public model-authored approval gate.

No real Grok qualification trial establishes coverage quality yet.

A single 120-second authoring deadline now covers the initial model call, validation, every example check and the optional repair. Each real adapter receives the shared cancellation signal. A repair does not restart that deadline. Runtime cancellation is excluded from provider payloads and recording identity. Unknown bills remain uncertain if cancellation prevents usage recovery.


`POST /v1/drafts/:draftId/example-checks` appends buyer witnesses for an existing draft. It requires a wallet key, an idempotency key and `If-Match` equal to the exact revision hash. The body contains `draftId`, `revisionHash` and complete `examples`. It accepts the existing file, evidence and context format. It accepts no replacement plan or references. Only the draft owner can submit checks.

The response contains `exampleCheckId`, the exact bindings, actual passing/verdict-0 counts and `exampleApprovalReady`. Rejected input or signatures remain rejected checks. They do not count as verdict 0. A timeout creates a failed, unapprovable record. Database triggers prevent record updates or deletion. The original task response remains unchanged. Every wallet-owned initial draft also creates an immutable initial check record.

Public approval uses the initial record unless the buyer explicitly supplies `exampleCheckId`. A later record must match the same wallet, draft and revision. It needs one actual pass and one actual verdict 0 with no rejected or disagreeing examples. Approval retains both the check id and coverage digest. The service never signs witnesses.

The SDK exposes `checkExamples(draftId, {revisionHash, examples}, replayKey)`. The runner exposes `check-examples --draft <id> --revision <hash> --input <private-json>`, with the usual API, private key-file and idempotency flags. That JSON contains only `examples`. Then use `approve --example-check <id> --coverage-digest <digest>` with the exact revision/reference commitments.

The [native API transport report](../agents/anish/reports/hosted-native-buyer-checks-2026-11-17.json) covers four signed workloads. Their real native checks produce passing and verdict-0 examples. Changed contexts reject. A controlled model supplies canonical held-out plans only for this transport test. This evidence is separate from real Grok qualification and funded acceptance.
