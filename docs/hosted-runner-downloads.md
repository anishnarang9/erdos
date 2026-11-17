# Verified runner download

Status: prerelease client download verified. Public buyer routes remain HTTP 503 while Bot setup and authoring qualification continue. This archive contains the CLI and hosted TypeScript client. It excludes the native engine.

The release source is `fb450331c014b59d037fb692496bdc4f72b11a9c`. Download these four files into a new private directory:

- [Runner archive](https://ubc26-159-89-149-133.sslip.io/downloads/runner/fb450331c014b59d037fb692496bdc4f72b11a9c/ubc26-runner-0.2.0.tgz)
- [Checksums](https://ubc26-159-89-149-133.sslip.io/downloads/runner/fb450331c014b59d037fb692496bdc4f72b11a9c/SHA256SUMS)
- [Release metadata](https://ubc26-159-89-149-133.sslip.io/downloads/runner/fb450331c014b59d037fb692496bdc4f72b11a9c/release.json)
- [Payload manifest](https://ubc26-159-89-149-133.sslip.io/downloads/runner/fb450331c014b59d037fb692496bdc4f72b11a9c/ubc26-release.json)

The archive SHA-256 is `148366c2a62114a8c5d0696fa9c3ee990e06a217d815f4e50c506a856e5a793c`. The payload manifest SHA-256 is `fbab4c2c6941115a099aab3b6ab6ca2b4e436066e483f21ce73bcaec1165e447`.

With Node.js 24 or later, check and install the downloaded archive:

```sh
sha256sum --check SHA256SUMS
npm install --offline --ignore-scripts --no-audit --no-fund \
  --prefix "$HOME/ubc26-client" ./ubc26-runner-0.2.0.tgz
"$HOME/ubc26-client/node_modules/.bin/ubc26" verify-install \
  --source-commit fb450331c014b59d037fb692496bdc4f72b11a9c \
  --release-manifest-sha256 fbab4c2c6941115a099aab3b6ab6ca2b4e436066e483f21ce73bcaec1165e447
"$HOME/ubc26-client/node_modules/.bin/ubc26" help
```

The public archive passes a fresh offline installation and provenance check on macOS arm64. The same bytes pass installed-package checks on native Linux x64, including twelve signed checks against the deployed release engine. Native Linux is the first supported engine target. Engine binary distribution remains pending. Evaluation and proving require the separately installed, pinned engine and tools described in the [client guide](hosted-client.md).

The [public acceptance report](../agents/anish/reports/hosted-runner-public-download-2026-11-17.json) records exact hashes, HEAD/Range checks, blocked paths and installation results. Ingress source is `6351e0901312d6e15b5e5f221b9b4448cee50718`. The source repository stays private. Directory listings and writes return 404.

These artifacts do not establish genuine Bot validation, measured model cost, a working public buyer API or fresh funded acceptance. The current protocol publishes the release key, so settled results become public.
