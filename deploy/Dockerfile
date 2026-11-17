FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS engine-build
WORKDIR /src/engine
COPY engine/Cargo.toml engine/Cargo.lock engine/capabilities-v1.json ./
COPY engine/cli ./cli
COPY engine/compiler ./compiler
COPY engine/guest-runtime ./guest-runtime
COPY engine/protocol ./protocol
ENV CARGO_BUILD_JOBS=2
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/engine/target \
    cargo +1.98.1 build --locked --release --bin engine && \
    mkdir -p /out && cp target/release/engine /out/engine && \
    sha256sum /out/engine > /out/engine.sha256 && \
    /out/engine capabilities > /out/capabilities.json && \
    ldd /out/engine > /out/dynamic-libraries.txt

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS api-build
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /build/commerce
COPY commerce/package.json commerce/pnpm-lock.yaml commerce/pnpm-workspace.yaml ./
COPY commerce/api/package.json ./api/package.json
COPY commerce/sdk/package.json ./sdk/package.json
COPY commerce/worker/package.json ./worker/package.json
RUN --mount=type=cache,id=ubc26-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store
WORKDIR /build
COPY commerce ./commerce
COPY deploy/build-api.mjs ./deploy/build-api.mjs
RUN node deploy/build-api.mjs /out/server.mjs

FROM docker:29.1.3-cli@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04 AS docker-client

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ARG SOURCE_SHA
LABEL org.opencontainers.image.source="https://github.com/anishnarang9/UBC-26" \
      org.opencontainers.image.revision="${SOURCE_SHA}"
WORKDIR /app
COPY --from=engine-build /out/engine /usr/local/bin/ubc26-engine
COPY --from=engine-build /out/engine.sha256 /app/pins/engine.sha256
COPY --from=engine-build /out/capabilities.json /app/pins/capabilities.json
COPY --from=engine-build /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/local/lib/
COPY --from=engine-build /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/local/lib/
COPY --from=engine-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-client /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=api-build /out/server.mjs /app/commerce/api/src/server.mjs
COPY --from=api-build /out/build.json /app/pins/javascript-build.json
COPY commerce/api/migrations /app/commerce/api/migrations
COPY commerce/api/engine-contract /app/commerce/api/engine-contract
COPY commerce/sdk/src/chain/arc /app/commerce/sdk/src/chain/arc
COPY contracts/deployments /app/contracts/deployments
COPY deploy/state.mjs /app/deploy/state.mjs
COPY --chmod=0555 deploy/warm-compiler.sh /app/deploy/warm-compiler.sh
COPY engine/fixtures/expense-report-plan.json /app/deploy/smoke-plan.json
COPY --chmod=0555 deploy/docker-compile /opt/ubc26/docker-bin/docker
RUN ldconfig && test -n "$SOURCE_SHA" && \
    printf '%s\n' "$SOURCE_SHA" > /app/pins/source-sha && \
    printf '%s\n' 'docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e' > /app/pins/dockerfile-frontend && \
    mkdir -p /var/lib/ubc26/packages /var/lib/ubc26/work /var/lib/ubc26/cache /var/lib/ubc26/tmp /var/lib/ubc26/docker && \
    chown -R node:node /var/lib/ubc26 && \
    node --version && /usr/local/bin/ubc26-engine capabilities > /dev/null && docker buildx version
ENV NODE_ENV=production DEPLOYMENT_MODE=public PORT=8080 HOST=0.0.0.0 \
    ENGINE_MODE=native ENGINE_PATH=/usr/local/bin/ubc26-engine \
    ENGINE_WORK_DIR=/var/lib/ubc26/work PACKAGES_DIR=/var/lib/ubc26/packages \
    UBC26_ENGINE_CACHE=/var/lib/ubc26/cache DB_PATH=/var/lib/ubc26/service.db \
    TMPDIR=/var/lib/ubc26/tmp NODE_OPTIONS=--max-old-space-size=512 \
    PATH=/opt/ubc26/docker-bin:/usr/local/bin:/usr/bin:/bin
USER node:node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:8080/healthz",{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["node","/app/commerce/api/src/server.mjs"]
