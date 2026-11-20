FROM docker:29.1.3-cli@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04 AS docker-client
FROM node:24-bookworm@sha256:aca79828f8a4afc627f189387c965625bcc419233946210a3b9522d90a59b5c6

COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker

RUN set -eu; \
    base=https://ubc26-159-89-149-133.sslip.io/downloads; \
    release=e395faf697ae77e30fe93488af67a6e60ae0566b; \
    curl -fsSL --proto '=https' "$base/runner/$release/ubc26-runner-0.2.0.tgz" -o /tmp/runner.tgz; \
    curl -fsSL --proto '=https' "$base/engine/0b35d3a5e327144045d04fe45084f6258bb23f3c/ubc26-engine-linux-x64" -o /tmp/engine; \
    curl -fsSL --proto '=https' https://github.com/risc0/risc0/releases/download/v3.1.0/cargo-risczero-x86_64-unknown-linux-gnu.tgz -o /tmp/risc0.tgz; \
    curl -fsSL --proto '=https' https://registry.npmjs.org/ethers/-/ethers-6.15.0.tgz -o /tmp/ethers.tgz; \
    printf '%s\n' \
      'c327e703adc0a8dd797cffaa3f7fded98e7ea6dc72236a782ce5f42d73a03851  /tmp/runner.tgz' \
      'be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7  /tmp/engine' \
      '415ca205d4408f5d768b9e4d623f2aac6b869329a6cf965f0c57a88a6dbb5871  /tmp/risc0.tgz' \
      '0ca94f1c7f93ba0450ece0224e83fbbf9e840ea8ecbe05f50550d98f4cfaa482  /tmp/ethers.tgz' \
      | sha256sum --check; \
    npm install --offline --ignore-scripts --no-audit --no-fund --prefix /opt/erdos /tmp/runner.tgz; \
    ln -s /opt/erdos/node_modules/.bin/ubc26 /usr/local/bin/ubc26; \
    install -m 0555 /tmp/engine /usr/local/bin/ubc26-engine; \
    tar -xzf /tmp/risc0.tgz -C /usr/local/bin r0vm; \
    tar -xOzf /tmp/ethers.tgz package/dist/ethers.min.js > /opt/erdos/ethers.mjs; \
    rm /tmp/runner.tgz /tmp/engine /tmp/risc0.tgz /tmp/ethers.tgz; \
    ubc26 verify-install --source-commit "$release" --release-manifest-sha256 8d29dbbd1bd19c63c0dd63ee8aeef4d3c3c4d44819b2fd4d09c5857f6adfacfc; \
    test "$(r0vm --version)" = "risc0-r0vm 3.1.0"; \
    ubc26-engine capabilities >/dev/null

COPY test-wallet.mjs /opt/erdos/test-wallet.mjs
RUN printf '#!/bin/sh\nexec node /opt/erdos/test-wallet.mjs "$@"\n' > /usr/local/bin/erdos-test-wallet && \
    chmod 0555 /usr/local/bin/erdos-test-wallet

ENV RISC0_SERVER_PATH=/usr/local/bin/r0vm
