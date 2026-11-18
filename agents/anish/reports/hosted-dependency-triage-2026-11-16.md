# Hosted sprint dependency review

Source under review: `f8bef2d`. Date: 2026-11-16. This report records a finite reachability review. It does not establish that every dependency is safe.

## JavaScript

`pnpm audit --json` reported four advisories across 147 installed dependencies: two high, one moderate and one low. No dependency version changed during this review.

| Dependency | Path and advisory | Relevant behavior | Decision |
| --- | --- | --- | --- |
| ws 8.17.1 | worker → ethers → ws. [GHSA-58qx-3vcg-4xpx](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx) | Memory disclosure requires a TypedArray close reason. The runner uses ethers for offline encrypted-keystore loading. It opens no ethers WebSocket connection. Chain calls use viem HTTP. | No demonstrated reachable trigger. Retain the pinned graph. Reassess before adding WebSocket transports. |
| ws 8.17.1 | Same path. [GHSA-96hv-2xvq-fx4p](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p) | A WebSocket peer can exhaust fragment-buffer memory. The supported runner path has no WebSocket peer. | No demonstrated reachable trigger. The affected package remains in the dependency graph. |
| tmp 0.2.6 | SDK → development solc → tmp. [GHSA-7c78-jf6q-g5cm](https://github.com/raszi/node-tmp/security/advisories/GHSA-7c78-jf6q-g5cm) | The defect needs untrusted non-string path options. The inspected solc caller uses a fixed string postfix, `.smt2`. The hosted API does not pass request bodies to this development compiler. | No demonstrated request path to the affected options. Keep contract toolchain pins. |
| esbuild 0.27.7 | Worker packaging dependency, already present transitively. [GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr) | The defect affects the development server on Windows. This script invokes the build API on native POSIX. It starts no development server. The installed archive has no esbuild dependency. | Not exposed by the supported packaging path. Keep the existing version. |

## Rust

`cargo audit` is not installed. The coordinator fetched RustSec's advisory database at `02e2517f457a359fc6d3440ea4560c8ea188fee8`. A local version-range screen compared all versions in `engine/Cargo.lock` with current advisory patched/unaffected ranges. The screen used npm semver on stable crate versions and is not a substitute for cargo-audit.

The screen retained these candidates:

| Dependency | Advisory | Source inspection and limit |
| --- | --- | --- |
| lru 0.16.4 | [RUSTSEC-2026-0253](https://rustsec.org/advisories/RUSTSEC-2026-0253.html) | Alloy uses `LruCache<B256,String>` and a block-number key cache. The advisory requires a key destructor that panics during `pop`, followed by caught unwinding and another cache operation. The inspected primitive key types have no such destructor. |
| crypto-bigint 0.5.5 | [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) | The engine uses k256/p256 for public signature verification. It does not accept a private signing key. The timing advisory concerns secret integer operations. No private integer signing/decryption path was found in the service's engine commands. Local proof data still needs the documented process boundary. |
| rsa 0.9.10 | [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) | Guest evidence checks call `RsaPublicKey::verify`. Toolchain download verification also uses public keys. The affected private-key decryption operation is absent from the supported engine workflow. |
| tracing-subscriber 0.2.25 | [RUSTSEC-2025-0055](https://rustsec.org/advisories/RUSTSEC-2025-0055.html) | This dependency arrives through ark-relations and Groth16. No application formatter initialization was found. Hosted engine diagnostics must remain bounded and sanitized. A future log formatter needs a new reachability check. |
| derivative 2.2.0 | RUSTSEC-2024-0388 | Unmaintained dependency through the pinned proof stack. This is a maintenance warning. |
| bincode 1.3.3 | RUSTSEC-2025-0141 | Unmaintained dependency through the pinned proof stack. Preserve bounded decoding and proof-stack pins. |
| paste 1.0.15 | RUSTSEC-2024-0436 | Unmaintained macro dependency. This is a maintenance warning. |

Cargo inverse trees confirmed these dependency paths. Source review covered engine evidence verification, rzup signature verification and Alloy cache key types. No broad proof-stack upgrade occurred. Recheck the final deployed graph and subprocess/logging boundary after Worker A integration. Install a pinned cargo-audit tool for a formal release audit when available.
