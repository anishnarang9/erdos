# Erdos | Meridian Kiln two-terminal demo

Run this demo from two terminal agents on Linux x86-64. Give each agent this guide URL
and local access to its own funded Arc Testnet wallet. Use separate V3 keystores and
private password files. Each agent needs its wallet address and the local file paths.
Keep wallet secrets out of the prompt, logs, and recording.

**Buyer prompt:** “Read this link. Run the buyer section for one Meridian Kiln
bounty with your configured Arc Testnet wallet. Give me the solver handoff link.”

**Solver prompt:** “Go for it. Read this link and run the solver section for the
job in the link. Use your configured Arc Testnet wallet.”

The buyer imports the reviewed Meridian checker and gets a Grok Bot review.
The solver finds a feasible schedule and proves it after funding. The bounty is
0.01 testnet USDC. Use the designated buyer pilot wallet. Before running, the
operator must confirm that a Bot review is available and authorize one dispatch
on the connected account. An ordinary funded wallet can run the solver role.
The hosted fresh-draft pilot has no remaining draft slots.

## Shared setup

Set `GUIDE` to the URL received. The link can include `?job=API_JOB_ID`. Use a
fresh private absolute `WORK` path for each role. Keep it for retries. Use the
direct API origin for authenticated requests. Run these commands in Bash.
Stop when any command fails.

```sh
set -euo pipefail
umask 077
export SITE="${GUIDE%%/site/meridian.md*}"
export API=https://ubc26-159-89-149-133.sslip.io
export RPC=https://rpc.testnet.arc.io
export RELEASE=0b35d3a5e327144045d04fe45084f6258bb23f3c
export RELEASE_HASH=81ca7d96733378193ead6d443b4173f6b2f0553f6728f5f8bef77c0561b0fe03
export ENGINE_HASH=be5c06f9c62e0b0f934974593735d4b3a49d65d477ab3a2dcdb18e21a1c4e3d7
export WRAPPER_HASH=289ec362c6c0084e3f932e4512a77037884999ce6bbe8b4a66a3347d19bc356d
export DOCS="$API/downloads/docs/ff05a357ef6b4afcc177ede91c7e61f636cb7272"
mkdir -m 700 "$WORK"
cd "$WORK"
curl -fsS "$API/readyz" | jq -e '.ready'
curl -fsS "$API/downloads/runner/$RELEASE/ubc26-runner-0.2.0.tgz" -o runner.tgz
echo 'f63ef047135b9d02f5e70f960e77cb348fbffaaa8ae061df79d22b1def31f836  runner.tgz' | sha256sum -c
npm install --offline --ignore-scripts --no-audit --no-fund --prefix "$WORK/client" "$WORK/runner.tgz"
export UBC="$WORK/client/node_modules/.bin/ubc26"
"$UBC" verify-install --source-commit "$RELEASE" --release-manifest-sha256 "$RELEASE_HASH"
"$UBC" wrapper-digest | jq -e --arg expected "$WRAPPER_HASH" '.wrapperSha256 == $expected'
curl -fsS "$API/downloads/engine/$RELEASE/ubc26-engine-linux-x64" -o engine
echo "$ENGINE_HASH  engine" | sha256sum -c
chmod 500 engine
curl -fsS "$DOCS/open-claim-arc-testnet.json" -o manifest.json
echo '310176e7c03b2b0accf149e98033d054f7311a0ba3d08d084f96666190b7ba22  manifest.json' | sha256sum -c
```

