# RISC Zero engine implementation plan

**2026-11-14 · Anish workstream · Proposed implementation details**

Build an engine that turns buyer-approved rules into a RISC Zero guest. The solver runs the guest locally against the finished work. The guest checks and encrypts the exact submitted files. The local CLI creates the Groth16 proof. The Arc evaluator decides whether the funded job can accept that proof. See the [three-way handoff](WORK-SPLIT.md) for ownership and integration.

## 1. Define the rules and the compiler boundary

- Use a Rust workspace under `engine/`. Put rule types, validation, byte formats, and fixtures in `protocol`. Put Rust generation and build orchestration in `compiler`, the shared guest entry point and operations in `guest-runtime`, and the local commands in `cli`.
- Take a versioned typed JSON plan. Declare output files, reference files, evidence profiles, value types, and rules. Use a tagged rule tree with typed field and parameter references. Require a nonempty list of Boolean rules and combine them with logical AND.
- Start with booleans, signed 64-bit integers, strings, records, and bounded lists of records. Use decimal strings for integer values in exchange JSON. Normalize them before canonicalization and use checked arithmetic. Define case-sensitive string equality over decoded UTF-8. Compare integer units exactly, for example cents.
- Implement field access, literals via typed parameter slots, checked add/subtract/multiply, comparisons, Boolean operators, sum, count, uniqueness, matching records by a unique key, and bounded `all` and `any`. A required match must find exactly one record. A duplicate join key fails validation. An empty list satisfies `all` and fails `any`. The buyer can require a minimum count separately.
- Start with strict UTF-8 text and typed JSON. Add a parser when a first job needs it. A bundle can contain opaque files for size or hash rules. A rule about file contents must refer to a supported parser. Give each parser a version and include that version in the approved rule structure.
- Reject duplicate JSON object keys, unknown fields in the plan, ambiguous field paths, missing required fields, and type errors. Reject overflows and invalid UTF-8 where a parser requires UTF-8. Apply file, depth, list, and rule limits in the guest as well as in host validation. Use an initial ceiling of 16 files per bundle, 32 KiB per reference or evidence bundle, 256 records per list, 32 levels of nesting, and 256 rule nodes. Use a 16 KiB ceiling for the encoded delivery bundle until Arc gas measurements confirm it.
- Return a typed error with the missing capability and a request payload the caller can file if a rule, parser, or signature profile is unsupported. Block funding until validation and build succeed. Supported jobs run without a maintainer. A catalog update can support later jobs.

### Commit the logic and its data

1. Split the validated plan into a **structure** and **parameters**. The structure specifies operation order, typed parameter slots, file schemas, parser versions, and evidence profiles. Put thresholds, allowed keys, and expected values in parameters. Resolve slots in traversal order. Preserve rule and list order.
2. Encode both objects with RFC 8785 JCS. Use normalized decimal strings for i64 values to avoid host JSON number rounding. Reject duplicate keys before canonicalization. Compute the formulas below. The ASCII tags contain no trailing newline or terminator. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
3. Generate Rust from fixed templates and typed nodes. Render expressions through an allowlisted emitter. Emit typed indices for name references. Buyer text, runtime values, and model output cannot alter source text, dependencies, or build commands.
4. Embed `structureHash` in the generated guest. The guest decodes the exact canonical parameters, verifies their declared slot types, and recalculates `rulesHash`. Hash the exact reference bundle in the guest. Compare both hashes to the supplied job context before evaluating. Arc checks the same context against the funded job.

```text
structureHash = SHA256(ASCII("UBC26/structure/v1") || structureJcs)
rulesHash     = SHA256(ASCII("UBC26/rules/v1") || structureHash || SHA256(parametersJcs))
referenceHash = SHA256(ASCII("UBC26/reference/v1") || referenceBundle)
```

