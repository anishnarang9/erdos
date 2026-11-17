# UBC-26 local buyer and solver runner

Status: source implementation. A public service URL and final release evidence remain pending. Do not use historical proof reports as evidence for a new job.

Results become public when the solver broadcasts the release key. The runner proves and settles supplied files. A person or another agent must produce those files.

## Install and check provenance

Native Linux is the first supported release target. Use Node.js 24 or later. Install the pinned native RISC Zero 3.1.0 engine separately. Proving needs the pinned guest toolchain, Docker Groth16 backend and enough memory. Historical Mac runs used a 12-GiB Docker VM and took about 18 minutes for the funded workload. These measurements do not predict another workload's runtime.

A release contains `ubc26-runner-0.2.0.tgz`, `SHA256SUMS` and `release.json`. Verify the archive against independently published checksums. Install the checked local archive:

```sh
sha256sum --check SHA256SUMS
npm install --prefix "$HOME/ubc26-client" ./ubc26-runner-0.2.0.tgz
"$HOME/ubc26-client/node_modules/.bin/ubc26" help
```

The package contains the runner and hosted TypeScript client. It does not need a Git checkout or development workspace dependencies. It does not include an engine binary. Keep the release manifest SHA-256 and source commit from the reviewed release metadata. Signing from an installed package requires both pins. The runner checks every installed file before protected operations. Modified, missing, extra or linked files fail the check.

The source build command is `node commerce/worker/scripts/package-runner.mjs /absolute/new/output-directory`. Run it from a clean committed source tree after installing locked commerce dependencies. It creates an archive locally. It does not publish to a registry.

## Obtain a wallet-owned API key

Set `API` to the deployed HTTPS origin. Local development also permits HTTP on loopback. The client rejects URL credentials, remote HTTP and redirects.

Create a private operator directory. Passwords enter through inherited file descriptors. API keys remain in private files. Never put passwords or keys in command arguments.

```sh
umask 077
mkdir -m 700 "$HOME/ubc26-operator"
ubc26 auth --api "$API" --wallet "$BUYER" \
  --keystore "$BUYER_KEYSTORE" --password-fd 3 \
  --key-out "$HOME/ubc26-operator/api-key" --idempotency wallet-login-001 \
  3<"$PASSWORD_FILE"
ubc26 key --api "$API" --key-file "$HOME/ubc26-operator/api-key"
```

Authentication signs only the service's expiring issuance challenge. It sends no chain transaction. The service returns the raw key once. If key issuance succeeds but local saving fails, issue a new key and revoke the orphaned key by its identifier. Keep challenge signing separate from funding approval.

## Author, approve and compile

`draft.json` uses the existing draft body: request, output declarations, references, expiry policy, budget and clarification answers. `revision.json` uses the API revision shape for deterministic import. Neither file should contain signing credentials.

```sh
ubc26 draft --api "$API" --key-file "$KEY_FILE" --input draft.json --idempotency draft-001
ubc26 task --api "$API" --key-file "$KEY_FILE" --task "$TASK" --wait-ms 1800000
ubc26 job --api "$API" --job "$JOB"
ubc26 approve --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --revision "$REVISION_HASH" --reference-digest "$REFERENCE_DIGEST" --idempotency approve-001
ubc26 compile --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --revision "$REVISION_HASH" --idempotency compile-001
ubc26 task --api "$API" --key-file "$KEY_FILE" --task "$TASK" --wait-ms 1800000
ubc26 download --api "$API" --job "$JOB" --out "$WORK/package"
ubc26 references --api "$API" --job "$JOB" --out "$WORK/reference"
```

Use `import --input revision.json` instead of `draft` to import exact rules. Read the complete rules, examples, assumptions and requirement coverage before approval. A material revision invalidates approval.

Task states are queued, running, succeeded, failed and uncertain. Preserve each returned task identifier. Resume polling that identifier after interruption. Polling does not submit another model call or compilation. An uncertain task requires reconciliation. Do not replace its idempotency key to force a retry.

Reuse the same idempotency key only for the same request bytes and purpose. A new key can create new paid work. The client never retries mutations automatically.

The package downloader checks file hashes, package commitments and the guest digest. Reference download checks the complete canonical reference hash. Package and reference directories must be new paths inside a private parent directory.

