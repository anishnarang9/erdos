# DigitalOcean backend setup

The user selected DigitalOcean on 2026-11-17 after reviewing the $48/month compute and $9.60/month weekly-backup quote. Keep the current single-host backend. Vercel migration and Sandbox probing are no longer the active deployment path. No Sandbox was created.

## Current server

Droplet `620224382`, `ubc26-hosted-backend`, is active in San Francisco (`sfo2`). The regular $48 size was unavailable in New York. The actual resource has four vCPUs, 8 GiB RAM, 160 GiB disk and Ubuntu 24.04 LTS x64. Weekly backups run Sunday at 08:00 UTC with 28-day retention. The cloud firewall permits SSH only from the operator's public IPv4 `/32`, plus public TCP 80/443. Port 8080 is not exposed.

The temporary name `ubc26-159-89-149-133.sslip.io` resolves to `159.89.149.133`. API and Caddy are running. External TLS validates. Public routing returns 503 because authoring readiness remains disabled. The user supplied the Ed25519 fingerprint through the provider console. It matched the scanned key. Strict SSH pinning now works. The approved temporary console rule closed early and its watchdog confirmed cleanup. SSH again permits only the operator `/32`.

Native Ubuntu 24.04 x86-64 checks pass. Password authentication is disabled. Separate ext4 loop files cap state at 32 GiB, Docker/containerd data at 80 GiB and backup/recovery data at 8 GiB. All three mount with `nodev,nosuid`. These limits cap filesystem growth. They do not reserve physical blocks, because formatting discarded unused extents. The root disk can hold all three maximum sizes plus the operating system. Docker 29.10.0 and containerd 2.4.2 store all image/runtime data within the 80-GiB mount. Systemd requires those mounts before starting them.

The exact `20b0dc2` OCI index imported successfully after host-side archive verification. The pinned BuildKit worker runs with 4 GiB memory and swap total, two CPUs and 512 processes. A first operator profile used the wrong socket group and stopped before building. The corrected profile exposed a real cold-start defect: the network-disabled helper could not obtain anonymous registry tokens. The daemon had working egress, but Buildx also needs client-side registry access. The outer helper now uses bridge networking with no API environment file or credential arguments. Its regression failed before the fix. All ten deployment checks pass afterward. The unchanged runtime image still identifies `20b0dc2`; the corrected outer deployment helper has its own hash in the [native host report](../agents/anish/reports/hosted-digitalocean-native-2026-11-17.json).

Cold compilation passed under a retained systemd unit in 240 seconds. Both expected fixture verdicts pass. The first actual Compose start also exposed an unquoted tmpfs flow-list item. Quoting it preserves one absolute mount with all three restrictions. Its real-Compose regression failed before the fix. All eleven deployment checks now pass. The native API and Caddy run from corrected external deployment files in `operator-tools`. External TLS validates, and public requests return 503 while authoring readiness remains disabled. Operator access through pinned SSH passes auth, ownership, approval, compilation, replay and twenty artifact hashes. No usable public authoring service, genuine model call or new funded acceptance is established yet. See the [provisioning report](../agents/anish/reports/hosted-digitalocean-provision-2026-11-17.json) and native report for the evidence boundary.

Current maintenance: the combined `4a6a320` image is building under the bounded native worker. The API is quiesced. Caddy retains TLS and returns 503. Preserve the prior image/readiness/snapshot until the new image passes exact-source prewarm and native checks. Source-labelled reports above describe the completed `20b0dc2` acceptance.

## Account and local access