Treat the compiler and shared guest code as part of the trusted checker. Review the exact normalized rules and sample outcomes before funding. A valid receipt establishes that the approved image ran and committed the journal. [RISC Zero zkVM overview](https://dev.risczero.com/api/zkvm)

### Build artifacts and commands

| Command | Inputs | Output |
| --- | --- | --- |
| `engine validate --plan PLAN` | Typed plan | Canonical structure and parameters, readable preview, capability errors with paths |
| `engine compile --plan PLAN --reference DIR --out DIR` | Approved plan and exact reference files | Checker ELF, canonical parameters, file schema, and manifest |
| `engine prove --package DIR --job JOB --deliverables DIR --reference DIR --evidence DIR --out DIR` | Checker package, funded context, files and evidence | Submission JSON, private release key, and local proof timing |
| `engine decrypt --submission FILE --key-file FILE --out DIR` | Accepted encrypted envelope, its context, and the released key | Original named files after authentication and bundle validation |

Make output JSON machine-readable and send diagnostics to stderr. Report input or commitment errors separately from build or prover failures. Use the journal verdict for a valid check that fails a rule. Return a real receipt for verdict 0 so integration can test that Arc rejects it for payout.

Use RISC Zero `risc0-zkvm`, `r0vm`, and `cargo-risczero` 3.1.0. Use the released `risc0-ethereum-contracts` 3.1.0 seal encoder. Pin the Rust guest toolchain, Docker image digest, dependencies, and lockfiles in the build manifest. Start on Linux x86-64 with Docker. Cache by structure hash plus a fingerprint of the compiler, guest runtime, and all build inputs. Compute the true image ID from the ELF. Check it against the manifest on every cache hit. Publish successful cache entries atomically. A fresh build with the same inputs must produce the same image ID. [RISC Zero release](https://github.com/risc0/risc0/releases/tag/v3.1.0) · [Deterministic guest build](https://github.com/risc0/risc0/blob/v3.1.0/risc0/cargo-risczero/README.md#build)

## 2. Bind the exact deliverable and signed evidence

### File bundles

Encode a bundle as a version byte `0x01`, a big-endian u16 file count, then the records below. Order records by ascending filename bytes. An empty reference bundle is `010000`. Preserve file contents byte for byte.

```text
u16be(name_length) || name_bytes || u32be(content_length) || content_bytes
```

Accept flat ASCII names of 1–128 bytes with letters, digits, dots, underscores, and hyphens. Reject `.`, `..`, duplicate names, paths, symlinks on directory import, trailing bytes, and lengths outside limits. Check required names and declared types. Use the exact encoded delivery bytes as the guest's encryption plaintext. The guest can inspect projected fields from those bytes.

### Signed evidence

Specify the expected evidence profile, signer, payload schema, and required bindings in the approved plan. Verify the signature before using its payload. A rule can require an artifact hash or a job challenge. A timestamp inside a signature is a claim by the signer. Compare signed time values with buyer-approved bounds or committed data. [Ed25519](https://www.rfc-editor.org/rfc/rfc8032) · [EIP-712](https://eips.ethereum.org/EIPS/eip-712)

| Profile | Verification |
| --- | --- |
| Ed25519 evidence v1 | Verify a 64-byte signature with the approved 32-byte public key. Sign the ASCII tag `UBC26/evidence/v1` followed by canonical payload bytes. |
| EIP-712 evidence v1 | Recover the approved EOA from a valid low-S signature. Use domain name `UBC26 Evidence`, version `1`, and the job chain ID and escrow address. Use `Evidence(bytes32 contextHash,bytes32 payloadHash)` with SHA-256 hashes of the funded context bytes and exact payload. |
| Compact JWS | Verify the original three-segment compact form. Pin `Ed25519`, `ES256`, or `RS256` and the approved public key in the plan. Allow legacy `EdDSA` only as an explicit Ed25519 profile. Require a protected algorithm and an embedded payload. Reject algorithm changes, key discovery headers, duplicate headers, and unsupported extensions. |

Use guest-compatible Rust libraries and run reference vectors inside the real guest. Set the signing policy from the approved plan. A solver-supplied key, certificate URL, or algorithm cannot override it. Test valid and invalid evidence for each advertised profile. [JWS](https://www.rfc-editor.org/rfc/rfc7515) · [JOSE algorithms](https://www.rfc-editor.org/rfc/rfc7518) · [Ed25519 identifier](https://www.rfc-editor.org/rfc/rfc9864.html)

## 3. Freeze the bytes for Arc

The funded context is 169 bytes. Concatenate the fields in order. Encode integers as unsigned big-endian values and addresses as raw 20-byte values. Use the byte order of the RISC Zero Solidity fixture for the separate image ID. [Verifier interface](https://github.com/risc0/risc0-ethereum/blob/v3.1.0/contracts/src/IRiscZeroVerifier.sol) · [Released test receipt](https://github.com/risc0/risc0-ethereum/blob/v3.1.0/contracts/test/TestReceiptV3_1.sol)

| Field | Bytes | Source |
| --- | ---: | --- |
| Version | 1 | `0x01` |
| Chain ID | 32 | Network where escrow runs |
| Escrow address | 20 | ERC-8183 core contract |
| Job ID | 32 | ERC-8183 job |
| Provider | 20 | Selected solver address |
| Rules hash | 32 | Funded commitment |
| Reference hash | 32 | Funded commitment |

1. Generate a 32-byte key and 12-byte nonce with the worker host's OS RNG for each attempt. Pass them as private guest inputs. Use the context bytes as ChaCha20-Poly1305 associated data. [RFC 8439](https://www.rfc-editor.org/rfc/rfc8439)
2. Compute the envelope in the guest. The CLI can reproduce that envelope locally with the same inputs and compare its hash to the journal. Commit the journal with raw bytes. Abort on malformed inputs. For a well-formed deliverable that fails a rule, commit verdict 0.
3. Verify the receipt locally against the approved image ID. Compare the complete journal with the expected context, observed verdict, and reproduced commitments. Export an EVM-encoded seal with selector `0xe71e6620`. Reject fake receipts and development mode on the export path. [RISC Zero verifier release](https://github.com/risc0/risc0-ethereum/releases/tag/v3.1.0)
4. Save `proof.json` with `version`, `context`, `imageId`, `verdict`, `envelope`, `keyCommitment`, `journal`, and `seal`. Use 0x-prefixed hex strings for bytes. Persist the key in a private, separate attempt file before exposing the submission artifact. Write files atomically and retain the key until the release outcome is known. Exclude secrets and plaintext from logs and public exports.

```text
envelope      = nonce[12] || ciphertext || tag[16]
envelopeHash  = SHA256(envelope)
keyCommitment = SHA256(ASCII("UBC26/key/v1") || context[169] || key[32])
journal       = context[169] || verdict[1] || envelopeHash[32] || keyCommitment[32]
journalDigest = SHA256(journal[234])
```

### Reference bytes for all three owners

This synthetic fixture checks encoding and encryption. The repeated key and nonce are fixture values. It contains no Groth16 seal. Use chain ID 5042002, job ID 7, escrow bytes `11` × 20, provider bytes `22` × 20, rules hash bytes `33` × 32, and reference hash bytes `44` × 32. Use verdict 1, key bytes `55` × 32, and nonce bytes `66` × 12.

| Value | Hex |
| --- | --- |
| Bundle for `a.txt` containing `ok` | `0100010005612e747874000000026f6b` |
| Envelope | `666666666666666666666666f4846535e153e02fbd1c8c3a8fff73b6b3ad081d0b4838c0baa5dea92b84d556` |
| Envelope hash | `ad46cb7372002d8ee22d8a082781a89ffde85198d5257c2643912ca3898012e6` |
| Key commitment | `3bbc3bf1185df5265d974732502dfffca6037592208f145b6fc143f9cec9c99d` |
| Journal digest | `9ae8cca7c5828cc27a19039df5593a21e37cc1f05fcf99f32e118d233f4d115e` |

## 4. Build order and acceptance

| Step | Deliverable | Test before handoff |
| --- | --- | --- |
| 1 | Pinned toolchain and tiny guest | Create a real Groth16 receipt in the supported environment. Verify it locally and hand it to the Arc owner. Check the selector. |
| 2 | Protocol crate and public byte fixture | Match every value above in Rust and independently in TypeScript or Solidity as applicable. Check exact byte recovery and modified context failure. |
| 3 | Typed rule compiler and reproducible build | Compare direct rule evaluation with the generated guest on both valid and invalid inputs. Change one runtime threshold and check that the image ID stays the same and the rules hash changes. Rebuild a structure in two clean environments and compare image IDs. |
| 4 | Evidence profiles and prove/decrypt CLI | Run a structured record reconciliation fixture and an unrelated signed text fixture. Include a multi-file delivery. Test every advertised signature profile, malformed proofs, key errors, wrong sources, and mismatched commitments. |
| 5 | Release candidate | Supply two independently reproducible proof bundles, one with verdict 1 and one with verdict 0. Record guest cycles, proof time, output size, cold and warm builds, and cache hits. Verify the real bundles through the Arc evaluator. |

Include negative tests for empty or duplicate required data, integer limits, rule substitution, changed evidence and reference bytes, missing and unexpected files, ciphertext changes, wrong keys, and job replay. Check that a valid failing receipt verifies locally but cannot satisfy the passing journal on Arc. Measure the largest supported delivery with real calldata. Confirm the 16 KiB cap or publish a smaller limit in a shared release manifest before the demo.
