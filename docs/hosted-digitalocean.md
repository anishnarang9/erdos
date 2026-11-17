# DigitalOcean backend setup

The user selected DigitalOcean on 2026-11-17 after reviewing the $48/month compute and $9.60/month weekly-backup quote. Keep the current single-host backend. Vercel migration and Sandbox probing are no longer the active deployment path. No Sandbox was created.

## Account and local access

1. Create a standard [DigitalOcean Cloud account](https://cloud.digitalocean.com/registrations/new).
2. Complete account verification and add a payment method.
3. Run `doctl auth login --context ubc26` locally. This opens DigitalOcean in the browser for authorization. The [official OAuth command](https://docs.digitalocean.com/reference/doctl/reference/auth/login/) stores renewable local credentials without copying a token into chat.
4. After browser authorization succeeds, the coordinator checks the account, supported sizes, available regions and existing resources before creating the server.

`doctl` 2.5.0 is installed through Homebrew. Its browser-login help was checked locally. No `ubc26` authentication context exists yet. The alternative token flow is `doctl auth init --context ubc26`, with a token entered only at its local prompt.

The coordinator handles server creation and configuration after authenticated access works. No separate database subscription is required for this architecture.

## Selected resource specification

| Setting | Value |
| --- | --- |
| Product | Droplet |
| Configuration | Bundled Basic, Regular shared CPU |
| Resources | 4 vCPUs, 8 GiB RAM, 160 GiB SSD |
| Published base price | $48/month, $0.07143/hour equivalent |
| Operating system | Ubuntu 24.04 LTS x64 |
| Region | New York, subject to current size/image availability |
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
