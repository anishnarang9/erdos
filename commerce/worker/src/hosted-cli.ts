#!/usr/bin/env node
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HostedApiError, hostedClient, type HostedReference } from "@ubc26/sdk";
import { apiClient } from "./client.ts";
import { checkReferences, downloadPackage } from "./run.ts";
import { evaluate, WorkerEngineError } from "./engine.ts";
import { loadOperatorKeystore } from "./operator-keystore.ts";
import { createSprintEngineRunner, sprintEngineWrapperDigest } from "./sprint-runner.ts";
import { object, privateDirectory, readOperatorJson, readSafeFile, requireSprint } from "./sprint-authorization.ts";
import { assertInstalledRelease, workerRepositoryRoot } from "./release-integrity.ts";
import { attemptStatus, prepareHostedAttempt } from "./open-claim/attempt-status.ts";
import { openClaimOperator } from "./open-claim/operator.ts";
import { prepareOpenClaimJobInput } from "./open-claim/job-input-cli.ts";
import { recoverBuyerOpenClaim } from "./open-claim/buyer-recovery.ts";

const common = ["api", "key-file"];
const commandFlags: Record<string, readonly string[]> = {
  help: [],
  auth: ["api", "wallet", "keystore", "password-fd", "key-out", "idempotency"],
  key: common,
  revoke: [...common, "key-id", "idempotency"],
  draft: [...common, "input", "idempotency"],
  import: [...common, "input", "reference", "idempotency"],
  "accept-draft": [...common, "task", "input", "idempotency"],
  job: ["api", "job"],
  discover: ["api", "cursor", "limit"],
  "open-job": ["api", "job"],
  "public-brief": [...common, "job", "input", "idempotency"],
  approve: [...common, "job", "revision", "reference-digest", "coverage-digest", "example-check", "bot-review", "idempotency"],
  "request-bot-review": [...common, "job", "revision", "input", "idempotency"],
  "bot-review": [...common, "job", "review", "wait-ms"],
  compile: [...common, "job", "revision", "idempotency"],
  task: [...common, "task", "wait-ms"],
  download: ["api", "job", "out"],
  references: ["api", "job", "out"],
  "funding-preview": [...common, "job", "input", "idempotency"],
  "funding-link": [...common, "job", "input", "idempotency"],
  check: ["engine-config", "plan", "deliverables", "reference", "evidence", "job-context"],
  attempt: ["state", "after-cursor"],
  "publish-attempt": [...common, "job", "state", "after-cursor", "idempotency"],
  attempts: ["api", "job", "cursor", "limit"],
  "hosted-attempt": ["api", "job", "attempt", "after-cursor"],
  "job-input": ["rpc-url", "manifest", "job-id", "solver", "out"],
  "buyer-recover": ["api", "job", "rpc-url", "manifest", "engine-config", "out"],
  "wrapper-digest": [],
  "verify-install": ["source-commit", "release-manifest-sha256"],
  configure: ["api", "job", "input", "engine-config", "manifest", "buyer", "solver", "work-dir", "package-dir", "reference", "deliverables", "evidence", "source-commit", "release-manifest-sha256", "revision", "out"],
  "check-examples": [...common, "draft", "revision", "input", "idempotency"],
  operator: ["config", "password-fd", "key-file"],
};
const operatorCommands = ["preview", "fund", "prepare", "run", "recover", "refund", "circle"];
export function parseHostedArgs(args: string[]) {
  const command = args[0] ?? "help";
  requireSprint(Object.hasOwn(commandFlags, command));
  const flags: Record<string, string> = {};
  let offset = 1;
  if (command === "operator") { requireSprint(operatorCommands.includes(args[1] ?? "")); flags.action = args[1]!; offset++; }
  requireSprint((args.length - offset) % 2 === 0 || args.length === 0);
  for (let i = offset; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    requireSprint(flag.startsWith("--") && commandFlags[command]!.includes(flag.slice(2)) &&
      value && !value.startsWith("--") && !/[\x00-\x1f]/.test(value) && !Object.hasOwn(flags, flag.slice(2)));
    flags[flag.slice(2)] = value;
  }
  if (flags["password-fd"] !== undefined) requireSprint(/^[3-9][0-9]*$/.test(flags["password-fd"]) && Number.isSafeInteger(Number(flags["password-fd"])));
  return { command, flags };
}
function writePrivate(path: string, value: string | Uint8Array) {
  const target = resolve(path); privateDirectory(dirname(target));
  const fd = openSync(target, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
function readKey(path: string) {
  const key = readSafeFile(resolve(path), true, 1024).toString("utf8").trim();
  requireSprint(key.length > 0 && !/[\s\x00-\x1f]/.test(key)); return key;
}
export async function hostedCli(args: string[]): Promise<unknown> {
  const { command, flags: f } = parseHostedArgs(args);
  const need = (key: string) => { requireSprint(f[key]); return f[key]!; };
  if (command === "help") return { version: 1, commands: Object.keys(commandFlags),
    privacy: "Results become public when the release key is broadcast.",
    signing: "Passwords use inherited file descriptors. API credentials use private files. Mutations require an idempotency key.",
    workflow: "auth, draft or import, task, job, request-bot-review, bot-review, approve, compile, task, download, funding-preview, operator, funding-link, discover" };
  if (command === "job-input") return prepareOpenClaimJobInput(["--rpc-url", need("rpc-url"), "--manifest", need("manifest"),
    "--job-id", need("job-id"), "--solver", need("solver"), "--out", need("out")]);
  if (command === "buyer-recover") return recoverBuyerOpenClaim({ apiUrl: need("api"), apiJobId: need("job"),
    rpcUrl: need("rpc-url"), manifestPath: resolve(need("manifest")),
    engineConfigPath: resolve(need("engine-config")), directory: resolve(need("out")) });
  if (command === "attempt") {
    const cursor = Number(f["after-cursor"] ?? 0);
    return attemptStatus(readOperatorJson(resolve(need("state"))), cursor);
  }
  if (command === "verify-install") {
    assertInstalledRelease(workerRepositoryRoot(), need("source-commit"), need("release-manifest-sha256"));
    return { status: "installation-verified", sourceCommit: need("source-commit") };
  }
  if (command === "wrapper-digest") return { wrapperSha256: sprintEngineWrapperDigest(), authority: "candidate for independent review" };
  if (command === "configure") {
    const work = resolve(need("work-dir")); privateDirectory(work);
    for (const name of ["journal", "prover"]) {
      const fs = await import("node:fs"); fs.mkdirSync(join(work, name), { mode: 0o700 });
    }
    const termsView = object(readOperatorJson(resolve(need("input")))), terms = object(termsView.fundingTerms);
    const sourceCommit = need("source-commit"); requireSprint(/^[0-9a-f]{40}$/.test(sourceCommit));
    requireSprint(terms.chainId === 5042002 && typeof terms.buyer === "string" && terms.buyer.toLowerCase() === need("buyer").toLowerCase());
    const revision = need("job");
    const config = { version: 1, mode: "open-claim", chainId: 5042002, sourceCommit,
      ...(f["release-manifest-sha256"] ? { releaseManifestSha256: f["release-manifest-sha256"] } : {}),
      signingAuthorized: false, apiUrl: need("api"), apiJobId: revision, rpcUrl: "https://rpc.testnet.arc.io",
      buyer: { address: need("buyer"), keystorePath: join(work, "buyer-keystore.json") },
      solver: { address: need("solver"), keystorePath: join(work, "solver-keystore.json") },
      directory: work, journalRoot: join(work, "journal"), proverLockRoot: join(work, "prover"), attemptDir: join(work, "attempt"),
      manifest: resolve(need("manifest")), packageDir: resolve(need("package-dir")), referenceDir: resolve(need("reference")),
      deliverablesDir: resolve(need("deliverables")), ...(f.evidence ? { evidenceDir: resolve(f.evidence) } : {}), engine: readOperatorJson(resolve(need("engine-config"))),
      approval: { revision: need("revision"), imageId: terms.imageId, rulesHash: terms.rulesHash,
        referenceHash: terms.referenceHash, budget: terms.budget, expiry: terms.expiry, description: terms.description },
      gas: { maxFeePerGas: "25000000000", maxPriorityFeePerGas: "0", buyerPerCall: "300000", buyerTotal: "37500000000000000",
        claim: "650000", release: "260000", solverTotal: "22750000000000000", refund: "300000" } };
    requireSprint(typeof config.approval.revision === "string");
    writePrivate(need("out"), JSON.stringify(config, null, 2) + "\n");
    return { status: "configured", signingAuthorized: false, reviewRequired: ["approval", "gas", "engine", "keystore paths", "deployment manifest", "release manifest pin"] };
  }
  if (command === "operator") {
    const operatorArgs = [need("action"), "--config", need("config")];
    if (f["password-fd"]) operatorArgs.push("--password-fd", f["password-fd"]);
    return openClaimOperator(operatorArgs, { buyerToken: f["key-file"] ? readKey(f["key-file"]) : undefined });
  }
  if (command === "check") {
    const engine = object(readOperatorJson(resolve(need("engine-config"))));
    const runner = createSprintEngineRunner(engine);
    const verdict = await evaluate(runner, { planFile: resolve(need("plan")), deliverablesDir: resolve(need("deliverables")), referenceDir: resolve(need("reference")),
      ...(f.evidence ? { evidenceDir: resolve(f.evidence) } : {}),
      ...(f["job-context"] ? { jobFile: resolve(f["job-context"]) } : {}) });
    return { verdict, mode: "check-only", proofGenerated: false, transactionSent: false };
  }
  const api = need("api"), key = f["key-file"] ? readKey(f["key-file"]) : undefined;
  const client = hostedClient({ baseUrl: api, apiKey: key });
  if (command === "auth") {
    const destination = resolve(need("key-out")); privateDirectory(dirname(destination));
    const loaded = await loadOperatorKeystore({ mode: "signing", keystorePath: resolve(need("keystore")),
      expectedAddress: need("wallet") as `0x${string}`, passwordSource: { kind: "fd", fd: Number(need("password-fd")) } });
    requireSprint(loaded.mode === "signing");
    const result = await client.authenticate(need("wallet"), message => loaded.account.signMessage({ message }), need("idempotency"));
    writePrivate(destination, result.key + "\n");
    const { key: _rawKey, ...view } = result; return { ...view, saved: true };
  }
  const input = () => JSON.parse(readSafeFile(resolve(need("input")), false, 1_048_576).toString("utf8")) as unknown;
  switch (command) {
    case "key": need("key-file"); return client.currentKey();
    case "revoke": need("key-file"); return client.revokeKey(need("key-id"), need("idempotency"));
    case "draft": need("key-file"); return client.draft(input(), need("idempotency"));
    case "import": {
      need("key-file");
      const references = f.reference ? (await import("./run.ts")).readFilesFrom(resolve(f.reference)).map(file =>
        ({ name: file.name, contentBase64: Buffer.from(file.content).toString("base64") })) : undefined;
      return client.importJob(input(), need("idempotency"), references);
    }
    case "accept-draft": {
      need("key-file"); const task = await client.task(need("task"));
      requireSprint(task.operation === "draft" && task.state === "succeeded");
      const draft = object(task.result), original = object(input());
      requireSprint(draft.kind === "draft" && typeof draft.draftId === "string" && draft.draftId.length > 0);
      const references = original.references ?? []; requireSprint(Array.isArray(references));
      return client.createJob({ source: "grok", draftId: draft.draftId, revision: draft.revision,
        references: references as HostedReference[] }, need("idempotency"));
    }
    case "job": return client.job(need("job"));
    case "discover": return client.openJobs({ ...(f.cursor ? { cursor: f.cursor } : {}), ...(f.limit ? { limit: Number(f.limit) } : {}) });
    case "open-job": return client.openJob(need("job"));
    case "public-brief": {
      need("key-file");
      const body = object(input());
      requireSprint(Object.keys(body).length === 2 && typeof body.revisionHash === "string" && typeof body.brief === "string");
      return client.publishBrief(need("job"), { revisionHash: body.revisionHash, brief: body.brief }, need("idempotency"));
    }
    case "attempts": return client.attempts(need("job"), { ...(f.cursor ? { cursor: f.cursor } : {}), ...(f.limit ? { limit: Number(f.limit) } : {}) });
    case "hosted-attempt": return client.attempt(need("job"), need("attempt"), { ...(f["after-cursor"] ? { afterCursor: Number(f["after-cursor"]) } : {}) });
    case "publish-attempt": {
      need("key-file");
      const prepared = prepareHostedAttempt(readOperatorJson(resolve(need("state"))), Number(f["after-cursor"] ?? 0));
      const credential = await client.currentKey();
      requireSprint(credential.wallet.toLowerCase() === prepared.solver);
      const published = await client.publishAttempt(need("job"), prepared.input, need("idempotency"));
      return { ...published, submittedThroughCursor: prepared.submittedThroughCursor,
        resumeLocalCursor: prepared.resumeLocalCursor, localHighWaterCursor: prepared.localHighWaterCursor };
    }
    case "check-examples": {
      need("key-file"); const input = object(readOperatorJson(resolve(need("input"))));
      requireSprint(Object.keys(input).length === 1 && Array.isArray(input.examples));
      return client.checkExamples(need("draft"), { revisionHash: need("revision"), examples: input.examples }, need("idempotency"));
    }
    case "request-bot-review": {
      need("key-file"); const body = object(input());
      requireSprint(Object.keys(body).every(key => ["request", "examples"].includes(key)) && Array.isArray(body.examples)
        && (body.request === undefined || typeof body.request === "string"));
      return client.requestBotReview(need("job"), { revisionHash: need("revision"), examples: body.examples,
        ...(typeof body.request === "string" ? { request: body.request } : {}) }, need("idempotency"));
    }
    case "bot-review": {
      need("key-file");
      if (!f["wait-ms"]) return client.botReview(need("job"), need("review"));
      requireSprint(/^[1-9][0-9]*$/.test(f["wait-ms"]) && Number(f["wait-ms"]) <= 3_600_000);
      return client.waitForBotReview(need("job"), need("review"), { timeoutMs: Number(f["wait-ms"]) });
    }
    case "approve": need("key-file"); return client.approve(need("job"), { revisionHash: need("revision"), referenceDigest: need("reference-digest"), ...(f["coverage-digest"] ? { coverageDigest: f["coverage-digest"] } : {}), ...(f["example-check"] ? { exampleCheckId: f["example-check"] } : {}), ...(f["bot-review"] ? { botReviewId: f["bot-review"] } : {}) }, need("idempotency"));
    case "compile": need("key-file"); return client.compile(need("job"), need("revision"), need("idempotency"));
    case "task": {
      need("key-file");
      if (!f["wait-ms"]) return client.task(need("task"));
      requireSprint(/^[1-9][0-9]*$/.test(f["wait-ms"]) && Number(f["wait-ms"]) <= 3_600_000);
      return client.waitForTask(need("task"), { timeoutMs: Number(f["wait-ms"]) });
    }
    case "download": return { manifest: await downloadPackage(apiClient(api), need("job"), resolve(need("out"))), status: "downloaded-and-checked" };
    case "references": {
      const publicClient = apiClient(api), jobId = need("job"), job = await publicClient.job(jobId);
      requireSprint(job.manifest);
      const references = await publicClient.references(jobId); checkReferences(references.files, job.manifest.referenceHash);
      const fs = await import("node:fs"), target = resolve(need("out")); privateDirectory(dirname(target));
      fs.mkdirSync(target, { mode: 0o700 });
      for (const file of references.files) writePrivate(join(target, file.name), file.content);
      return { status: "references-downloaded-and-checked", files: references.files.map(file => file.name) };
    }
    case "funding-preview": need("key-file"); return client.fundingTerms(need("job"), input(), need("idempotency"));
    case "funding-link": need("key-file"); return client.linkFunding(need("job"), input(), need("idempotency"));
    default: throw new Error("Unknown hosted command");
  }
}
export async function hostedMain(args = process.argv.slice(2)): Promise<void> {
  try { console.log(JSON.stringify(await hostedCli(args), (_, value: unknown) => typeof value === "bigint" ? String(value) : value, 2)); }
  catch (err) {
    if (args[0] === "check") {
      const known = new Set(["invalid_deliverable", "bundle_input", "invalid_job", "input_io", "invalid_plan", "unsupported_capability", "output_too_large", "timeout", "spawn", "bad_output"]);
      const reason = err instanceof WorkerEngineError ? known.has(err.code) ? err.code : "engine_failed" : "configuration_invalid";
      console.log(JSON.stringify({ status: "check-rejected", reason, mode: "check-only", proofGenerated: false, transactionSent: false }));
    } else if (err instanceof HostedApiError) {
      console.error(JSON.stringify({ status: "api-rejected", httpStatus: err.status, code: err.code }));
    } else console.error("Hosted command failed. Inspect task state or reconcile signed sends before retrying. Secret details are redacted.");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void hostedMain();
