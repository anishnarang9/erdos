# DigitalOcean backend setup

The user selected DigitalOcean on 2026-11-17 after reviewing the $48/month compute and $9.60/month weekly-backup quote. Keep the current single-host backend. Vercel migration and Sandbox probing are no longer the active deployment path. No Sandbox was created.

## Current server

Droplet `620224382`, `ubc26-hosted-backend`, is active in San Francisco (`sfo2`). The regular $48 size was unavailable in New York. The actual resource has four vCPUs, 8 GiB RAM, 160 GiB disk and Ubuntu 24.04 LTS x64. Weekly backups run Sunday at 08:00 UTC with 28-day retention. The cloud firewall permits SSH only from the operator's public IPv4 `/32`, plus public TCP 80/443. Port 8080 is not exposed.

The temporary name `ubc26-159-89-149-133.sslip.io` resolves to `159.89.149.133`. No application is running and TLS is not verified. The [provisioning report](../agents/anish/reports/hosted-digitalocean-provision-2026-11-17.json) records current provider evidence. Native SSH host identity, Docker/storage setup, compilation, image import and external acceptance remain pending.

The user must provide the public Ed25519 host fingerprint from the provider console. Browser automation encountered concurrent user interaction and could not complete that check. A network keyscan remains explicitly untrusted until it matches the provider-console result. No native SSH command has run.

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

These checks establish local transfer readiness. They do not establish native compilation, public deployment or model access. No server was contacted.
