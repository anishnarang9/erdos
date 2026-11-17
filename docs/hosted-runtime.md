# Hosted backend runtime

Status: Linux image `4135ab4` passes the new immutable-pin startup, native import/approval and exact restart/replay checks. Earlier images establish authentication, warm compilation and compiled-package restore checks. These ran under amd64 emulation on arm64 macOS Docker Desktop. No public endpoint has been deployed. Production configuration, bounded cold compilation, real Grok access and external acceptance remain open gates. The active readiness follow-up will require another image.

## Host and trust boundary

Use one dedicated Linux amd64 Docker host. Reserve four CPUs, 8 GiB RAM and 100 GiB SSD for the API, one compiler and build images. The Compose file limits the API to one CPU, 1 GiB RAM and 128 processes. The dedicated BuildKit worker has two CPUs, 4 GiB RAM with no extra swap, and 512 processes. Cache GC targets 10 GB. GC is a cleanup policy, not a hard disk quota.

Mount `/srv/ubc26-state` on a persistent filesystem with a hard 32-GiB quota. Apply a separate hard quota to Docker's data filesystem. Record and test these host limits before public deployment. Compose cannot impose a quota on a bind mount. Do not claim a disk limit from its cache policy. Set the state and backup directories to uid/gid 1000, mode 0700. Keep at least 10 GiB free for build operations.

