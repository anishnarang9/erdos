# Open-job discovery

Worker B. Branch `codex/hosted-qualification`. This file records the server side of `GET /v1/open-jobs`. The coordinator owns `docs/hosted-api-contract.md`. This edit does not revise that file.

## Contract

The route accepts only `cursor` and `limit`. The route rejects a repeated field. `limit` is an integer from 1 to 50. An omitted limit means 50. The cursor is opaque. Its canonical form uses unpadded base64url of `oc1`, a newline, and the 26-character job id. A longer cursor, a bad charset, a wrong version, or a non-canonical encoding returns 400 `validation_failed`.

The response is `{jobs, nextCursor}`. `nextCursor` is a string or null. Order is `job_id` ascending. The cursor names the last link scanned in that window, including a link the page omits. A page may be shorter than `limit`. Null means the scan reached the end. The route does not return the request cursor. A cursor past the last id returns an empty page and null.

Each request reads at most `limit` links. It reads at most one confirmed snapshot for each of those links. The extra row that proves another page exists is not a chain read. The SQL statement takes the cursor and the limit as parameters.

The feed keeps a job only when that same confirmed snapshot says `Funded`. The snapshot also has no accepted submission and `released` false. Its `timestamp` is before `job.expiry`. Host `Date.now` and the terms clock do not make that comparison. A funded job past that timestamp leaves the feed before a refund. Detail still returns that job. `status` stays the chain status. `expired` is true only for that same-snapshot comparison. `released` stays the snapshot flag. Detail does not claim a refund from the host clock.

A table with no links returns `{jobs: [], nextCursor: null}`. That result does not call the chain. A reader that throws returns 503 `chain_unavailable`. A non-empty link list with no chain config returns the same code. The body omits provider URLs and the job list. The scan skips a stale link, a mismatched manifest, or a voided approval. The cursor still moves forward.

Detail of a chain-terminal job still requires API state `open_registered`. A direct write of another state returns 409 `terms_mismatch` with field `API state`. That failure happens before the snapshot read. The Arc indexer stores logs and a block cursor. It does not write `jobs.state`. Approval, deployment, manifest, and intent revision bindings stay as they are. Migration 019 is absent. The keyset cursor needs no new table.

## Tests

The new cases failed on the old list route. They passed after the server edit. `commerce/api` vitest then ran `test/unit/open-claim-discovery.test.ts` and `test/unit/open-claim-routes.test.ts`. 14 tests passed and 0 failed. `tsc -p commerce/api/tsconfig.json` passed with no errors. Node was v24.10.0. The suite used fixture readers. It did not call a live RPC.

The cases cover 55 open jobs on pages of 10. They also cover a no-argument page of 50. Every returned id appeared once. They cover a funded expired job and filtered or stale pages. They cover bad query values and a four-job read bound. They cover snapshot time against the host clock. They cover terminal detail, a down reader, and a missing chain config. They cover an empty link table. Source, owner, link, and manifest rows stayed the same.

## Still open

No public host ran. The 180 real trials did not run. Live acceptance did not run. A confirmed `expired` flag is not a refund. Root will read the real host network later. This branch did not rerun the earlier 893 API tests. Worker A attempt tests were outside this run. The frozen corpus digest `2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470` stayed the same. Real model calls remain 0.
