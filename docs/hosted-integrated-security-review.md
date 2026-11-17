# Integrated security review

Worker B. Read-only review of integrated root `8c98d6b`. HEAD `f94d3c7` is a merge. Its tree matches that root. This review did not edit product code or tests. It did not publish the merge again.

## Result

No new material defect in the reviewed paths.

Solver publication stays on an allowlist. The server binds the attempt to the authenticated wallet and to the linked chain. Confirmation flags stay false. History stays bounded. Image pins and public deployment manifests fail closed. The prewarm consumer accepts a real `0x` guest digest and still rejects a bad record. Backup and restore keep an integrity pin. Unknown authoring usage stays uncertain and does not settle twice. The installed-native script distinguishes a bad signature from verdict 0. This session did not execute that engine.

## Attempt publication

`hostedAttemptInput` in `commerce/sdk/src/hosted/client.ts` allows `version`, `attemptId`, `events`, `chain`, `reportedClaimTx`, `reportedReleaseTx`, and `reportedWinner`. An event allows `cursor`, `reportedAt`, and `phase`. A batch holds at most 20 events. A cursor is an integer from 1 to 200 and must rise.

`prepareHostedAttempt` in `commerce/worker/src/open-claim/attempt-status.ts` copies only those fields. A release key, a directory, and event detail text do not enter the POST body. The CLI `publish-attempt` command requires the current API wallet to equal the local solver. It then posts that body. The returned object adds three local cursor numbers. It does not add `paymentConfirmed`.

The local `attempt` command prints the file value `paymentConfirmed`. That command does not POST. It is local inspection.

`commerce/api/src/attempts.ts` repeats the same body allowlist. The stored solver is `principal.wallet`. A body cannot name a solver. A different wallet receives 403 `forbidden`. A different job receives 409 `wrong_state`. A posted chain must match `open_claim_links`. An omitted chain copies that link when one exists. Optional reported fields cannot move after the first stored value.

`summaryOf` sets `progress` to `solver-reported`. It sets `confirmedPayment` false, `confirmedWinner` null, and `confirmedRefund` false. The SDK rejects any other confirmation value. It also rejects a job id, an attempt id, or an echoed event that differs from the request.

New cursors must follow the stored high water with no gap. An identical cursor is an acknowledgement. A conflicting phase or time at the same cursor returns 409. The high water cannot pass 200. Detail reads at most 50 events. `nextCursor` is the high water. `resumeCursor` equals the last returned cursor only when more events remain. Otherwise it is null.

## Image, prewarm, backup

`imageEnvironment` in `deploy/start-api.mjs` reads five regular pin files from the image root. A symlink, a hard link, a bad pattern, or a conflicting operator value throws `Image configuration rejected`. The returned object omits `XAI_API_KEY`.

`assertPublicDeployment` runs only when `DEPLOYMENT_MODE` is `public`. It loads both deployment manifests as regular files. It requires chain `5042002`, status `frozen` and `deployed-verified`, and equal core, USDC, and verifier addresses. RPC URLs must be https, with a hostname, and without userinfo or a hash. Confirmations are at least 3. Every failure becomes `Image deployment configuration rejected`.

The open-claim policy hook is a zero address because the adapter is the evaluator. The market `CHAIN_HOOK` comes from the other manifest. Those fields name different roles. The loader does not treat them as one pin.

`compilerReadyCheck` in `commerce/api/src/ready.ts` accepts `guestSha256` as optional `0x` plus 64 hex characters. It also requires version 1, status `compiler-warmed`, verdicts 1 and 0, and the same source, engine, frontend, and builder identity. A warming, corrupt, or mismatched record is not ready. `/readyz` then returns 503. `blocksPublicListen` stays false for that record. A wrong image identity still blocks public listen. That split is the existing gate in `server.ts`.

`deploy/backup-state.sh` stops the API container, then runs `state.mjs` with `--quiesced`. The backup process has no API env file, no network, and no Docker socket. `restoreState` requires a 64-hex manifest pin. It rejects a symlink, a hard link, an extra file, and a mismatched digest. The copy keeps `service.db` and `packages/` only.

## Installed archive

`commerce/worker/scripts/check-installed-native.mjs` runs `node_modules/.bin/ubc26` inside the installation path. Its CLI environment contains `PATH` and `HOME` only. The engine process is `env -i` with `PATH` only. `engineIdentity` rejects an environment name that contains `KEY`, `TOKEN`, `PASSWORD`, or `SECRET`.

