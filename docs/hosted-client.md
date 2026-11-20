# UBC-26 local buyer and solver runner

Status: source implementation. A public service URL and final release evidence remain pending. Do not use historical proof reports as evidence for a new job.

Results become public when the solver broadcasts the release key. The runner proves and settles supplied files. A person or another agent must produce those files.

## Install and check provenance

Native Linux is the first supported release target. The prerelease [runner](hosted-runner-downloads.md) and separate [Linux x64 engine](hosted-engine-downloads.md) are available. Use Node.js 24 or later. Install the pinned native RISC Zero 3.1.0 engine separately as an independent regular file. Build directories can contain hard-linked binaries; copy the reviewed artifact with `install -m 700 BUILT_ENGINE PRIVATE_ENGINE_PATH` and verify its published digest. The protected runner rejects linked executable files. Proving needs the pinned guest toolchain, Docker Groth16 backend and enough memory. Historical Mac runs used a 12-GiB Docker VM and took about 18 minutes for the funded workload. These measurements do not predict another workload's runtime.

A release contains `ubc26-runner-0.2.0.tgz`, `SHA256SUMS`, `release.json` and the standalone `ubc26-release.json` manifest. Download all four files to one directory. Verify them against independently published checksums. Install the checked local archive:

```sh
sha256sum --check SHA256SUMS
npm install --prefix "$HOME/ubc26-client" ./ubc26-runner-0.2.0.tgz
"$HOME/ubc26-client/node_modules/.bin/ubc26" help
```

The package contains the runner and hosted TypeScript client. It does not need a Git checkout or development workspace dependencies. It does not include an engine binary. Keep the release manifest SHA-256 and source commit from the reviewed release metadata. Signing from an installed package requires both pins. Run `ubc26 verify-install --source-commit "$RELEASE_SOURCE_SHA" --release-manifest-sha256 "$RELEASE_MANIFEST_SHA256"` to check the installed files. The runner repeats this check before protected operations. Modified, missing, extra or linked files fail the check.

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
ubc26 accept-draft --api "$API" --key-file "$KEY_FILE" --task "$DRAFT_TASK" \
  --input draft.json --idempotency create-from-draft-001
ubc26 job --api "$API" --job "$JOB"
ubc26 approve --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --revision "$REVISION_HASH" --reference-digest "$REFERENCE_DIGEST" --idempotency approve-001
ubc26 compile --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --revision "$REVISION_HASH" --idempotency compile-001
ubc26 task --api "$API" --key-file "$KEY_FILE" --task "$TASK" --wait-ms 1800000
ubc26 download --api "$API" --job "$JOB" --out "$WORK/package"
ubc26 references --api "$API" --job "$JOB" --out "$WORK/reference"
```

`accept-draft` creates a job from a successful draft task. It preserves the draft ID and the original request's reference bytes. It does not approve the rules. Keep `draft.json` until this step completes. Clarification and unsupported responses cannot become jobs through this command.

Use `import --input revision.json` instead of `draft` to import exact rules. Add `--reference /absolute/reference-directory` when the revision commits reference files. Read the complete rules, examples, assumptions and requirement coverage before approval. A material revision invalidates approval.

Task states are queued, running, succeeded, failed and uncertain. Preserve each returned task identifier. Resume polling that identifier after interruption. Polling does not submit another model call or compilation. An uncertain task requires reconciliation. Do not replace its idempotency key to force a retry.

Reuse the same idempotency key only for the same request bytes and purpose. A new key can create new paid work. The client never retries mutations automatically.

The package downloader checks file hashes, package commitments and the guest digest. Reference download checks the complete canonical reference hash. Package and reference directories must be new paths inside a private parent directory.

Discovery uses `ubc26 discover --api "$API"`. The client also accepts `--limit 10` and `--cursor "$NEXT_CURSOR"` under the [paginated contract](hosted-api-contract.md#discovery-pagination). Follow the returned `nextCursor` until it is null. The client stops if a server ignores pagination or repeats a cursor. The integrated server implements this contract with bounded scans and confirmed-time expiry. A 503 dependency failure requires retrying the same cursor; it does not mean the scan ended.

## Review constraints with Grok Bot

When Bot review is enabled, request it before buyer approval. `review.json` contains `examples` and an optional `request`. Each example supplies its exact files and predicted verdict. Supply one passing and one failing example. The server checks both before dispatch. For Grok revisions, the server uses the stored buyer brief and answers. Imports must supply their brief.

```sh
ubc26 request-bot-review --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --revision "$REVISION_HASH" --input review.json --idempotency review-001
ubc26 bot-review --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --review "$BOT_REVIEW_ID" --wait-ms 60000
```

HTTP 202 saves acceptance and can still report queued. Polling reads the existing review. A webhook acknowledgement never counts as a pass. Uncertain delivery stops automatic dispatch. If Bot requests changes or clarification, revise the job and review the new revision.

After inspecting a passed result, explicitly select its receipt during buyer approval:

```sh
ubc26 approve --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --revision "$REVISION_HASH" --reference-digest "$REFERENCE_DIGEST" \
  --bot-review "$BOT_REVIEW_ID" --idempotency approve-001