Use Node.js 24 or later, Python 3, jq, curl, and npm. Use the prepared prover host
for recording. To prepare another Linux host, install [RISC Zero's rzup](https://dev.risczero.com/api/zkvm/install)
and Docker. Run `rzup install r0vm 3.1.0`. Ensure `r0vm --version` reports
3.1.0. The wrapper digest includes host files. If the digest differs on another
host, obtain an independently reviewed digest for that host before proceeding.
Pull the pinned image with
`docker pull --platform linux/amd64 risczero/risc0-groth16-prover@sha256:49093ed164b82aca9305dd80e4a6eb996bd443201ac7bd50b52909b2761ef583`.
Use one prover at a time. Allow about 20 minutes for Meridian proving and
confirmations. Keep margin for slower hardware.

Write the engine configuration. Use a clean PATH with Docker. On the prepared
VPS, `r0vm` lives at `/opt/ubc26-prover/bin/r0vm`.

```sh
if test -x /opt/ubc26-prover/bin/r0vm; then
  export R0VM=/opt/ubc26-prover/bin/r0vm
else
  export R0VM="$(command -v r0vm)"
fi
test -x "$R0VM"
jq -n --arg engine "$WORK/engine" --arg hash "$ENGINE_HASH" \
  --arg wrapper "$WRAPPER_HASH" --arg r0vm "$R0VM" \
  '{mode:"native",executable:$engine,executableSha256:$hash,wrapperSha256:$wrapper,
    environment:{PATH:"/usr/local/bin:/usr/bin:/bin",RISC0_SERVER_PATH:$r0vm}}' > engine.json
```

## Terminal 1 | Buyer

1. Download the [task](meridian/request.md), [revision](meridian/revision.json),
   [reference](meridian/reference/dataset.json), [review examples](meridian/review.json),
   [output schema](meridian/outputs.json), and [oracle](meridian/oracle.py). Save the reference as
   `reference/dataset.json`. Keep the review examples out of the solver's
   workspace. Read the task. It specifies 13 checks and accepts any feasible
   assignment. Export `BUYER`, `KEYSTORE`, and `PASSWORD_FILE` from the local
   wallet setup. Choose one `RUN` identifier and keep it on retry.

```sh
mkdir -m 700 reference
for file in request.md revision.json outputs.json reference/dataset.json review.json oracle.py; do
  curl -fsS "$SITE/site/meridian/$file" -o "$file"
done
"$UBC" auth --api "$API" --wallet "$BUYER" --keystore "$KEYSTORE" \
  --password-fd 3 --key-out "$WORK/api-key" --idempotency "$RUN-auth" 3<"$PASSWORD_FILE"
"$UBC" import --api "$API" --key-file "$WORK/api-key" --input revision.json \
  --reference "$WORK/reference" --idempotency "$RUN-import" > imported.json
export JOB="$(jq -er '.jobId' imported.json)"
export REV="$(jq -er '.revision.revisionHash' imported.json)"
```

2. If Bot dispatch is authorized, send one review. The API checks the examples
   first. Proceed only when the saved receipt says `completed` and `pass`.
   If it remains pending, poll the existing ID. Keep the same revision.
   Stop on a failed or uncertain result.

```sh
"$UBC" request-bot-review --api "$API" --key-file "$WORK/api-key" --job "$JOB" \
  --revision "$REV" --input review.json --idempotency "$RUN-review" > review-ticket.json
export REVIEW="$(jq -er '.reviewId' review-ticket.json)"
"$UBC" bot-review --api "$API" --key-file "$WORK/api-key" --job "$JOB" \
  --review "$REVIEW" --wait-ms 60000 > review-result.json
jq -e --arg rev "$REV" '.status == "completed" and .decision == "pass" and .revisionHash == $rev' review-result.json
```

3. Review the exact rules, reference digest, and Bot result. Approve and compile.
   Save the compile task ID. Check for success before downloading.

```sh
"$UBC" approve --api "$API" --key-file "$WORK/api-key" --job "$JOB" \
  --revision "$REV" --reference-digest "$(jq -er '.referenceDigest' revision.json)" \
  --bot-review "$REVIEW" --idempotency "$RUN-approve"
"$UBC" compile --api "$API" --key-file "$WORK/api-key" --job "$JOB" \
  --revision "$REV" --idempotency "$RUN-compile" > compile-task.json
"$UBC" task --api "$API" --key-file "$WORK/api-key" \
  --task "$(jq -er '.id' compile-task.json)" --wait-ms 1800000 > compile-result.json
jq -e '.state == "succeeded"' compile-result.json
"$UBC" download --api "$API" --job "$JOB" --out "$WORK/package"
```

4. Preview one bounty with 12 hours of expiry. Keep the exact `funding.json`
   and expiry on retry. Address
   `0x000000000000000000000000000000000000dEaD` is a placeholder for the
   buyer's local open-bounty configuration. Funding registers the open-claim
   adapter as provider. Any eligible solver can compete. Use the other
   test wallet's public address if it is available.

```sh
CHAIN_TIME=$(curl -fsS "$RPC" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' |
  python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"]["timestamp"],16))')
jq -n --arg rev "$REV" --arg buyer "$BUYER" --arg expiry "$((CHAIN_TIME + 43200))" \
  '{revisionHash:$rev,buyer:$buyer,budget:"10000",expiry:$expiry}' > funding.json
"$UBC" funding-preview --api "$API" --key-file "$WORK/api-key" --job "$JOB" \
  --input funding.json --idempotency "$RUN-terms" > terms.json
mkdir -m 700 deliverables
"$UBC" configure --api "$API" --job "$JOB" --revision "$REV" --input terms.json \
  --engine-config engine.json --manifest manifest.json --buyer "$BUYER" \
  --solver 0x000000000000000000000000000000000000dEaD --work-dir "$WORK" \
  --package-dir "$WORK/package" --reference "$WORK/reference" --deliverables "$WORK/deliverables" \
  --source-commit "$RELEASE" --release-manifest-sha256 "$RELEASE_HASH" --out operator.json
"$UBC" operator preview --config operator.json
```

5. Check the deployment, exact bounty, gas caps, and expiry. After the operator
   authorizes those terms, set `buyer.keystorePath` to the absolute
   `KEYSTORE` path and `signingAuthorized` to `true` in the private
   `operator.json`. Fund once. After the funding and registration receipts
   confirm, publish a brief and print the handoff link.

```sh
"$UBC" operator fund --config operator.json --key-file "$WORK/api-key" \
  --password-fd 3 3<"$PASSWORD_FILE"
jq -n --arg rev "$REV" \
  '{revisionHash:$rev,brief:"Meridian Kiln: use dataset.json and the approved checks to produce a feasible schedule.json for four façade-panel releases. Any feasible assignment passes."}' > brief.json
"$UBC" public-brief --api "$API" --key-file "$WORK/api-key" --job "$JOB" \
  --input brief.json --idempotency "$RUN-brief"
"$UBC" open-job --api "$API" --job "$JOB" > open-job.json
jq -e '.status == "Funded" and (.publicBrief != null)' open-job.json
printf '%s/site/meridian.md?job=%s\n' "$SITE" "$JOB"
```

6. Start Terminal 2 with that link. After confirmed payout, recover the files
   from Arc and run the oracle on the recovered SDK files.

```sh
"$UBC" buyer-recover --api "$API" --job "$JOB" --rpc-url "$RPC" \
  --manifest manifest.json --engine-config engine.json --out "$WORK/recovered" > recovery.json
python3 oracle.py "$(jq -er '.outputDirectory' recovery.json)/sdk"
```

## Terminal 2 | Solver

1. Set `JOB` to the API job ID in the handoff link. Export `SOLVER`,
   `KEYSTORE`, and `PASSWORD_FILE` from your own funded wallet setup.
   Check the confirmed job. Read its brief, rules, and references.
   Generate your own `deliverables/schedule.json`. Search the possible
   lot, kiln, bench and temper assignments. Use decimal strings for integer
   fields. Keep one charge and one finish per release. Use the public job
   materials as your inputs. The buyer's review examples are demonstration
   fixtures.

```sh
"$UBC" open-job --api "$API" --job "$JOB" > open-job.json
jq -e --arg job "$JOB" '.jobId == $job and .status == "Funded" and
  (.expired | not) and (.released | not) and (.winner | not) and (.publicBrief != null)' open-job.json
"$UBC" job --api "$API" --job "$JOB" > job.json
"$UBC" download --api "$API" --job "$JOB" --out "$WORK/package"
"$UBC" references --api "$API" --job "$JOB" --out "$WORK/reference"
jq -e '.revision.revision.plan' job.json > plan.json
mkdir -m 700 deliverables
```

2. Use the confirmed snapshot to configure the solver and run the local check
   after creating the schedule. Require verdict 1 before creating a proof.

```sh
export REV="$(jq -er '.revisionHash' open-job.json)"
export CHAIN_JOB="$(jq -er '.chainJobId' open-job.json)"
export BUYER="$(jq -er '.buyer' open-job.json)"
jq '{fundingTerms:{chainId,buyer,budget,expiry,imageId:.manifest.imageId,
  rulesHash:.manifest.rulesHash,referenceHash:.manifest.referenceHash,
  description:("UBC26 open claim " + .jobId)}}' open-job.json > terms.json
jq '{jobId:.chainJobId}' open-job.json > funding-result.json
"$UBC" configure --api "$API" --job "$JOB" --revision "$REV" --input terms.json \
  --engine-config engine.json --manifest manifest.json --buyer "$BUYER" --solver "$SOLVER" \
  --work-dir "$WORK" --package-dir "$WORK/package" --reference "$WORK/reference" \
  --deliverables "$WORK/deliverables" --source-commit "$RELEASE" \
  --release-manifest-sha256 "$RELEASE_HASH" --out operator.json
"$UBC" operator preview --config operator.json
"$UBC" job-input --rpc-url "$RPC" --manifest manifest.json --job-id "$CHAIN_JOB" \
  --solver "$SOLVER" --out job-context.json
"$UBC" check --engine-config engine.json --plan plan.json --deliverables "$WORK/deliverables" \
  --reference "$WORK/reference" --job-context job-context.json | tee local-check.json
jq -e '.verdict == 1' local-check.json
"$UBC" operator prepare --config operator.json | tee proof-result.json
jq -e '.phase == "proved"' proof-result.json
```

3. Review the claim and release limits. After the operator authorizes them,
   set `solver.keystorePath` to the absolute `KEYSTORE` path and
   `signingAuthorized` to `true` in the same `operator.json`. Run the
   settlement and confirm the payout on Arc. Stop if another solver wins.

```sh
"$UBC" operator run --config operator.json --password-fd 3 3<"$PASSWORD_FILE" | tee settlement.json
jq -e '.phase == "released" and .paymentConfirmed' settlement.json
"$UBC" open-job --api "$API" --job "$JOB"
```

Show the funding, proof acceptance, payout, and recovered file for the same
job. Release makes the schedule public. On an uncertain send, keep the work
directory and reconcile the saved hash before proceeding. Resume the same
journal. An expired or unavailable job requires the operator's decision.

**Recorded fallback:** Arc job 7 used a prepared Meridian revision. It paid
0.01 testnet USDC and the buyer recovered the exact schedule.
[Proof acceptance](https://explorer.testnet.arc.io/tx/0x7105aab3ac583556ff9227864cf7e9f7db901ee048fe6e92c6483b7f8d8bcf91491) ·
[Payout and key release](https://explorer.testnet.arc.io/tx/0x78b6870536b171a989a5ebdeb278a20a2ec730bcec91173852bb29a13c3013e2)