`signingKey` in `engine/evaluation/hosted-qualification/shape.mjs` is an in-memory synthetic constant. `writeCandidateEvidence` writes the signature envelope. It does not write that private key. The `finally` block deletes the work directory. Report rows store the oracle status and, on rejection, a reason code.

A local corpus load found four supported signed workloads. Each has a pass candidate, a fail candidate with expected status `fail`, and `invalid-signature` with expected status `reject`. The script requires 12 rows. A reject result must exit 1 with status `check-rejected`, `proofGenerated` false, and `transactionSent` false. A pass or fail result must exit 0 with verdict 1 or 0. `CORPUS_DIGEST` is `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470`.

`.github/workflows/commerce.yml` builds the archive, installs it outside the checkout, and runs `verify-install` against the job commit and the manifest pin. It does not run `check-installed-native.mjs`. That missing engine job is the pending native Linux CI. It is not a new defect. This review did not execute the native engine.

## Spend, drain, and replay

`quoteAuthoringCost` in `commerce/api/src/tasks.ts` returns null when `promptTokens` is 0 or `reasoningTokens` is null. `authoringCharge` keeps a safe nonnegative tick count, including 0, as source `actual`. In `commerce/api/src/grok.ts`, only model `grok-4.20-0309-non-reasoning` fills a missing reasoning count with 0. Other slugs stay null and therefore have no tariff.

When any attempt has no charge, `commerce/api/src/authoring.ts` sets billing `{state:"uncertain"}` and omits `microUsd`. `settleKnown` updates a row only while `state` is `reserved` and requires one change. `settleUnknown` sets `uncertain` and does not write `settled_micro_usd`. A second call does not settle that reservation again. Daily spend still counts the ceiling for an uncertain row.

`drainTasks` calls `cancelDraftRequests`. A dispatched draft that is still running becomes uncertain. `reconcileTasks` marks a running draft uncertain and does not queue that draft again. A running compile can queue again. Ancestors `49d56e9`, `9cba871`, and `92ef0c3706f71ebcde3d687429ac47ae46e470a3` are in this tree.

## Detail dependency errors

`view` in `commerce/api/src/open-claim.ts` catches every error from `reader.current`. It throws `chain_unavailable` with the static text `Open-claim chain is unavailable`. The detail test expects HTTP 503 and a body without the fixture RPC URL. `chainReadFailed` already mapped both `chain_unconfirmed` and `chain_unavailable` to that same static 503 on the list route. Detail now matches the list. A typed 409 from registration still returns, because registration does not call `view`. A raw error outside `view` becomes generic HTTP 500. Public `logInternal` omits the error value.

## Limits

No public host ran. No genuine Grok call ran. Image `92ef0c3` evidence remains the earlier isolated Linux report. This session did not rerun that image. The synthetic model credential in that report stayed unused. The 180 paid trials did not run. Fresh funded acceptance did not run. Worker A CORS work and the paid waiter were outside this tree. A finite rule test is not natural-language intent. Real model calls remain 0. The frozen digest stayed the same.

## Commands

All commands exited 0. Node was v24.10.0. No compiler, guest build, prover, model, chain, RPC, container, or paid call ran.

`node --test deploy/start-api.test.mjs deploy/public-deployment.test.mjs deploy/state.test.mjs` passed 9 tests and failed 0.

`node --input-type=module` loaded `buildCorpus` and `CORPUS_DIGEST` only. It printed digest `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470` and the four workload rows above.

From `commerce/api`, vitest 5.1.0 ran `test/spec/hosted-billable-bound.test.ts`, `test/unit/ready-prewarm-wire.test.ts`, `test/unit/open-claim-discovery.test.ts`, and `test/unit/open-claim-routes.test.ts`. 21 tests passed and 0 failed. A second API run of `test/unit/attempts.test.ts` passed 5 tests and failed 0.

From `commerce/sdk`, vitest ran `test/hosted/attempts.test.ts`. 5 tests passed and 0 failed.

From `commerce/worker`, vitest ran `test/unit/hosted-attempt-publication.test.ts` and `test/unit/attempt-status.test.ts`. 6 tests passed and 0 failed.
