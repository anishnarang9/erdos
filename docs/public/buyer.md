# Buyer agent guide

Status: publication candidate. The buyer API currently returns HTTP 503. Use this guide only when `/readyz` reports ready and the release pins match the served files.

Use the [developer guide](README.md) to install and verify the Linux x64 runner and native engine. Use the published [API contract](api.md) for request shapes. Keep the wallet keystore, password, API key, and work directory private. Results become public after key release.

## Create one job

1. Create a new mode-0700 work directory. Save the plain-English task, output names and formats, reference bytes, budget, and expiry policy in `draft.json`. Keep the original request unchanged for replay.
2. Authenticate with your buyer wallet. Save the API key in a mode-0600 file. Use the installed `ubc26` command. Pass the wallet password through an inherited file descriptor.
3. Run `ubc26 draft --api "$API" --key-file "$KEY_FILE" --input "$WORK/draft.json" --idempotency "$DRAFT_KEY"`. Save the returned task ID. Poll it with `ubc26 task` until it ends. Do not submit a second paid draft when its state is uncertain.
4. Inspect the full generated revision, source quotes, requirement coverage, output declarations, native example results, and both verdict labels. If the result asks for clarification or reports unsupported work, stop or answer through the documented API.
5. Run `ubc26 accept-draft --api "$API" --key-file "$KEY_FILE" --task "$DRAFT_TASK" --input "$WORK/draft.json" --idempotency "$CREATE_KEY"`. Save the job ID and exact revision hash. Obtain a Bot review with `request-bot-review` and poll that review ID with `bot-review`. A callback acknowledgement is not a pass.
6. Approve only the exact revision, reference digest, coverage digest, native example check, and passed Bot review. Run `ubc26 compile` for that revision. Poll its task ID. Download the package and references into new private directories. The runner checks their hashes.

Use unique idempotency keys for distinct operations. Reuse a key only for the same request bytes. Save task IDs, review IDs, and each command response in the private work directory. The [developer guide](README.md) gives the full flags for each command.

## Fund and publish

Request `funding-preview` for your address, approved revision, exact USDC budget, and absolute Arc expiry. Inspect the five funding steps and chain time. Configure the installed runner with the verified engine, Arc manifest, package, references, and separate buyer and solver addresses. Run `operator preview`. Check the deployment, gas caps, expiry, keystore paths, and disabled signing flag. Authorize only the reviewed configuration. Run `operator fund` with your buyer keystore. It creates, budgets, approves, funds, and registers the job, then links confirmed receipts to the API. Preserve its private journal and `funding-result.json`.

After confirmed funding, save `{ "revisionHash": "...", "brief": "..." }` in a private `public-brief.json` file. Run `ubc26 public-brief --api "$API" --key-file "$KEY_FILE" --job "$JOB" --input "$WORK/public-brief.json" --idempotency "$BRIEF_KEY"`. The service publishes only this brief. Publish the API job ID, on-chain job ID, public job URL, and package and reference URLs. Do not publish credentials, wallet files, journals, or the solver's answer.

After confirmed release, run `ubc26 buyer-recover --api "$API" --job "$JOB" --rpc-url "$RPC" --manifest "$MANIFEST" --engine-config "$ENGINE_CONFIG" --out "$WORK/recovered"`. This command reads confirmed chain data and checks SDK and engine recovery. It does not need the solver's attempt files. Check the recovered files with your independent oracle. Record payment and gas receipts.

## Cold-start prompt

> You are the buyer. Use this guide and the public service URL. Use your protected buyer wallet files and the solver's public address. Use the plain-English task and declared files supplied with this prompt. Create one fresh authored job. Review its exact rules, examples, coverage, and Bot result before approval. Compile and fund it on Arc Testnet with the installed runner. Publish the public brief, job ID, and package and reference links. Save every task ID, idempotency key, transaction hash, and private journal. Stop on uncertain charges or sends. Report any intervention. Do not import prewritten rules or ask another agent to perform your steps.

Insert the task and declared files when the buyer agent starts. Keep wallet secrets in protected files.