The API uses the host Docker socket for fixed-template guest builds. That socket grants host administration power. Dedicate the host to this service. Keep wallets, private signing files and unrelated credentials off it. The API now supplies an explicit clean compiler environment. Runtime tests reject inherited service credentials and cancel owned process groups. The fixed Docker wrapper selects one resource-limited builder. This boundary does not protect a shared host from a compromised Docker client. The configured CPU and memory options follow [Docker's container-driver contract](https://docs.docker.com/build/builders/drivers/docker-container/).

Only Caddy publishes ports 80 and 443. It checks `/readyz` every five seconds and removes an unhealthy API from proxy service. The API has no host port. Caddy obtains and renews TLS for the configured hostname, applies a 1-MB request cap, and forwards requests over the private Compose network. `TRUST_PROXY=1` is valid only with this ingress topology. Set public CORS to the exact deployed origin through the API's reviewed production configuration. Do not expose a development proxy.

## Reproducible source and images

From a clean committed checkout:

```sh
deploy/build-image.sh ubc26-hosted:REVIEWED_SHA
```

The script exports committed release paths with `git archive`. Ignored files and credentials cannot enter that context. The image builds the locked native engine with Rust 1.98.1 and bundles the API with pnpm 10.34.9 and esbuild 0.27.7. Base images use immutable digests. `/app/pins/` records the source revision, native executable and compiler-wrapper hashes, guest-builder/frontend references, engine catalog and JavaScript builder. The native executable hash is an artifact identity; it is not a cross-platform reproducibility claim.

Copy `deploy/host.env.example` and `deploy/api.env.example` to protected administrative files outside the checkout. Populate only the reviewed configuration names. `api.env` holds the model credential and service configuration. It must not hold a wallet. Keep expensive dispatch disabled until pricing, daily/request ceilings and live authority are approved. The incomplete example fails closed; it is not a ready production configuration.

On the Linux host, load the administrative variables into the shell without printing their values. Run `deploy/prepare-builder.sh` once. It refuses to replace an existing builder. Inspect its image digest, memory, swap, CPU and process limits. The script pulls the pinned daemon image before bootstrap and requires a running node. A bootstrap timeout is not readiness; preserve the builder and inspect it before retrying. The fresh `$UBC26_STATE_DIR/docker` directory contains only this builder's metadata. Never run registry login against it. Both the host and API use `/var/run/docker.sock` and the same logical builder paths.

Before enabling compilation, stop the API and run the installation prewarm with `UBC26_API_QUIESCED=1 deploy/warm-compiler.sh`. This requires exclusive use of the compiler and state volume. The helper receives no API environment file. It compiles a fixed template and checks one passing and one failing fixture. Its one-hour installation deadline includes cold registry/cache setup. The API retains its separate 30-minute deadline. The helper pins the Dockerfile frontend to the digest recorded in `/app/pins/dockerfile-frontend`. It writes `compiler-ready.json` atomically, preserving an incomplete run as `warming`. A successful prewarm does not replace public readiness or real authoring checks. The helper passed in the pinned Linux image at `621d86d`, with a warm cache, in 13 seconds. Cold-cache installation timing remains unverified.

```sh
docker compose --file deploy/compose.yaml config --quiet
docker compose --file deploy/compose.yaml up -d
```

Record the resolved API/Caddy/BuildKit image identities, engine hash, source SHA, configuration names, quota measurements and health/readiness results. Never publish API keys or environment values. Check public health, auth, a real model task, compilation and artifact downloads from another machine. Then stop the laptop API and repeat. A localhost process or tunnel does not establish the public service.

## Backup and restore

Back up before each database migration or image upgrade. Keep one API instance for a state volume. `backup-state.sh` stops that instance before copying the database and committed packages. [Node's SQLite backup API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-destination-options) creates the snapshot, including committed WAL content. The snapshot switches to a self-contained rollback journal. It includes table counts and an exact file inventory with SHA-256 hashes. Cache, work and temporary directories are derived and excluded. Task state, owner/key digests, idempotency, payments and chain history remain in the database.

```sh
deploy/backup-state.sh
deploy/restore-state.sh /absolute/snapshot /absolute/new-parent MANIFEST_SHA256
```

Store the printed manifest pin in a separate protected location. Copy encrypted snapshots off-host. The restore command checks the independent pin, every file, table counts, SQLite integrity and foreign keys. It rejects symlinks, hard links, extra files, invalid paths, changed bytes and an existing destination. A failed backup leaves the API stopped. Inspect it before an explicit restart.

Restore into a new parent and use its `restored` directory as a separate instance's state volume. Mount it at **`/var/lib/ubc26`**, the same internal path as the source. Package bindings contain internal absolute paths. Do not rewrite them. Use a different Compose project, HTTPS hostname and port bindings for the restore drill. Keep expensive dispatch disabled. Check owner isolation, a completed task, deduplication, package/reference hashes, and payment/send reconciliation. Do not point two writers at one SQLite volume.

The local drill preserved the original state, restored 21 files to a new directory, promoted that directory to the original logical path, and started a new process. The completed native task retained attempt 1; a fresh replay key selected the same task. A second wallet could not read it. The guest hash matched. This proves local state recovery, not provider storage durability or public hosting.

## Restart, retention and rollback

Compose restarts the API and HTTPS proxy unless an operator stopped them. Its Docker log files rotate at 10 MB with three files per service. Keep structured logs free of raw authoring input, credentials, keys and local paths. Readiness must reflect dependency failures; liveness alone cannot approve a release.

Preserve completed packages, revisions, owner records, task/payment uncertainty and chain history. BuildKit may discard derived cache under its GC policy. Do not run broad Docker prune or delete database indexes to repair a deployment. Measure disk use and reject expensive work before exhausting the quota. Review interrupted model calls before any retry. Reconcile chain/payment state before signing again.

For rollback, stop the API and preserve the current volume. Restore the pre-upgrade snapshot into a new volume, select the previous pinned image, and mount the restored volume at the same internal path. Validate with dispatch disabled before changing ingress. Do not start old code against a database with newer migrations unless compatibility was checked. Reconcile external payments and chain receipts after restoring; an older snapshot cannot undo them. Keep both volumes until that audit passes.

## Current verification

- State tests: WAL-backed relational recovery; no quiescence; symlinks; changed/extra files; wrong manifest pin; existing target.
- Real local native task: import, approval, compilation, replay, deduplication, package integrity, process restart and restored owner isolation.
- Linux API build target: pinned Node 24 container completed its frozen install and bundle.
- Full Linux image: built. Caddy configuration: valid. Actual API cgroups enforce 1 GiB memory, zero extra swap, one CPU and 128 processes. Separate-container restore preserved approval, ownership and reference data. See [the Linux report](../agents/anish/reports/hosted-linux-runtime-2026-11-16.json).
- The first cold Linux compile reached its 30-minute deadline while preparing the large guest-builder image and Cargo cache. Its failed task remains preserved. A warm retry completed in 12.513 seconds. A separate-volume Linux restore preserved both outcomes, exact replay and guest bytes. The installation prewarm also passed its actual pinned-image check, with a warm cache.
- Hard disk quota, production readiness, issued public TLS certificate and external host checks: pending.

Public deployment requires the host/account, approved resource budget and hostname. Real authoring also requires a securely configured Grok API credential and separate service/benchmark inference ceilings. Fresh Arc/Circle spending requires its own concrete preview and current authority.


The new image startup reads those immutable pin files before importing the API server. It supplies native engine, compiler wrapper, source, guest-builder and frontend identities. Conflicting operator overrides, malformed pin files and linked pin files reject startup. The reader never copies or prints service credentials. Runtime readiness independently compares actual executable bytes and the completed prewarm record. Image `4135ab4` validates those pins in restricted Node 24/Linux execution. Wrong digest configuration rejects before API import without printing the supplied credential. Native import/approval, restart and exact replay pass. Readiness correctly stays false without required dependencies. The [image report](../agents/anish/reports/hosted-image-startup-2026-11-17.json) distinguishes this local smoke from public deployment. The follow-up readiness implementation still needs its own final image check.


## Check proxy readiness and log privacy

Run `node deploy/check-proxy.mjs REVIEWED_LOCAL_IMAGE` after caching the pinned Caddy image and building that runtime image. The check uses a dedicated internal Docker network, a controlled upstream and HTTP only. It checks 503 before readiness, 200 after readiness, and 503 after readiness is removed. It also rejects raw test header/query/path values in proxy error logs. It performs no model, compiler, prover or external chain operation. Public TLS remains a separate host check.

The proxy drops the request object from runtime error logs. API structured logs supply route/status timing without raw request content. The Caddy container drops all capabilities except `NET_BIND_SERVICE` and uses `no-new-privileges`. The image requires that bind capability even in the controlled high-port test. See [the finite proxy report](../agents/anish/reports/hosted-proxy-readiness-2026-11-17.json). The first test profile omitted that capability. A later regression confirmed the raw request-log exposure before the filter fixed it.

## Reject mismatched deployment settings

Public image startup now requires both `CHAIN_*` and `OPEN_CLAIM_*` read configurations. Before importing the API, it compares chain ID, core, token, selected-provider hook, adapter and verifier against the two committed image manifests. Missing or different settings reject. Public RPC URLs must use HTTPS without URL user/password credentials. Open-claim reads require at least three confirmations. This check performs no network request and does not establish current RPC availability, runtime bytecode or role state. Protected operators still verify those facts before signing.

The checked environment template contains the committed read-only deployment addresses and starts indexing at the core deployment block. Model credentials and approved request/daily ceilings remain empty. The default expensive-operation kill switch stays enabled. Fill the protected file outside Git and validate the actual host before opening service. Public authentication rejects the legacy buyer token; the server still needs a separate random value for that initialization setting.

All nine startup/deployment/backup tests pass on the host and restricted Node 24/Linux. The first Linux test invocation inherited the image's unmounted state temp path and failed with read-only filesystem errors. The corrected test profile explicitly uses its writable `/tmp`; no source change was needed for that profile error. CI now includes all three deployment test files. A fresh combined runtime image remains pending.

The updated `c7a8c44` image passed actual warm prewarm compilation and native pass/verdict-0 checks in one second. The [recorded engine output](../agents/anish/reports/hosted-runtime-prewarm-2026-11-17.json) exposed a digest-format mismatch in readiness. The consumer now accepts the engine's `0x`-prefixed 32-byte guest digest as well as bare hex. A regression reads that exact report. Invalid lengths and characters still reject. This parser repair requires its own combined image verification.

## Public-mode image evidence and observation

Image `92ef0c3` passes configured readiness, independent wallet authentication, cross-owner rejection, native approval, solver progress/public reads, real warm compilation, exact replay, restart and revocation. The compile took 1.792 seconds. A restarted successful task retained attempt 1. This ran on the local restricted emulated Linux container with external egress blocked and an unused synthetic model credential. No Grok authentication, public hosting or funded settlement is established. The first host-port probe could not traverse Docker Desktop's isolated internal network; the retry used container-loopback transport. See [the exact image report](../agents/anish/reports/hosted-public-mode-image-2026-11-17.json).

The next integrated service checkpoint adds default admission caps, structured logs and protected `GET /v1/operator/metrics`. Set a separate protected operator token. Do not grant it to buyers or solvers. Counters report queue/error/latency and process resources; they reset on restart and do not enforce host quotas. Keep `REQUEST_LOG_DEBUG=0` publicly. The paid compilation wait path and browser-origin policy remain under review. These later controls require their own image check.

The [attempt-aware restore drill](../agents/anish/reports/hosted-attempt-backup-restore-2026-11-17.json) preserves 41 files and all table counts. A separate stopped/restored instance reauthenticates the owner, rejects cross-owner task reads, retains successful task attempt 1 and serves solver history plus 20 hash-checked package files. Restore does not copy derived compiler readiness; the API stays unready until prewarm. Expensive work stayed disabled. The first test used a read-only source mount, unlike the shipped helper. SQLite needed its sidecar directory writable. The corrected documented profile passed without a production code change. The report also records the two package-probe transport corrections.

Use [the release ledger](../agents/anish/reports/hosted-release-readiness-2026-11-17.json) to find each evidence source and remaining gate. It is an incomplete working ledger, not a release declaration.
