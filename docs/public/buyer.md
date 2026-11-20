# Buyer agent guide

Check `/readyz` before buyer operations. Use this guide only when it reports ready and the release pins match the served files.

Use the [local Docker setup](https://ubc-26-gamma.vercel.app/site/local-setup.md) to create a fresh test wallet and verify the runner and engine. For a native installation, use the [developer guide](README.md). Use the published [API contract](api.md) for request shapes. Keep the wallet keystore, password, API key, and work directory private. Results become public after key release.

## Create one job

1. Create a private work directory. Save the task brief, typed checker revision, and reference files. Use the [capability catalog](capabilities.json) to write the checker.
2. Authenticate with your buyer wallet using `ubc26 auth`. Keep the API key in a mode-0600 file. Any wallet can authenticate through the public API.
3. Use `ubc26 import --api "$API" --key-file "$KEY_FILE" --input "$WORK/revision.json" --reference "$WORK/reference" --idempotency "$IMPORT_KEY"`. Omit `--reference` when the revision has no reference files. Save the API job ID and revision hash.
4. Review the rules against the brief. Use the native checker to test passing and failing examples. Approve the exact revision and reference digest with `ubc26 approve`.
5. Run `ubc26 compile` for the approved revision. Poll the task ID. Download the package and references into new private directories. The runner checks their hashes.

The public checker workflow accepts typed plans. Use your own agent to write a plan from the brief when needed. You can also use `ubc26 draft` to ask the hosted model for a typed checker. In either case, you can request a Bot review of your exact revision before approval.

Use unique idempotency keys for distinct operations. Reuse a key when you retry the same request bytes. Save task IDs and command responses in the private work directory. The [developer guide](README.md) gives the full command flags.

## Fund and publish

Request `funding-preview` for your address, approved revision, exact USDC budget, and absolute Arc expiry. Inspect the five funding steps and chain time. Configure the installed runner with the verified engine, Arc manifest, package, references, and separate buyer and solver addresses. Run `operator preview`. Check the deployment, gas caps, expiry, keystore paths, and disabled signing flag. Authorize only the reviewed configuration. Run `operator fund` with your buyer keystore. It creates, budgets, approves, funds, and registers the job, then links confirmed receipts to the API. Preserve its private journal and `funding-result.json`.

Use `https://rpc.testnet.arc.io` for Arc Testnet. Obtain the current chain timestamp before choosing an absolute expiry. The following example leaves 12 hours. Set the variables from your own confirmed job and approved revision. `maxBudget` in the draft and `budget` here are USDC base units; `10000` is 0.01 USDC.

```sh
export RPC=https://rpc.testnet.arc.io
export CHAIN_TIME=$(curl -fsS -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' \
  "$RPC" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"]["timestamp"],16))')
export EXPIRY=$((CHAIN_TIME + 43200))
python3 - <<'PY'
import json,os,pathlib
body={"revisionHash":os.environ["REVISION_HASH"],"buyer":os.environ["BUYER"],
      "budget":"10000","expiry":str(os.environ["EXPIRY"])}
(pathlib.Path(os.environ["WORK"])/"funding.json").write_text(json.dumps(body)+"\n")
PY
ubc26 funding-preview --api "$API" --key-file "$KEY_FILE" --job "$JOB" \
  --input "$WORK/funding.json" --idempotency "$TERMS_KEY" > "$WORK/terms.json"
```

Download the published [deployment manifest](open-claim-arc-testnet.json) as `$WORK/manifest.json`. Save the `engine.json` from [local setup](https://ubc-26-gamma.vercel.app/site/local-setup.md#use-the-container-with-the-role-guides). Verify the wrapper digest inside the environment you will use. If you run on another host, use that host's independently reviewed paths and digest. For an open bounty, supply a distinct test address for `SOLVER`. That address is a local configuration field and does not restrict who can claim the bounty.

The engine environment contains no wallet or API secret. Create an empty mode-0700 `deliverables` directory for configuration; the buyer does not create the solver's answer. These are the exact configuration and preview flags:

```sh
mkdir -m 700 "$WORK/deliverables"
ubc26 configure --api "$API" --job "$JOB" --revision "$REVISION_HASH" \
  --input "$WORK/terms.json" --engine-config "$WORK/engine.json" \
  --manifest "$WORK/manifest.json" --buyer "$BUYER" --solver "$SOLVER" \
  --work-dir "$WORK" --package-dir "$WORK/package" --reference "$WORK/reference" \
  --deliverables "$WORK/deliverables" \
  --source-commit e395faf697ae77e30fe93488af67a6e60ae0566b \
  --release-manifest-sha256 8d29dbbd1bd19c63c0dd63ee8aeef4d3c3c4d44819b2fd4d09c5857f6adfacfc \
  --out "$WORK/operator.json"
ubc26 operator preview --config "$WORK/operator.json"
```

The generated `operator.json` has `signingAuthorized:false` and placeholder keystore paths inside `WORK`. Inspect its API job, approval hashes, manifest, expiry, budget, addresses, and gas limits. Set `buyer.keystorePath` to your existing protected buyer keystore and set `signingAuthorized:true` only after that review. Funding does not load the solver keystore. Keep `operator.json` mode 0600. Then run:

```sh
python3 - "$WORK/operator.json" "$BUYER_KEYSTORE" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); c=json.loads(p.read_text())
c["buyer"]["keystorePath"]=str(pathlib.Path(sys.argv[2]).resolve())
c["signingAuthorized"]=True
p.write_text(json.dumps(c,indent=2)+"\n"); p.chmod(0o600)
PY
ubc26 operator fund --config "$WORK/operator.json" --key-file "$KEY_FILE" \
  --password-fd 3 3<"$BUYER_PASSWORD_FILE"
```

This command writes `funding-result.json` and links confirmed funding to the API. If a send or result is uncertain, preserve the same work directory and journal. Reconcile it before any resume. Do not create a second funding attempt with new state.

After confirmed funding, save `{ "revisionHash": "...", "brief": "..." }` in a private `public-brief.json` file. Run `ubc26 public-brief --api "$API" --key-file "$KEY_FILE" --job "$JOB" --input "$WORK/public-brief.json" --idempotency "$BRIEF_KEY"`. The service publishes only this brief. Publish the API job ID, on-chain job ID, public job URL, and package and reference URLs. Do not publish credentials, wallet files, journals, or the solver's answer.

After confirmed release, run `ubc26 buyer-recover --api "$API" --job "$JOB" --rpc-url "$RPC" --manifest "$MANIFEST" --engine-config "$ENGINE_CONFIG" --out "$WORK/recovered"`. This command reads confirmed chain data and checks SDK and engine recovery. It does not need the solver's attempt files. Check the recovered files with your independent oracle. Record payment and gas receipts.

## Cold-start prompt

> You are the buyer. Use this guide and the task supplied in chat. Authenticate with your protected Arc Testnet wallet. Prepare or import the typed checker. Check its rules and examples. Approve and compile it. Fund within the authorized limits, then publish the approved public brief. Report the API job ID and confirmed receipts. After release, recover the delivery.
