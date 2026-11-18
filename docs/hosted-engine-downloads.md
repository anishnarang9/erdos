# Verified native engine download

Status: prerelease Linux x64 download and native checks pass. Public buyer routes remain HTTP 503. This export does not qualify a fresh proof.

The source is `fb450331c014b59d037fb692496bdc4f72b11a9c`. Download all three files into a new private directory:

- [Linux x64 engine](https://ubc26-159-89-149-133.sslip.io/downloads/engine/fb450331c014b59d037fb692496bdc4f72b11a9c/ubc26-engine-linux-x64)
- [Checksums](https://ubc26-159-89-149-133.sslip.io/downloads/engine/fb450331c014b59d037fb692496bdc4f72b11a9c/SHA256SUMS)
- [Engine metadata](https://ubc26-159-89-149-133.sslip.io/downloads/engine/fb450331c014b59d037fb692496bdc4f72b11a9c/engine.json)

The engine contains 8,435,600 bytes. Its SHA-256 is `be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7`. It embeds the guest templates. It requires no source checkout.

Check the downloaded bytes against this published digest. Install an independent executable copy:

```sh
sha256sum --check SHA256SUMS
printf '%s  %s\n' \
  be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7 \
  ubc26-engine-linux-x64 | sha256sum --check -
umask 077
mkdir -m 700 "$HOME/ubc26-engine"
install -m 700 ./ubc26-engine-linux-x64 "$HOME/ubc26-engine/ubc26-engine"
"$HOME/ubc26-engine/ubc26-engine" capabilities
```

Select the installed absolute path and published digest in the protected engine configuration described in the [client guide](hosted-client.md). The runner rejects linked executables. Keep API and wallet credentials outside the engine environment.

The supported artifact is Linux x64 with glibc. Qualification uses Debian 12 bookworm. Capabilities also pass directly on Ubuntu 24.04 x64. Required libraries are `libc.so.6`, `libm.so.6` and `libgcc_s.so.1`. The ELF interpreter is `/lib64/ld-linux-x86-64.so.2`. The minimum glibc version remains unknown. These checks do not establish compatibility with every Linux distribution.

Evaluation and proving have different tool needs. Proving also requires the pinned RISC Zero toolchain and Docker Groth16 backend. The current pins are `r0vm` 3.1.0 and `risczero/risc0-groth16-prover:v2026-10-20.1`, with digest `sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583`. See the [proof setup](../engine/proof-smoke/README.md) for all toolchain pins and installation steps. The hosted API performs no proving.

The [HTTP report](../agents/anish/reports/hosted-native-engine-public-download-2026-11-17.json) records exact bytes, TLS, HEAD/Range and rejected paths. The later [installation report](../agents/anish/reports/hosted-native-engine-public-install-2026-11-17.json) records twelve signed checks using the publicly downloaded runner and engine. The test runs as UID 1000, masks the built-in engine and disables networking. No Docker socket is mounted. It generates no proof and sends no chain transaction.

Ingress source `83d5b6925d26da2ad8fd56806b8d3eba572efb60` serves these files through a root-owned read-only mount. Only the three listed filenames permit GET/HEAD. Directory listings and writes return 404. The source repository stays private.