1. Create a standard [DigitalOcean Cloud account](https://cloud.digitalocean.com/registrations/new).
2. Complete account verification and add a payment method.
3. Run `doctl auth login --context ubc26 --scopes "read write"` locally. This opens DigitalOcean in the browser for authorization. The [official OAuth command](https://docs.digitalocean.com/reference/doctl/reference/auth/login/) stores renewable local credentials without copying a token into chat.
4. After browser authorization succeeds, the coordinator checks the account, supported sizes, available regions and existing resources before creating the server.

`doctl` 2.5.2 is installed through Homebrew. Context `ubc26` is authenticated. The first login granted only `read`. A key import returned a definitive 403, and an empty inventory confirmed no mutation. The user completed corrected read/write authorization. Key, tag, firewall and Droplet creation then succeeded. The alternative token flow is `doctl auth init --context ubc26`, with a token entered only at its local prompt.

The coordinator handles server creation and configuration after authenticated access works. No separate database subscription is required for this architecture.

## Selected resource specification

| Setting | Value |
| --- | --- |
| Product | Droplet |
| Configuration | Bundled Basic, Regular shared CPU |
| Resources | 4 vCPUs, 8 GiB RAM, 160 GiB SSD |
| Published base price | $48/month, $0.07143/hour equivalent |
| Operating system | Ubuntu 24.04 LTS x64 |
| Region | San Francisco (`sfo2`), selected for regular-size availability |
| Authentication | Dedicated SSH key |
| Backup option | Weekly, 20% of compute cost |
| Published monthly compute plus backup | $57.60 before tax and separate usage |

[Droplet prices](https://www.digitalocean.com/pricing/droplets) and [backup prices](https://docs.digitalocean.com/products/backups/details/pricing/) were checked on 2026-11-17. Recheck the actual account's size and checkout before creation. An unavailable size, changed price or extra subscription needs a revised concrete choice. Account signup alone does not create the server.

## Deployment sequence

Follow the existing [runtime runbook](hosted-runtime.md), the candidate's [release evidence](../agents/anish/reports/hosted-release-candidate-2026-11-17.json) and its [unapproved operator preflight](../agents/anish/reports/hosted-spending-preflight-2026-11-17.json). The preflight still needs actual deployment values and application model budgets.

- Inspect the authenticated account and existing resources. Select a current x64 image and the quoted size in an available US region.
- Prepare a dedicated SSH key, exact reviewed creation parameters and a firewall exposing HTTPS plus restricted SSH access.
- Establish the expected SSH host identity through the provider console before remote setup. Avoid blind host-key acceptance.
- Configure persistent state, hard disk quotas, Docker, resource bounds and the dedicated pinned BuildKit worker. Keep wallets off the host.
- Transfer the verified candidate image and scripts. Check their identities on the native Linux host. Do not replace source-labelled evidence with an assumed native pass.
- Run exclusive compiler prewarm and the passing/failing fixture checks. Record cold and warm timing. A running Docker daemon alone does not establish compiler compatibility.
- Configure the public hostname and exact auth/browser origins. Keep application model dispatch disabled until its credential and budgets are configured.
- Start the API, test external auth/ownership/compilation/artifact retrieval, then exercise restart and backup/restore. Repeat external checks with the laptop API stopped.
- Complete genuine model qualification, current live acceptance and independent review. Preserve the original sprint completion gates.

Proving and signing remain on clients. The per-refinement model target is separate from server cost. Candidate code remains `20b0dc2`; documentation checkpoints do not establish a public release.

## Prepared transfer artifact

The private candidate bundle now contains `ubc26-hosted-runtime-20b0dc2.docker.tar.gz` and `SHA256SUMS.runtime`. The archive is 127,415,689 bytes. Its SHA-256 is `7289a46dbb583a41d74be33d725baf661a0a21538743b6d50b890d5acdf56f20`. See the [transfer verification](../agents/anish/reports/hosted-image-transfer-2026-11-17.json).

The verifier checked all 32 OCI blob hashes and sizes, all 26 uncompressed runtime layer hashes, the Linux amd64 platform and the candidate source label. The archive includes the existing OCI index `acc4eb14…`, amd64 manifest `e7e2d7b6…` and config `892a4e58…`. An initial local check incorrectly equated the index digest with the child config digest. Inspection showed the expected OCI structure. Verification now follows its descriptor chain and validates the actual layers.

After copying, verify the archive checksum on the host before import. Record the imported index, platform manifest and config identities. A classic Docker image store can expose the config ID instead of retaining the OCI index ID. Only accept identities that exactly match the report and the expected runtime payload. Do not describe a config-only import as preservation of the full OCI index. The compose image setting must select the actual verified imported identity.

A dedicated Ed25519 operator key is prepared outside the repository. Its private file has mode 0600 inside a mode-0700 directory. Upload only its public key through authenticated provider access. No key material or API credentials belong in the candidate bundle or Git.

The server now holds the archive, verified runtime image and original deployment scripts. The corrected outer prewarm helper is separate from the archived candidate scripts. Native cold compilation, the API workflow, quiesced restart and separate-instance recovery pass. The [recovery report](../agents/anish/reports/hosted-digitalocean-recovery-2026-11-17.json) records all 21 snapshot files, table counts, twenty artifact hashes and an encrypted off-host copy with a verified decryption round trip. The restored test container is stopped. Managed provider-backup recovery is untested. Public authoring readiness remains disabled. The application key authenticates for non-inference model listing, but no generation call ran.


## Current authoring spending authority

The user approves at most $0.10 for a complete constraint-authoring run, including repair. The proposed $20 qualification budget and daily ceiling were rejected. Mass testing remains deferred. The application key stays in protected operator storage and is absent from the host environment. Its non-inference authentication check passed.

The existing live model guard prices the full documented context. It cannot admit the approved ceiling. Keep authoring disabled until a reviewed complete-input/session bound fits ten cents. Do not substitute the local byte estimate for a provider guarantee. See [model cost controls](hosted-model-costs.md). No larger inference budget is implied by the hosting approval.