```

Grok drafts still require the separate coverage digest and native example-check selection described below. Add those flags to this approval. Bot cannot sign, fund or approve a job.

The current production profile supports callback bootstrap with paid dispatch disabled. One genuine synthetic negative review and rejected approval pass. Rounded account changes suggest eight to nine cents for that review. The five-cent target and complete authoring ceiling remain unverified. See the [live Bot design](hosted-grok-bot-authoring.md). The SDK exposes `requestBotReview`, `botReview` and `waitForBotReview` through the same owner credential.

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

For signed-evidence rules, add `--evidence "$WORK/evidence"` to `configure`. Supply attestations for the exact funded job and solver. The runner copies their exact bytes into the private attempt and passes that directory to the prover. Evidence permits at most 16 files and 32,768 encoded bytes, including names and headers. The engine checks signatures, approved issuers and context bindings.

Export the actual funded context before requesting those attestations. This command uses confirmed read-only chain checks. It needs no wallet password or API key:

```sh
ubc26 job-input --rpc-url https://rpc.testnet.arc.io \
  --manifest "$DEPLOYMENT_MANIFEST" --job-id "$CHAIN_JOB" --solver "$SOLVER" \
  --out "$WORK/job.json"
ubc26 check --engine-config "$WORK/engine.json" --plan "$PLAN_JSON" \
  --deliverables "$WORK/deliverables" --reference "$WORK/reference" \
  --evidence "$WORK/evidence" --job-context "$WORK/job.json"
```

A preview context is not evidence of chain funding. A signed example for another rules hash, reference hash, job or solver cannot authorize this attempt. A signature rejection is distinct from checker verdict 0. The installed `check` command returns verdict JSON with exit 0 for a valid checker result, including verdict 0. A rejected check returns `{status:"check-rejected",reason,mode:"check-only",proofGenerated:false,transactionSent:false}` with exit 1. The reason is a fixed public code. Raw engine messages and local paths remain private.

Use one shared private `proverLockRoot` for every runner on the machine. The runner refuses a second prover. It never removes a stale lock automatically. Run your solver separately and place its files in the deliverable directory.

```sh
ubc26 operator fund --config "$WORK/operator.json" --key-file "$KEY_FILE" --password-fd 3 3<"$BUYER_PASSWORD_FILE"
ubc26 operator prepare --config "$WORK/operator.json"
ubc26 operator run --config "$WORK/operator.json" --password-fd 3 3<"$SOLVER_PASSWORD_FILE"
ubc26 operator recover --config "$WORK/operator.json"
```

`prepare` generates a local proof for the actual funded context. `run` resumes the protected claim/release flow. A losing solver releases no key. Recovery reads confirmed public chain data and checks both SDK and engine output. Use `operator refund` with the approved buyer configuration after confirmed expiry. `operator circle` uses the existing separate paid-compilation authorization and exact-replay journal.

If the engine published the proof before an interruption, run `prepare` again with the same config. It checks the saved context, image, key commitment, and recovered files. It records a valid result without starting another proof or submitting a transaction. An incomplete proof package still requires manual recovery.

Each new solver attempt receives a persistent UUID. `ubc26 attempt --state "$WORK/attempt/state.json" --after-cursor 0` returns a sanitized local status. Its events use `(attemptId,cursor)` pairs. Resume with the last cursor for that attempt. The view omits release keys, local paths and free-form details. A rejected attempt does not reject the entire bounty. Confirmed chain state remains authoritative for winner and payment. Publish progress only through the explicit command below.

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


## Review exact authored examples

A successful draft task includes normalized rules, source quote checks, requirement links, `exampleInputs` and checked verdict labels. Review them before approving. The coverage flag checks finite links and leaves semantic intent to buyer review and independent qualification.

If signed examples need a new witness for the exact returned plan, prepare a protected JSON file containing only `{examples:[...]}`. Use complete deliverable files, optional evidence and exact preview context. The API never signs attestations.

```sh
ubc26 check-examples --api "$API" --key-file "$KEY_FILE" --draft "$DRAFT_ID" \
  --revision "$REVISION_HASH" --input "$WORK/examples.json" --idempotency examples-001 \
  > "$WORK/example-check.json"
