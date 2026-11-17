# Hosted qualification review

Reviewer: coordinator. Reviewed checkpoint: `90ce162`. Status: integration blocked pending repair.

## R1: duplicate `__proto__` keys bypass the independent oracle

The oracle's JSON parser creates a normal object and assigns decoded members with `object[key] = value`. JavaScript treats `__proto__` as a setter. The assignment does not create an own property. A second `__proto__` member therefore passes the parser's duplicate-key check.

Reproduction used an immutable Git archive of `90ce162`. The valid pier-drawers candidate received this suffix before its closing brace:

```json
,"__proto__":{},"__proto__":{}
```

The independent oracle returned `pass`, verdict 1. The real baseline engine returned exit 2 with `invalid_deliverable`. This is an oracle defect. It does not show a false accept by the engine.

Required repair: add a failing regression, then store decoded members as own properties in a null-prototype dictionary or with `Object.defineProperty`. Test escaped spellings of the same key. Keep malformed-input rejection separate from verdict 0. Check nesting limits and lone surrogate handling against the real engine before freezing the corpus.

Do not integrate this oracle checkpoint as qualified evidence. Worker B owns the correction and full corpus. Fresh paid trials remain pending deployment, credentials and benchmark authority.
