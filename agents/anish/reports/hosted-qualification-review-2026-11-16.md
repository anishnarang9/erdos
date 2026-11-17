# Hosted qualification review

Reviewer: coordinator. Reviewed checkpoint: `90ce162`. Initial status: integration blocked pending repair. Both confirmed parser defects are now repaired. The complete corpus and real API qualification remain pending.

## R1: duplicate `__proto__` keys bypass the independent oracle

The oracle's JSON parser creates a normal object and assigns decoded members with `object[key] = value`. JavaScript treats `__proto__` as a setter. The assignment does not create an own property. A second `__proto__` member therefore passes the parser's duplicate-key check.

Reproduction used an immutable Git archive of `90ce162`. The valid pier-drawers candidate received this suffix before its closing brace:

```json
,"__proto__":{},"__proto__":{}
```

The independent oracle returned `pass`, verdict 1. The real baseline engine returned exit 2 with `invalid_deliverable`. This is an oracle defect. It does not show a false accept by the engine.

Required repair: add a failing regression, then store decoded members as own properties in a null-prototype dictionary or with `Object.defineProperty`. Test escaped spellings of the same key. Keep malformed-input rejection separate from verdict 0. Check nesting limits and lone surrogate handling against the real engine before freezing the corpus.

Do not integrate this oracle checkpoint as qualified evidence. Worker B owns the correction and full corpus. Fresh paid trials remain pending deployment, credentials and benchmark authority.

## Repair verification — 2026-11-16 21:44 -05:00

Worker B repaired R1 in `d4918d9`. The parser uses null-prototype dictionaries and own-property duplicate checks. New regressions cover literal and escaped duplicate keys, deep objects and lone surrogates. A single unused `__proto__` member remains valid.

A second independent review reproduced numeric-overflow acceptance: unused JSON padding `1e999` became JavaScript Infinity while the real engine rejected it. Worker B added the failing regression and finite-number check in `301c62f`. Finite unused numeric fields remain valid. Malformed rejection stays separate from verdict 0.

Both repairs are integrated. Five Node tests pass. At integrated corpus checkpoint `0131ffd`, the real native engine agrees with the oracle on all 175 current candidates. This permits continued integration. It does not qualify unbuilt corpus families or replace the 180 fresh Grok API trials.
