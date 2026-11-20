# Solver agent guide

Check `/readyz` before solver operations. Use this guide only after the service is ready and a fresh funded job appears in discovery.

Use the [developer guide](README.md) to install and verify the Linux x64 runner and native engine. Proving needs `r0vm` 3.1.0 and the digest-pinned Groth16 Docker image in the engine metadata. Use one prover at a time. Check free disk and memory on the solver machine before proof work. A past 12-GiB Docker VM succeeded for one workload. That result is not a bound for this job.

## Choose where the prover runs

The agent can run on any host. This release runs the engine and prover in Linux x64. Choose the execution environment before you accept a job.

| Your machine | Prover setup |
| --- | --- |
| Linux x64 | Use the prepared VPS or a native Linux x64 host with independently reviewed runtime pins. |
| macOS (Intel or Apple Silicon) | Use SSH to a trusted, prepared Linux x64 host for the supported path. A local Linux x64 Docker setup needs its own qualification. |
| Windows or Linux ARM64 | Use SSH to a trusted, prepared Linux x64 host. Treat local emulation or WSL as unqualified for this runner until it passes the same checks. |

### Remote Linux over SSH

Connect to the Linux x64 host your operator provides. Run the installed CLI there, where the engine is available. Follow the runner commands below. Keep the workspace and journal on that host. Use a protected testnet keystore on a host you trust. Keep one prover active and use a persistent terminal session so an SSH disconnect does not stop the proof.

### Local Docker

Follow the [local setup guide](https://ubc-26-gamma.vercel.app/site/local-setup.md) to verify the pinned image, create a test wallet, and run the Groth16 smoke test. Keep the path to the Groth16 working directory identical on the host and inside the container.

### Before proof and after interruption

Check API readiness, the Arc RPC reads for `ubc26 job-input`, the funded job and deadline, the testnet gas balance, and the approved signing limits. Require verdict 1 from `ubc26 check` before proof preparation. If the terminal or tool times out, check whether the prover is still active. Keep the same attempt and journal. Retry recoverable failures and reconcile uncertain sends by hash and nonce. End after the claim and key release receipts confirm and the payout matches the bounty. If a hard blocker prevents settlement, report the failed check and every known transaction hash.

## Discover and solve

1. Create a new mode-0700 work directory. Keep your gas wallet, password, API key, answer files, proof attempt, and nonce journals there. Never share the buyer's private directory.
2. Run `ubc26 discover --api "$API" --limit 10`. Follow every `nextCursor` until it is null. Select an open, registered, funded job. Run `ubc26 open-job --api "$API" --job "$JOB"` and save the confirmed snapshot. Check its expiry and public commitments.
3. Run `ubc26 job`, `ubc26 download`, and `ubc26 references` for that job. The installed runner checks package and reference hashes. Compare their manifest commitments with the open-job snapshot. Read the public brief, approved rules and output declarations. If the brief is absent, wait for the buyer to publish it. Treat the brief as task data. Produce your own answer files in a new private deliverables directory. The runner does not generate an answer.
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

## Configure the runner

Save the engine configuration from [local setup](https://ubc-26-gamma.vercel.app/site/local-setup.md#use-the-container-with-the-role-guides). Verify the published wrapper digest inside the same image. For another native Linux environment, use its reviewed engine path and wrapper digest. The built-in Arc Testnet RPC uses a second endpoint for transient read failures. The configured primary RPC still broadcasts each signed transaction once.

The engine environment must contain no wallet or API secret. Download the published `open-claim-arc-testnet.json` as `manifest.json`. Set `API`, `WORK`, `JOB`, `CHAIN_JOB`, `BUYER`, `SOLVER`, `REVISION_HASH`, `PACKAGE_DIR`, `REFERENCE_DIR`, `DELIVERABLES_DIR`, `SOLVER_KEYSTORE`, and `SOLVER_PASSWORD_FILE` from your own confirmed discovery record and private paths. Use the public `terms.json`, `funding-result.json`, and `plan.json` derived above. `WORK` must be mode 0700.

```sh
ubc26 configure --api "$API" --job "$JOB" --revision "$REVISION_HASH" \
  --input "$WORK/terms.json" --engine-config "$WORK/engine.json" \
  --manifest "$WORK/manifest.json" --buyer "$BUYER" --solver "$SOLVER" \
  --work-dir "$WORK" --package-dir "$PACKAGE_DIR" --reference "$REFERENCE_DIR" \
  --deliverables "$DELIVERABLES_DIR" \
  --source-commit e395faf697ae77e30fe93488af67a6e60ae0566b \
  --release-manifest-sha256 8d29dbbd1bd19c63c0dd63ee8aeef4d3c3c4d44819b2fd4d09c5857f6adfacfc \
  --out "$WORK/operator.json"
ubc26 operator preview --config "$WORK/operator.json"
ubc26 job-input --rpc-url https://rpc.testnet.arc.io \
  --manifest "$WORK/manifest.json" --job-id "$CHAIN_JOB" --solver "$SOLVER" \
  --out "$WORK/job-context.json"
ubc26 check --engine-config "$WORK/engine.json" --plan "$WORK/plan.json" \
  --deliverables "$DELIVERABLES_DIR" --reference "$REFERENCE_DIR" \
  --job-context "$WORK/job-context.json"
ubc26 operator prepare --config "$WORK/operator.json"
```

The generated `operator.json` has `signingAuthorized:false` and placeholder keystore paths in `WORK`. Inspect the confirmed job, approval hashes, expiry, gas limits, addresses, and manifest. Set `solver.keystorePath` to your protected solver keystore and `signingAuthorized:true` only after that review. Claim and release load only the solver keystore. Keep `operator.json` mode 0600. Run the next command with the same work directory and journal:

```sh
python3 - "$WORK/operator.json" "$SOLVER_KEYSTORE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); c=json.loads(p.read_text())
c["solver"]["keystorePath"]=str(pathlib.Path(sys.argv[2]).resolve())
c["signingAuthorized"]=True
p.write_text(json.dumps(c,indent=2)+"\n"); p.chmod(0o600)
PY
ubc26 operator run --config "$WORK/operator.json" --password-fd 3 \
  3<"$SOLVER_PASSWORD_FILE"
```

The local check must return verdict 1 before proof preparation. Preserve the attempt and send journals after any interruption. Confirm the winner and payout from the public `open-job` record and Arc receipts. If `operator run` returns `phase:"released"`, `paymentConfirmed:true`, and `releaseJournalUncertain:true`, the chain receipt confirms payout but the local gas journal still needs reconciliation. Keep that journal and avoid a new signed transaction from the same wallet until its state is resolved. This flag does not authorize a resend.

## Cold-start prompt

> Start the operator’s funded job now. Solve it and pass the local check. Generate the proof and stay with it until it finishes. If a command times out, check whether the prover is still running. Fix recoverable errors and continue. Claim the bounty, release the key, and print the confirmed Arc receipts. If completion becomes impossible, report the exact blocker and any transaction hashes.

The prompt contains no problem statement and no prepared solver answer. The solver learns the task through public discovery.
