# Buyer review of requirement links

Every live draft response includes `coverage`. Each requirement has an id, text, zero-based rule indices and source-quote indices. The service checks that every rule has a link. Every linked quote must occur in the request or a named UTF-8 reference. Unknown indices, duplicate ids, unlinked rules, assumptions or unresolved requirements prevent `ruleCoverageComplete`.

These finite checks do not prove that the model listed every intended requirement. They do not prove semantic equivalence between a rule and its quote. The buyer must review the source text, checker rules, links, assumptions and examples. The independent qualification oracle remains separate.

Public approval of a model-authored revision requires the exact `coverage.coverageDigest` in the approval body. The digest binds the normalized links, rule count, assumptions, unresolved items and verified quotes. Revision hash and reference digest remain required. The SDK accepts `coverageDigest`. The installed runner accepts `approve --coverage-digest <digest>`.

A missing or different digest returns `approval_required`. An unresolved mapping can use the existing single repair attempt when time and budget permit. The service keeps legacy local records readable. Legacy records without links cannot pass the public model-authored approval gate.

Immutable buyer-supplied example completion and one request-wide deadline remain separate open implementation items at this checkpoint. No real Grok qualification trial establishes coverage quality yet.
