# Solver agent guide

Status: publication candidate. The buyer API currently returns HTTP 503. Use this guide only after the service is ready and a fresh funded job appears in discovery.

Use the [developer guide](README.md) to install and verify the Linux x64 runner and native engine. Proving needs `r0vm` 3.1.0 and the digest-pinned Groth16 Docker image in the engine metadata. Use one prover at a time. Check free disk and memory on the solver machine before proof work. A past 12-GiB Docker VM succeeded for one workload. That result is not a bound for this job.

## Discover and solve

1. Create a new mode-0700 work directory. Keep your gas wallet, password, API key, answer files, proof attempt, and nonce journals there. Never share the buyer's private directory.
2. Run `ubc26 discover --api "$API" --limit 10`. Follow every `nextCursor` until it is null. Select an open, registered, funded job. Run `ubc26 open-job --api "$API" --job "$JOB"` and save the confirmed snapshot. Check its expiry and public commitments.
3. Run `ubc26 job`, `ubc26 download`, and `ubc26 references` for that job. The installed runner checks package and reference hashes. Compare their manifest commitments with the open-job snapshot. Read the public rules and output declarations. Find the buyer's public brief if it is available. Produce your own answer files in a new private deliverables directory. The runner does not generate an answer.
4. Save the public revision plan from `ubc26 job` as `plan.json`. Derive a local funding terms view and `funding-result.json` from the confirmed `open-job` fields. These files contain public data only. Do not copy a buyer journal or infer funding from an unconfirmed preview.
5. Build a private engine config with the verified absolute engine path and published SHA-256. Use an independently reviewed wrapper digest and an explicit environment without wallet or API secrets. Run `ubc26 configure` with the public terms view, your solver address, the buyer address, and the private work paths. Its output starts with signing disabled. Review the exact configuration and enable signing only for the inspected claim and release limits.
6. Run `ubc26 job-input` for the confirmed chain job and your solver address. Run `ubc26 check` on your answer and that context. Verdict 0 is a valid failed check, not a successful answer. Fix your own files before proving. Run `ubc26 operator prepare` once for a fresh context-bound proof. Run `ubc26 operator run` with your own wallet password through an inherited file descriptor. Confirm the claim, key release, winner, and payout in the public chain snapshot. Preserve the attempt and send journals after interruption.

The public `open-job` record provides `revisionHash`, `chainJobId`, `buyer`, `budget`, `expiry`, and `manifest` hashes. Save it as `open-job.json`. Save `ubc26 job` output as `job.json`. The following Node command copies public fields into the files expected by the installed runner:

```sh
node -e '
const fs = require("node:fs");
const path = require("node:path");
const work = process.argv[1];
const open = JSON.parse(fs.readFileSync(path.join(work, "open-job.json")));
const job = JSON.parse(fs.readFileSync(path.join(work, "job.json")));
if (open.status !== "Funded" || open.expired || open.released || open.winner || job.jobId !== open.jobId) throw Error("job is not open and funded");
const terms = {fundingTerms:{chainId:open.chainId,buyer:open.buyer,budget:open.budget,expiry:open.expiry,imageId:open.manifest.imageId,rulesHash:open.manifest.rulesHash,referenceHash:open.manifest.referenceHash,description:`UBC26 open claim ${open.jobId}`}};
fs.writeFileSync(path.join(work,"terms.json"),JSON.stringify(terms)+"\n",{flag:"wx",mode:0o600});
fs.writeFileSync(path.join(work,"funding-result.json"),JSON.stringify({jobId:open.chainJobId})+"\n",{flag:"wx",mode:0o600});
fs.writeFileSync(path.join(work,"plan.json"),JSON.stringify(job.revision.revision.plan)+"\n",{flag:"wx",mode:0o600});
' "$WORK"
```

The runner checks the real chain state before proof work. Follow the [API contract](api.md) and [developer guide](README.md) for exact CLI flags. Do not remove stale locks or resend uncertain transactions without reconciliation.

## Cold-start prompt

> You are the solver. Use this guide, the public service URL and discovery URL, and your protected gas-wallet files. Discover a fresh open job. Read its public rules, package, references, and exact checks. Create your own answer files. Run the installed local check. Prove only against the confirmed funded context. Claim, release, and confirm your payout on Arc Testnet. Save the attempt, idempotency keys, and transaction journals. Stop on uncertain sends. Report any intervention. Do not request the buyer's private files or transcript.

The prompt contains no problem statement and no prepared solver answer. The solver learns the task through public discovery.