## Fund and run supplied deliverables

The buyer executes five funding operations: create job, set budget, approve the exact token amount, fund, and register. Service charges and escrow bounties are separate.

First request a funding preview. Its input is `{revisionHash,buyer,budget,expiry}`. The buyer must match the authenticated wallet. The budget uses six-decimal token units. The expiry is absolute chain time.

```sh
ubc26 funding-preview --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --input funding.json --idempotency terms-001 > "$WORK/terms.json"
```

Create a native engine configuration with `mode`, absolute `executable`, reviewed `executableSha256`, reviewed `wrapperSha256` and an explicit clean `environment`. `ubc26 wrapper-digest` prints a candidate wrapper digest for independent review. Do not treat a computed candidate as approval. The engine environment must exclude wallet and API secrets.

Prepare local configuration from the exact API terms and your own paths:

```sh
ubc26 configure --api "$API" --job "$JOB" --revision "$REVISION_HASH" \
  --input "$WORK/terms.json" --engine-config "$WORK/engine.json" \
  --manifest "$DEPLOYMENT_MANIFEST" --buyer "$BUYER" --solver "$SOLVER" \
  --work-dir "$WORK" --package-dir "$WORK/package" --reference "$WORK/reference" \
  --deliverables "$WORK/deliverables" --source-commit "$RELEASE_SOURCE_SHA" \
  --release-manifest-sha256 "$RELEASE_MANIFEST_SHA256" --out "$WORK/operator.json"
ubc26 operator preview --config "$WORK/operator.json"
ubc26 check --engine-config "$WORK/engine.json" --plan "$PLAN_JSON" \
  --deliverables "$WORK/deliverables" --reference "$WORK/reference"
```

The generated configuration disables signing. Review its exact approval, contract deployment, wallet paths, gas caps, deadlines and source pins. Replace generated keystore paths with your own protected keystores. Set `signingAuthorized` only after approving those exact local limits. The defaults are review candidates, not permission to spend.

Use one shared private `proverLockRoot` for every runner on the machine. The runner refuses a second prover. It never removes a stale lock automatically. Run your solver separately and place its files in the deliverable directory.

```sh
ubc26 operator fund --config "$WORK/operator.json" --key-file "$KEY_FILE" --password-fd 3 3<"$BUYER_PASSWORD_FILE"
ubc26 operator prepare --config "$WORK/operator.json"
ubc26 operator run --config "$WORK/operator.json" --password-fd 3 3<"$SOLVER_PASSWORD_FILE"
ubc26 operator recover --config "$WORK/operator.json"
```

`prepare` generates a local proof for the actual funded context. `run` resumes the protected claim/release flow. A losing solver releases no key. Recovery reads confirmed public chain data and checks both SDK and engine output. Use `operator refund` with the approved buyer configuration after confirmed expiry. `operator circle` uses the existing separate paid-compilation authorization and exact-replay journal.

Preserve the private state directory, nonce journals and transaction hashes after interruption. Reconcile pending or uncertain sends before retrying. The runner never sends the real release key through simulation or gas estimation. A failed attempt does not reject the entire bounty.

## Limits and client example

The encoded result bundle permits 16 files and at most 16,384 bytes. Its encrypted envelope permits 16,412 bytes. The service accepts only catalog-supported deterministic rules. Arbitrary programs, subjective quality, network truth and unverified summaries of source documents require another verifier.

The hosted client is also available from the archive:

```ts
import { hostedClient } from "@ubc26/runner/hosted";
const client = hostedClient({ baseUrl: process.env.API!, apiKey: process.env.API_KEY! });
const task = await client.compile(jobId, approvedRevisionHash, "compile-001");
const result = await client.waitForTask(task.id);
if (result.state !== "succeeded") throw new Error(`Compilation stopped: ${result.state}`);
```

Language-independent requests follow [the API contract](hosted-api-contract.md). For example, submit `POST /v1/tasks` with a bearer key, `Idempotency-Key`, and `{operation:"compile",jobId,revisionHash}`. Poll `GET /v1/tasks/:id` with the same owner's key. Do not send API keys through query strings.

Revoke a key with `ubc26 revoke --api "$API" --key-file "$KEY_FILE" --key-id "$KEY_ID" --idempotency revoke-001`. Revocation takes effect before replay lookup.
