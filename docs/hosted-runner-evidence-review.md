# Runner evidence review

This review reads commit `f314f59` on branch `codex/hosted-backend`. The subject is `Retain signed evidence through local open-claim attempts`. The commit id is `f314f59c8dcd65ac24e97471ad1530c3f67634e6`.

Hosted-backend HEAD during this review is `9e70e51`. The diff from `f314f59` to that HEAD is empty for the six pinned source files and for the evidence report. This review did not edit that tree.

The report is `agents/anish/reports/hosted-runner-evidence-2026-11-16.json`. Its status is `passed-native-cli-evidence-check`. It records 12 cases, 0 proofs, 0 chain transactions, and 0 model calls. Each pinned SHA-256 equals the current file bytes.

## Defect

The installed check command hides an invalid signature.

`commerce/worker/src/engine.ts` lines 118-121 pass `--evidence` and `--job` to `engine eval`. Line 121 throws when the exit status is not 0. Lines 57-59 keep the engine code and message on `WorkerEngineError`.

`commerce/worker/src/hosted-cli.ts` lines 118-125 return JSON only for verdict 0 or verdict 1. Lines 183-185 drop every exception. The process exit code becomes 1. Stderr is only this sentence:

```text
Hosted command failed. Inspect task state or reconcile signed sends before retrying. Secret details are redacted.
```

`docs/hosted-client.md` line 114 says a signature rejection is distinct from checker verdict 0. The installed command loses that distinction. Verdict 0 prints JSON and exits 0. A signature rejection prints only the redacted sentence. That sentence tells the operator to reconcile a signed send. The check command sends no transaction.

## Reproduction

This run used a stub executable. It did not call the real engine. It did not build a guest or create a proof. It did not open a network, a wallet, a model, or a chain.

Clear these names in the parent process before the call:

- `ENGINE_MODE`
- `ENGINE_PATH`
- `ENGINE_WSL_DISTRO`
- `ENGINE_R0VM`
- `ENGINE_CACHE`
- `ENGINE_WORK_DIR`
- `ENGINE_TMPDIR`
- `ENGINE_WSL_BIN`

Write the engine config with mode 0600. Its directory mode is 0700. `readOperatorJson` rejects an ancestor with mode bits `0o7022`. A file under `/tmp` fails that walk.

The config has `mode` `native`, an absolute `executable`, `executableSha256` of those file bytes, and `wrapperSha256` from `sprintEngineWrapperDigest()`. `environment.PATH` is `/usr/bin:/bin`. The stub mode is 0755.

The rejection stub treats its first argument as `eval`. It writes the next line to stderr and exits 2:

```text
{"code":"invalid_deliverable","message":"Evidence signature or binding failed"}
```

Call `hostedMain` with `check`, `--engine-config`, `--plan`, `--deliverables`, `--reference`, `--evidence`, and `--job-context`.

On 2026-11-16 the direct `evaluate` call threw `WorkerEngineError`. The code was `invalid_deliverable`. The message was `engine eval failed: Evidence signature or binding failed`. Its argument list contained `eval`, `--evidence`, and `--job`.

The same rejection through `hostedMain` had empty stdout. Stderr was the redacted sentence. The exit code was 1.

A second stub writes `{"verdict":0}` and exits 0. The same arguments then print this JSON and exit 0:

```json
{
  "verdict": 0,
  "mode": "check-only",
  "proofGenerated": false,
  "transactionSent": false
}
```

The 12 report rows come from native `engine eval`. They do not call `hostedMain`. The open-claim unit test drives a fake runner and does not exit 2. That test does not show this defect. A new funded witness proof is still absent.

## Other items

No other concrete issue.

Encoded evidence size starts at 3. Each file adds 6, the UTF-8 name length, and the content length. The limit is 16 files and 32768 bytes. `commerce/worker/src/open-claim/run.ts` lines 255-263 apply that limit before prove. The formula matches the engine bundle header.

`SAFE_NAME` rejects a name that is not one safe file name. The private copy uses mode 0600 and flag `wx`. Resume of phase `preparing` or `proving` throws `resume_incomplete`. A later phase loads the stored proof. The attempt binding omits evidence. A later evidence edit does not replace that proof.

`job-input` returns a summary object. It writes the context file with mode 0600. The signer sets `noKeyRpcSimulation`. Its send function throws before a broadcast. `configure` keeps `signingAuthorized` false. This patch adds no transaction.

`package-runner.mjs` bundles `hosted-cli.ts` as `bin/runtime.mjs`. That bundle contains the new command. Operator source paths include `commerce/worker/src`. The wrapper digest includes `commerce/worker/src/engine.ts`. An old wrapper pin fails after this edit. That pin failure means the wrapper bytes differ.