ubc26 approve --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --revision "$REVISION_HASH" --reference-digest "$REFERENCE_DIGEST" \
  --coverage-digest "$COVERAGE_DIGEST" --example-check "$EXAMPLE_CHECK_ID" \
  --idempotency approve-001
```

Use only an actual successful `exampleCheckId` for that owner, draft and revision. Omit `--example-check` to select the immutable initial check. Public authored approval still requires the exact coverage digest. A later witness record cannot replace the original task response or qualify different rules. Signature rejection is not verdict 0. No command here authorizes funding or signing.

## Publish and read solver progress

Use an API key issued to the local attempt's solver wallet. The CLI checks that wallet before any upload. It reads the protected state file, selects only public progress fields, and submits one batch of at most 20 events. It omits release keys, signing state, private paths, plaintext and free-form details. Local history over 200 events rejects before publication. The command does not sign, prove or send a chain transaction.

```sh
ubc26 publish-attempt --api "$API" --key-file "$SOLVER_KEY_FILE" --job "$JOB" \
  --state "$WORK/attempt/state.json" --after-cursor 0 --idempotency attempt-batch-001
ubc26 attempts --api "$API" --job "$JOB" --limit 20
ubc26 hosted-attempt --api "$API" --job "$JOB" --attempt "$ATTEMPT_ID" --after-cursor 0
```

If `resumeLocalCursor` is non-null, submit the next explicit batch with that `--after-cursor` and a new idempotency key. Preserve the exact cursor and request identity after uncertainty. Reusing the original key requires the same request body; a changed local file can change that body. Public history reads return up to 50 events. Follow their `resumeCursor` while non-null. Their `nextCursor` is the high-water mark, not an unfinished page's resume position.

Published phases and transaction hashes remain solver reports. They cannot confirm a winner, payment or refund. Use the confirmed open-job snapshot for those claims. See the [attempt route contract](hosted-api-contract.md#hosted-solver-attempts).

The native engine CI job also builds a standalone archive, installs it outside the checkout, checks its pinned provenance, and runs `commerce/worker/scripts/check-installed-native.mjs` against the actual native Linux engine. The script generates fresh synthetic signed fixtures for four frozen workloads, checks an independent oracle, and tests pass, valid verdict 0 and signature rejection. It performs no proof or chain action. Keep the CI report's platform and source SHA with release evidence. A Mac run or emulated container run does not substitute for that native Linux result.

The native Linux check passes at source `5991bd2` on x64 Ubuntu with Node 24.22.2. The [report](../agents/anish/reports/hosted-runner-native-linux-2026-11-17.json) records the installed archive/manifest and actual engine digests. The first CI run used Cargo's two-link build artifact and hit the existing provenance guard. Installing a separate mode-0700 engine copy fixed that setup. Final source artifacts still need their own provenance and acceptance check after remaining service changes.
