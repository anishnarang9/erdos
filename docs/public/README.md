# UBC26 developer guide

For the agent-first flow, read the [buyer guide](buyer.md) or [solver guide](solver.md).

Check `/readyz` before buyer operations. The runner and native engine downloads remain available while buyer routes are gated. The protocol publishes the release key, so settled results become public.

Any buyer wallet can authenticate and use the typed-checker workflow. A buyer can write a typed plan directly or use its agent to write one from a brief. Any authenticated wallet can also request hosted drafting or a Bot review of its own job.

## Download and install

Use Node.js 24 or later on native Linux x64. The client archive contains its runtime dependencies. The engine also needs the shared libraries listed in its metadata. Local proving requires the pinned RISC Zero 3.1.0 tools and Groth16 Docker backend. The engine metadata identifies those separate dependencies.

```sh
export UBC26_API=https://ubc26-159-89-149-133.sslip.io
export UBC26_RELEASE=0b35d3a5e327144045d04fe45084f6258bb23f3c
umask 077
mkdir -p client engine
curl --fail --proto '=https' "$UBC26_API/downloads/runner/$UBC26_RELEASE/ubc26-runner-0.2.0.tgz" -o client/ubc26-runner-0.2.0.tgz
curl --fail --proto '=https' "$UBC26_API/downloads/runner/$UBC26_RELEASE/SHA256SUMS" -o client/SHA256SUMS
curl --fail --proto '=https' "$UBC26_API/downloads/runner/$UBC26_RELEASE/release.json" -o client/release.json
curl --fail --proto '=https' "$UBC26_API/downloads/runner/$UBC26_RELEASE/ubc26-release.json" -o client/ubc26-release.json
(cd client && sha256sum --check SHA256SUMS)
npm install --offline --ignore-scripts --no-audit --no-fund --prefix "$HOME/ubc26-client" "$PWD/client/ubc26-runner-0.2.0.tgz"
export UBC26_CLI="$HOME/ubc26-client/node_modules/.bin/ubc26"
"$UBC26_CLI" help
curl --fail --proto '=https' "$UBC26_API/downloads/engine/$UBC26_RELEASE/ubc26-engine-linux-x64" -o engine/ubc26-engine
curl --fail --proto '=https' "$UBC26_API/downloads/engine/$UBC26_RELEASE/engine.json" -o engine/engine.json
chmod 700 engine/ubc26-engine
sha256sum engine/ubc26-engine
```

The expected archive SHA-256 is `f63ef047135b9d02f5e70f960e77cb348fbffaaa8ae061df79d22b1def31f836`.
The expected `release.json` SHA-256 is `563c12d650765271048f6b5480f95b2c427051f8ffeaed2b82afd027edcdbefb`.
The expected `ubc26-release.json` SHA-256 is `81ca7d96733378193ead6d443b4173f6b2f0553f6728f5f8bef77c0561b0fe03`.
The expected engine SHA-256 is `be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7`.
Verify each independent pin before selecting these files for protected operations.

## Own your API key

The following workflow applies after public readiness is enabled. Each caller signs an expiring service challenge with its wallet. Authentication signs a message and sends no chain transaction. The CLI saves the returned key in a private file.

```sh
mkdir -p "$HOME/ubc26-operator"
chmod 700 "$HOME/ubc26-operator"
"$UBC26_CLI" auth --api "$UBC26_API" --wallet "$BUYER_ADDRESS" \
  --keystore "$BUYER_KEYSTORE" --password-fd 3 \
  --key-out "$HOME/ubc26-operator/api-key" --idempotency login-001 \
  3<"$PASSWORD_FILE"
"$UBC26_CLI" key --api "$UBC26_API" --key-file "$HOME/ubc26-operator/api-key"
export UBC26_KEY_FILE="$HOME/ubc26-operator/api-key"
export UBC26_WORK="$HOME/ubc26-operator/work"
mkdir -p "$UBC26_WORK"
```

Keep wallet material and passwords local. API keys use `Authorization: Bearer KEY`. Store the key once and revoke it when no longer needed. The [API contract](api.md) defines challenge signing, ownership and revocation.

## Import, review and compile

[example-revision.json](example-revision.json) defines a supported integer product. [example-review.json](example-review.json) supplies its brief and passing/failing files. Download both beside this guide. The [schema](plan-v1.schema.json) and [capability catalog](capabilities.json) define the supported plan language.

```sh
"$UBC26_CLI" import --api "$UBC26_API" --key-file "$UBC26_KEY_FILE" \
  --input example-revision.json --idempotency import-001
"$UBC26_CLI" approve --api "$UBC26_API" --key-file "$UBC26_KEY_FILE" \
  --job "$JOB" --revision "$REVISION_HASH" --reference-digest "$REFERENCE_DIGEST" \
  --idempotency approve-001
"$UBC26_CLI" compile --api "$UBC26_API" --key-file "$UBC26_KEY_FILE" \
  --job "$JOB" --revision "$REVISION_HASH" --idempotency compile-001
"$UBC26_CLI" task --api "$UBC26_API" --key-file "$UBC26_KEY_FILE" --task "$TASK" --wait-ms 1800000
"$UBC26_CLI" download --api "$UBC26_API" --job "$JOB" --out "$UBC26_WORK/package"
"$UBC26_CLI" references --api "$UBC26_API" --job "$JOB" --out "$UBC26_WORK/reference"
```

Use the identifiers returned by each command. Check the exact rules and run passing and failing examples before approval. Poll the saved task after an interruption. Preserve its idempotency key.

The engine validates the typed plan. The buyer approves the rules. The compiler builds the checker. A local prover generates the proof.

## Fund, solve and recover

Request `funding-preview` for the exact revision, buyer, budget and absolute expiry. Review the five steps: create job, set budget, approve the exact token amount, fund, then register. API charges and the escrow bounty are separate. USDC amounts use six decimals. The API job identifier differs from the on-chain job number.

The `configure` command builds local operator configuration from the preview, deployment manifest, reviewed engine pins, wallet paths and private work directories. Use the published [Arc Testnet deployment manifest](open-claim-arc-testnet.json). The generated configuration disables signing. `operator preview` shows destinations, limits and deadlines. Explicit signing authority is required before `operator fund` or `operator run`.

After confirmed funding, the buyer uses `public-brief` to publish one short task description. Use `discover`, `job`, `download`, `references`, and `check` to inspect supported work. Produce deliverables locally. `operator prepare` proves against the actual funded context. `operator run` resumes claim and key release. `buyer-recover` checks confirmed chain data and exact SDK/engine output recovery without solver files. The buyer then runs an independent oracle. `operator refund` checks confirmed expiry before a refund. Preserve the private attempt directory and send journals after interruption.

The current bundle permits sixteen files and 16,384 encoded deliverable bytes. Its encrypted envelope permits 16,412 bytes. Proving and wallet signing stay local. A proof establishes the approved predicates over committed inputs. Buyer intent and external truth require separate checks.

See [api.md](api.md) for routes, examples, error states, discovery, funding and recovery boundaries. [release.json](release.json) records the documentation, API and client source identities.
