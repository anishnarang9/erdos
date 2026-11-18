import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSprintSource, createSprintEngineRunner, createSprintReadRequest, executeSprint as executeRealSprint, runSprintOracle,
  sprintEngineWrapperDigest, validateSprintPrivateAttempt, type SprintDependencies,
} from "../../src/sprint-runner.ts";
import type { SprintArgs } from "../../src/sprint-cli.ts";
import { parseDeploymentPolicy } from "../../src/deployment-policy.ts";
import { parseSprintAuthorization, readOperatorJson, sprintDigest, stableJson } from "../../src/sprint-authorization.ts";
import { revisionHash, type Revision } from "../../../api/src/revision.ts";
import { SprintStateStore } from "../../src/sprint-state.ts";
import { fakeEngine } from "../support/fakes.ts";
import { bytesToHex, TransactionReceiptNotFoundError, zeroHash, type Hex, type PublicClient } from "viem";
import { encodeBundle, encodeContext, referenceHash } from "@ubc26/sdk";

const roots: string[] = [];
// Explicit local fixture boundary. Production and the CLI have no bypass for source checks.
const executeSprint = (args: SprintArgs, deps: SprintDependencies = {}) =>
  executeRealSprint(args, { sourceChecker: () => {}, ...deps });
function fixture() {
  const home = fs.realpathSync(homedir());
  const root = fs.realpathSync(fs.mkdtempSync(join(home, ".sprint-runner-test-")));
  roots.push(root);
  const file = (name: string, v: unknown) => {
    const p = join(root, name);
    fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
    return p;
  };
  for (const name of ["refs", "candidates", "expected", "journal"]) fs.mkdirSync(join(root, name), { mode: 0o700 });
  file("request.txt", "A new unseen request");
  file("refs/input.json", "{}");
  file("candidates/out.json", '{"privateCandidate":true}');
  file("expected/out.json", '{"knownAnswer":true}');
  const manifest = JSON.parse(fs.readFileSync(resolve("../sdk/src/chain/arc/arc-testnet.json"), "utf8"));
  const candidate = parseDeploymentPolicy(manifest);
  file("manifest.json", manifest);
  file("pins.json", {
    version: 1, ...candidate.chainConfig,
    policy: { ...candidate.policy, deploymentBlock: String(candidate.policy.deploymentBlock) },
  });
  const input = file("input.json", {
    version: 1, requestFile: "request.txt", referenceDir: "refs", candidateDir: "candidates",
    oracle: { kind: "exact-files", expectedDir: "expected" }, outputs: [{ name: "out.json", format: "json" }],
    expirySeconds: 3600, budgetUnits: "1000000", buyer: "0x" + "11".repeat(20), provider: "0x" + "22".repeat(20),
  });
  const config = file("config.json", {
    version: 1, api: "http://localhost:8787", rpc: "https://rpc.invalid",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    deploymentManifest: "manifest.json", approvedDeploymentFile: "pins.json", journalRoot: "journal",
    proveBudgetSec: 1000, submitBudgetSec: 60, releaseMarginSec: 120, oracleTimeoutMs: 1000,
    engine: {
      mode: "native", executable: file("engine-fixture", "not a real engine"),
      executableSha256: sprintDigest("not a real engine"), wrapperSha256: sprintEngineWrapperDigest(),
      environment: { PATH: "/usr/bin:/bin" },
    },
  });
  fs.chmodSync(join(root, "engine-fixture"), 0o700);
  // The real approval reader asserts all ancestors. Do not weaken it for Linux /tmp.
  readOperatorJson(config);
  return { root, input, config, file, runDir: join(root, "run") };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("operator runner safety", () => {
  it("keeps happy fixtures safe even when TMPDIR points to a broadly writable directory", async () => {
    const f = fixture(), unsafe = join(f.root, "unsafe-tmp");
    fs.mkdirSync(unsafe); fs.chmodSync(unsafe, 0o1777);
    const previous = process.env.TMPDIR; process.env.TMPDIR = unsafe;
    try {
      const happy = fixture();
      expect(happy.root.startsWith(fs.realpathSync(homedir()) + "/")).toBe(true);
      expect(happy.root.startsWith(unsafe + "/")).toBe(false);
      expect(await executeSprint({ action: "inspect", ...happy })).toMatchObject({ phase: "initialized" });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });
  it("runs the approved native executable with fixed arguments and a clean, approved environment", async () => {
    const f = fixture();
    const executable = f.file("engine-native.py", '#!/usr/bin/python3\nimport os,sys,json\nprint(json.dumps({"arg":sys.argv[1],"path":os.environ.get("PATH"),"token":os.environ.get("BUYER_TOKEN"),"home":os.environ.get("HOME")}))\n');
    fs.chmodSync(executable, 0o700);
    process.env.BUYER_TOKEN = "fixture-do-not-inherit";
    try {
      const runner = createSprintEngineRunner({
        mode: "native", executable, executableSha256: sprintDigest(fs.readFileSync(executable)),
        wrapperSha256: sprintEngineWrapperDigest(), environment: { PATH: "/usr/bin:/bin" },
      });
      const output = await runner.run(["fixed-argument"], 5000);
      expect(output.exit).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({ arg: "fixed-argument", path: "/usr/bin:/bin", token: null, home: null });
      fs.writeFileSync(executable, "#!/usr/bin/python3\nprint('changed after construction')\n");
      await expect(runner.run(["fixed-argument"], 5000)).rejects.toThrow();
    } finally { delete process.env.BUYER_TOKEN; }
  });
  it("fails closed for WSL sprint configuration rather than pretending to pin a Linux executable", async () => {
    const f = fixture(), config = JSON.parse(fs.readFileSync(f.config, "utf8"));
    config.engine.mode = "wsl"; fs.writeFileSync(f.config, JSON.stringify(config));
    await expect(executeSprint({ action: "inspect", ...f })).rejects.toThrow();
  });
  it("rejects dirty tracked and untracked relevant source in a real temporary Git repository", () => {
    const f = fixture(), repo = join(f.root, "repo");
    fs.mkdirSync(repo, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    fs.mkdirSync(join(repo, "commerce/worker/src"), { recursive: true });
    fs.writeFileSync(join(repo, "commerce/worker/src/runner.ts"), "approved");
    git("add", "."); git("commit", "-qm", "fixture");
    const head = git("rev-parse", "HEAD");
    expect(() => assertSprintSource(repo, head)).not.toThrow();
    fs.writeFileSync(join(repo, "commerce/worker/src/runner.ts"), "changed");
    expect(() => assertSprintSource(repo, head)).toThrow();
    git("add", ".");
    expect(() => assertSprintSource(repo, head)).toThrow();
    fs.writeFileSync(join(repo, "commerce/worker/src/runner.ts"), "approved");
    git("add", ".");
    fs.writeFileSync(join(repo, ".git/info/exclude"), "hidden.ts\n");
    fs.writeFileSync(join(repo, "commerce/worker/src/hidden.ts"), "untracked");
    expect(() => assertSprintSource(repo, head)).toThrow();
  });
  it.each([0o777, 0o1777])("rejects operator files under writable ancestor mode %s even when the immediate directory is private", mode => {
    const f = fixture();
    fs.mkdirSync(join(f.root, "approval-private"), { mode: 0o700 });
    const path = f.file("approval-private/approval.json", {});
    fs.chmodSync(f.root, mode);
    try { expect(() => readOperatorJson(path)).toThrow(); }
    finally { fs.chmodSync(f.root, 0o700); }
  });
  it("inspects without any wallet, RPC, token, or engine", async () => {
    const f = fixture(), loadKeystore = vi.fn(), fetch = vi.fn(), readToken = vi.fn();
    const result = await executeSprint({ action: "inspect", ...f }, { loadKeystore, fetch, readToken });
    expect(result).toMatchObject({ mode: "read-only", phase: "initialized", fundingAuthorized: false });
    expect(loadKeystore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readToken).not.toHaveBeenCalled();
  });
  it("rejects unsafe input before reading any credential", async () => {
    const f = fixture(), loadKeystore = vi.fn(), readToken = vi.fn();
    fs.unlinkSync(join(f.root, "request.txt"));
    fs.symlinkSync(join(f.root, "config.json"), join(f.root, "request.txt"));
    await expect(executeSprint({ action: "fund", ...f }, { loadKeystore, readToken })).rejects.toThrow();
    expect(loadKeystore).not.toHaveBeenCalled();
    expect(readToken).not.toHaveBeenCalled();
  });
  it("does not present missing evidence as successful verification", async () => {
    const f = fixture();
    await expect(executeSprint({ action: "verify", ...f })).rejects.toThrow();
  });
});

function fakeApi() {
  const requests: { path: string; body: Record<string, unknown>; rawBody: string; key: string | null }[] = [];
  let revision: Revision, hash: string, approved = false, compiled = false;
  const H = "0x" + "aa".repeat(32);
  let references: { name: string; contentBase64: string }[] = [], chainJobId: string | null = null;
  const guest = Buffer.from("fixture-guest"), rules = Buffer.from("fixture-rules");
  const manifest = () => ({ imageId: H, rulesHash: H, referenceHash: revision!.referenceDigest, structureHash: H, guestSha256: "0x" + sprintDigest(guest) });
  const packageFiles = () => new Map([["manifest.json", Buffer.from(JSON.stringify(manifest()))], ["guest.elf", guest], ["params/rules.bin", rules]]);
  const deployment = parseDeploymentPolicy(JSON.parse(fs.readFileSync(resolve("../sdk/src/chain/arc/arc-testnet.json"), "utf8")));
  const fetch = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(raw)).pathname, body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, body, rawBody: String(init?.body ?? ""), key: new Headers(init?.headers).get("idempotency-key") });
    let response: unknown;
    if (path === "/v1/drafts") {
      revision = { plan: { version: 1 }, outputs: body.outputs as Revision["outputs"], referenceDigest: "0x" + "bb".repeat(32), expirySeconds: 3600, maxBudget: "1000000" };
      // Tests of this boundary use the actual uploaded bundle digest, supplied below by the import flow.
      response = { kind: "unsupported", draftId: "draft1", reason: "fixture" };
    } else if (path === "/v1/jobs") {
      revision = body.revision as Revision;
      references = body.references as typeof references;
      hash = revisionHash(revision);
      response = { jobId: "job1", state: "drafted", revision: { n: 1, revisionHash: hash } };
    } else if (path.endsWith("/approve")) { approved = true; response = { state: "approved" }; }
    else if (path.endsWith("/compile")) { compiled = true; response = { state: "compiled", manifest: manifest() }; }
    else if (path.endsWith("/select-quote")) {
      const manifest = JSON.parse(fs.readFileSync(resolve("../sdk/src/chain/arc/arc-testnet.json"), "utf8"));
      const d = parseDeploymentPolicy(manifest);
      response = { state: "selected", fundingTerms: { ...d.chainConfig, provider: "0x" + "22".repeat(20), budget: "1000000", expiredAt: "2147483000",
        imageId: H, rulesHash: H, referenceHash: revision!.referenceDigest, description: "ubc26:job1" } };
    } else if (path.endsWith("/package")) response = { jobId: "job1", manifest: manifest(), files: [...packageFiles()].map(([path, content]) => ({ path, size: content.length, sha256: "0x" + sprintDigest(content) })) };
    else if (path.endsWith("/package/file")) {
      const content = packageFiles().get(new URL(String(raw)).searchParams.get("path")!);
      return new Response(content);
    } else if (path.endsWith("/references")) response = { referenceDigest: revision!.referenceDigest, files: references };
    else response = {
      jobId: "job1", state: compiled ? "compiled" : approved ? "approved" : "drafted",
      chain: chainJobId ? { chainId: 5042002, core: deployment.chainConfig.core, jobId: chainJobId } : null,
      revision: { n: 1, revisionHash: hash!, revision: revision!, engine: { rulesHash: H, structureHash: H } },
      approval: approved ? { revisionHash: hash!, rulesHash: H, structureHash: H, referenceDigest: revision!.referenceDigest } : null,
      manifest: compiled ? manifest() : null,
    };
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests, setChainJobId: (id: string) => { chainJobId = id; }, manifest, deployment };
}
describe("real API protocol composition with a fixture HTTP boundary", () => {
  it("separates typed import review from approval/compile and never loads a wallet or funds implicitly", async () => {
    const f = fixture(), api = fakeApi(), loadKeystore = vi.fn(), readToken = vi.fn(async () => "fixture-token");
    const plan = f.file("plan.json", { version: 1 });
    const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
    const first = await executeSprint(args, { ...api, loadKeystore, readToken }) as Record<string, unknown>;
    expect(first).toMatchObject({ provenance: "typed-import", needsApproval: true, fundingAuthorized: false, phase: "authored" });
    expect(api.requests.map(r => r.path)).not.toContain("/v1/jobs/job1/approve");
    const approval = f.file("approval.json", first.approvalRequired);
    const next = await executeSprint({ ...args, approval }, { ...api, loadKeystore, readToken });
    expect(next).toMatchObject({ phase: "compiled", fundingAuthorized: false });
    expect(loadKeystore).not.toHaveBeenCalled();
    expect(api.requests.some(r => /fund|select-quote/.test(r.path))).toBe(false);
    expect(JSON.stringify(api.requests)).not.toContain("privateCandidate");
    expect(JSON.stringify(api.requests)).not.toContain("knownAnswer");
  });
  it("does not claim live provenance for API drafts that might be idempotent replays", async () => {
    const f = fixture(), api = fakeApi();
    const result = await executeSprint({ action: "prepare", ...f, buyerTokenFd: 3 }, { ...api, readToken: async () => "fixture-token" });
    expect(result).toMatchObject({ authoring: "api-draft-provenance-unverified", result: "unsupported" });
    expect(api.requests.map(r => r.path)).toEqual(["/v1/drafts"]);
  });
  it("labels a successful replay with original model/trace as provenance-unverified", async () => {
    const f = fixture(), api = fakeApi();
    const fetch: typeof globalThis.fetch = async (raw, init) => {
      if (String(raw).endsWith("/v1/drafts")) {
        const body = JSON.parse(String(init?.body));
        const revision = { plan: { version: 1 }, referenceDigest: referenceHash(encodeBundle(
          body.references.map((r: { name: string; contentBase64: string }) => ({ name: r.name, content: new Uint8Array(Buffer.from(r.contentBase64, "base64")) })),
        )), outputs: body.outputs, expirySeconds: body.expirySeconds, maxBudget: body.maxBudget };
        return new Response(JSON.stringify({ kind: "draft", draftId: "oldDraft", revision, revisionHash: revisionHash(revision),
          model: "original-model", traceId: "original-trace" }), { headers: { "idempotent-replayed": "true" } });
      }
      return api.fetch(raw, init);
    };
    const result = await executeSprint({ action: "prepare", ...f, buyerTokenFd: 3 }, { fetch, readToken: async () => "fixture-token" });
    expect(result).toMatchObject({ provenance: "api-draft-provenance-unverified", needsApproval: true });
    expect(JSON.stringify(result)).not.toContain("live-api-draft");
  });
  it("rejects a mismatched external revision approval before approving or compiling", async () => {
    const f = fixture(), api = fakeApi(), plan = f.file("plan.json", { version: 1 });
    const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
    const first = await executeSprint(args, { ...api, readToken: async () => "fixture-token" }) as Record<string, unknown>;
    const approval = f.file("approval.json", { ...first.approvalRequired as object, revisionHash: "0x" + "ff".repeat(32) });
    await expect(executeSprint({ ...args, approval }, { ...api, readToken: async () => "fixture-token" })).rejects.toThrow();
    expect(api.requests.some(r => /approve|compile/.test(r.path))).toBe(false);
  });
  it("accepts an externally written approval at the run approval path without replacing its bytes", async () => {
    const f = fixture(), api = fakeApi(), plan = f.file("plan.json", { version: 1 });
    const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
    const deps = { ...api, readToken: async () => "fixture-token" };
    const first = await executeSprint(args, deps) as Record<string, unknown>;
    const approval = join(f.runDir, "approval.json");
    const content = JSON.stringify(first.approvalRequired, null, 2);
    fs.writeFileSync(approval, content, { mode: 0o600 });
    expect(await executeSprint({ ...args, approval }, deps)).toMatchObject({ phase: "compiled" });
    expect(fs.readFileSync(approval, "utf8")).toBe(content);
  });
  it("reuses the exact idempotent creation body and key after an uncertain API response", async () => {
    const f = fixture(), api = fakeApi(), plan = f.file("plan.json", { version: 1 });
    let lost = false;
    const fetch: typeof globalThis.fetch = async (r, init) => {
      const response = await api.fetch(r, init);
      if (String(r).endsWith("/v1/jobs") && !lost) { lost = true; throw new Error("Lost fixture response"); }
      return response;
    };
    const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
    await expect(executeSprint(args, { fetch, readToken: async () => "fixture-token" })).rejects.toThrow();
    await executeSprint(args, { fetch, readToken: async () => "fixture-token" });
    const creates = api.requests.filter(r => r.path === "/v1/jobs");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(creates[1]);
  });
  it("persists exact selected expiry and refuses funding without external authority", async () => {
    const f = fixture(), api = fakeApi(), plan = f.file("plan.json", { version: 1 }), loadKeystore = vi.fn();
    const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
    const deps = { ...api, readToken: async () => "fixture-token", loadKeystore };
    const first = await executeSprint(args, deps) as Record<string, unknown>;
    const approval = f.file("approval.json", first.approvalRequired);
    const selected = await executeSprint({ ...args, approval, quote: "externalQuote1" }, deps);
    expect(selected).toMatchObject({ phase: "selected", selectedTerms: { expiry: "2147483000" }, fundingAuthorized: false });
    await expect(executeSprint({ action: "fund", ...f }, deps)).rejects.toThrow();
    expect(loadKeystore).not.toHaveBeenCalled();
    expect(api.requests.some(r => r.path.endsWith("/funding-receipt"))).toBe(false);
  });
  it("rejects mismatched spending authority before reading a token, wallet, or RPC", async () => {
    const f = fixture(), api = fakeApi(), plan = f.file("plan.json", { version: 1 });
    const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
    const first = await executeSprint(args, { ...api, readToken: async () => "fixture-token" }) as Record<string, unknown>;
    const approval = f.file("approval.json", first.approvalRequired);
    const selected = await executeSprint({ ...args, approval, quote: "externalQuote1" }, { ...api, readToken: async () => "fixture-token" }) as Record<string, unknown>;
    const authorization = f.file("spending.json", {
      version: 1, action: "fund", ...selected.fundingApprovalBindings as object,
      inputDigest: "f".repeat(64),
      allowedCalls: ["createJob", "setBudget", "approve", "fund"],
      maxGas: "3000000", maxFeePerGas: "20000000000", maxPriorityFeePerGas: "1000000000",
      nativeGasBudgetWei: "1000000000000000000", validUntil: "2100000000",
      dataSafeForPublication: true, keyDisclosureAcknowledged: true,
    });
    const readToken = vi.fn(), loadKeystore = vi.fn(), getChainId = vi.fn();
    expect(parseSprintAuthorization(JSON.parse(fs.readFileSync(authorization, "utf8"))).action).toBe("fund");
    await expect(executeSprint({ action: "fund", ...f, authorization }, {
      readToken, loadKeystore, publicClient: { getChainId } as unknown as PublicClient,
    })).rejects.toThrow();
    expect(readToken).not.toHaveBeenCalled(); expect(loadKeystore).not.toHaveBeenCalled(); expect(getChainId).not.toHaveBeenCalled();
  });
  it("requires approval files to be safe operator-owned files, not symlinks or writable public files", async () => {
    const f = fixture(), api = fakeApi(), plan = f.file("plan.json", { version: 1 });
    const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
    const deps = { ...api, readToken: async () => "fixture-token" };
    const first = await executeSprint(args, deps) as Record<string, unknown>;
    const approval = f.file("approval.json", first.approvalRequired);
    fs.chmodSync(approval, 0o666);
    await expect(executeSprint({ ...args, approval }, deps)).rejects.toThrow();
    fs.chmodSync(approval, 0o600);
    const link = join(f.root, "approval-link.json");
    fs.symlinkSync(approval, link);
    await expect(executeSprint({ ...args, approval: link }, deps)).rejects.toThrow();
    expect(api.requests.some(r => r.path.endsWith("/approve"))).toBe(false);
  });
});

async function fundedFixture() {
  const f = fixture(), api = fakeApi(), plan = f.file("plan.json", { version: 1 });
  const args = { action: "prepare" as const, ...f, plan, buyerTokenFd: 3 };
  const deps = { ...api, readToken: async () => "fixture-token" };
  const first = await executeSprint(args, deps) as Record<string, unknown>;
  const approval = f.file("approval.json", first.approvalRequired);
  await executeSprint({ ...args, approval, quote: "externalQuote1" }, deps);
  // Fixture-only seeding. This is deliberately NOT chain funding evidence.
  const store = new SprintStateStore(f.runDir);
  store.acquireLock();
  const state = store.read()!;
  store.write({ ...state, phase: "funding-intent", approvalHashes: { ...state.approvalHashes, funding: "d".repeat(64) } });
  const funded = { ...store.read()!, phase: "funded" as const, chainJobId: "7", transactionHashes: { createJob: "0x" + "cc".repeat(32) } };
  store.write(funded); store.releaseLock();
  api.setChainJobId("7");
  const d = api.deployment.chainConfig, m = api.manifest();
  const context = encodeContext({ chainId: 5042002n, escrow: d.core, jobId: 7n, provider: "0x" + "22".repeat(20) as Hex, rulesHash: m.rulesHash as Hex, referenceHash: m.referenceHash as Hex });
  const publicClient = {
    getChainId: vi.fn(async () => 5042002), getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async () => ({ number: 10n, timestamp: 1900000000n, hash: "0x" + "dd".repeat(32) })),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => { throw new TransactionReceiptNotFoundError({ hash }); }),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getJob": return { id: 7n, client: funded.selectedTerms!.buyer, provider: funded.selectedTerms!.provider, evaluator: d.hook, hook: d.hook, budget: 1_000_000n, expiredAt: 2147483000n, status: 1, description: "ubc26:job1" };
        case "terms": return [m.imageId, m.rulesHash, m.referenceHash, funded.selectedTerms!.provider, 1_000_000n, 2147483000n, true];
        case "contextOf": return bytesToHex(context);
        case "submissions": return [zeroHash, zeroHash, false];
        case "released": return false;
        default: throw new Error("Unexpected fixture read");
      }
    }),
  };
  return { ...f, api, publicClient, deps: { ...deps, publicClient: publicClient as unknown as PublicClient, runner: fakeEngine() } };
}
describe("read-only proving and pending resume with explicit fixtures", () => {
  it("creates a durable proof with the existing funded runner before any wallet access", async () => {
    const f = await fundedFixture(), loadKeystore = vi.fn(), rawSend = vi.fn();
    const report = await executeSprint({ action: "run", ...f }, { ...f.deps, loadKeystore, rawSend });
    expect(report).toMatchObject({ status: "needs-authorization", phase: "proved", proofVerdict: 1, paymentConfirmed: false });
    expect(loadKeystore).not.toHaveBeenCalled(); expect(rawSend).not.toHaveBeenCalled();
    expect(fs.statSync(join(f.runDir, "funded-attempt/attempt/proof.json")).mode & 0o777).toBe(0o600);
  });
  it("polls each durable pending hash once per invocation without unlocking, signing, or resending", async () => {
    const f = await fundedFixture(), loadKeystore = vi.fn(), rawSend = vi.fn();
    await executeSprint({ action: "run", ...f }, f.deps);
    const path = join(f.runDir, "funded-attempt/state.json");
    const attempt = JSON.parse(fs.readFileSync(path, "utf8"));
    attempt.phase = "submit_sent"; attempt.submitTx = "0x" + "ee".repeat(32);
    fs.writeFileSync(path, JSON.stringify(attempt), { mode: 0o600 });
    const priorCalls = f.deps.runner.calls.length;
    for (let i = 0; i < 2; i++) {
      expect(await executeSprint({ action: "run", ...f }, { ...f.deps, runner: undefined, loadKeystore, rawSend })).toMatchObject({ status: "pending", complete: false, paymentConfirmed: false });
    }
    expect(f.publicClient.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(f.deps.runner.calls.length).toBe(priorCalls);
    expect(loadKeystore).not.toHaveBeenCalled(); expect(rawSend).not.toHaveBeenCalled();
  });
  it("validates all private artifacts and the release-key commitment before creating a signer", async () => {
    const f = await fundedFixture();
    await executeSprint({ action: "run", ...f }, f.deps);
    const directory = join(f.runDir, "funded-attempt");
    const binding = {
      jobId: "job1", chainJobId: "7", core: f.api.deployment.chainConfig.core,
      hook: f.api.deployment.chainConfig.hook, provider: "0x" + "22".repeat(20),
    };
    expect(() => validateSprintPrivateAttempt(directory, binding)).not.toThrow();
    const keyFile = join(directory, "attempt/release-key.hex");
    const key = fs.readFileSync(keyFile);
    fs.writeFileSync(keyFile, "0x" + "00".repeat(32), { mode: 0o600 });
    expect(() => validateSprintPrivateAttempt(directory, binding)).toThrow();
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    fs.chmodSync(join(directory, "package/guest.elf"), 0o644);
    expect(() => validateSprintPrivateAttempt(directory, binding)).toThrow();
  });
  it("rejects changed executable bytes before reusing a prepared proof, without reading a wallet", async () => {
    const f = await fundedFixture(), loadKeystore = vi.fn();
    await executeSprint({ action: "run", ...f }, f.deps);
    fs.writeFileSync(join(f.root, "engine-fixture"), "changed engine");
    await expect(executeSprint({ action: "run", ...f }, { ...f.deps, loadKeystore })).rejects.toThrow();
    expect(loadKeystore).not.toHaveBeenCalled();
  });
  it("binds the configured engine environment and path into the run input digest", async () => {
    const f = await fundedFixture(), loadKeystore = vi.fn();
    const config = JSON.parse(fs.readFileSync(f.config, "utf8"));
    config.engine.environment.PATH = "/different";
    fs.writeFileSync(f.config, JSON.stringify(config));
    await expect(executeSprint({ action: "inspect", ...f }, { ...f.deps, loadKeystore })).rejects.toThrow();
    expect(loadKeystore).not.toHaveBeenCalled();
  });
});

describe("read transport", () => {
  it("serializes reads, retries only rate limits, and rejects all writes", async () => {
    let active = 0, maximum = 0, calls = 0;
    const request = createSprintReadRequest("https://rpc.invalid", {
      intervalMs: 0, wait: async () => {}, fetch: async () => {
        maximum = Math.max(maximum, ++active);
        await Promise.resolve();
        active--;
        calls++;
        return new Response(JSON.stringify(calls === 1 ? { error: { code: -32005 } } : { result: "0x1" }), { status: 200 });
      },
    });
    expect(await Promise.all([request({ method: "eth_chainId" }), request({ method: "eth_blockNumber" })])).toEqual(["0x1", "0x1"]);
    expect(maximum).toBe(1);
    expect(calls).toBe(3);
    await expect(request({ method: "eth_sendRawTransaction", params: ["secret"] })).rejects.toThrow();
    expect(calls).toBe(3);
  });
  it("bounds 429 retries and never retries ordinary failures", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 429 }));
    const request = createSprintReadRequest("https://rpc.invalid", { fetch, wait: async () => {}, intervalMs: 0 });
    await expect(request({ method: "eth_chainId" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(4);
    const bad = vi.fn(async () => new Response("", { status: 500 }));
    await expect(createSprintReadRequest("https://rpc.invalid", { fetch: bad, intervalMs: 0 })({ method: "eth_chainId" })).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe("reviewed oracle process", () => {
  const referenceContext = (directory: string) => ({
    referenceDir: directory,
    expectedDigest: sprintDigest(stableJson(fs.readdirSync(directory).sort().map(name => ({
      name, digest: sprintDigest(fs.readFileSync(join(directory, name))),
    })))),
  });
  it("actual core-sprint workload: reviewed oracle accepts valid and alternative deliveries with approved reference context", async () => {
    const f = fixture(), workload = resolve("../../docs/core-sprint-input");
    const scriptFile = join(workload, "oracle.py"), context = referenceContext(join(workload, "reference"));
    for (const candidate of ["valid", "alternative"]) {
      expect(await runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) },
        join(workload, "candidates", candidate), f.root, 2000, context)).toMatchObject({ semanticOraclePassed: true });
    }
    const changed = join(f.root, "changed-delivery"); fs.mkdirSync(changed, { mode: 0o700 });
    for (const name of fs.readdirSync(join(workload, "candidates/valid"))) fs.copyFileSync(join(workload, "candidates/valid", name), join(changed, name));
    for (const name of ["allocations.json", "dispatch.json"]) {
      const original = fs.readFileSync(join(changed, name));
      fs.writeFileSync(join(changed, name), "{}");
      await expect(runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) },
        changed, f.root, 2000, context)).rejects.toThrow();
      fs.writeFileSync(join(changed, name), original);
    }
  });
  it("rejects reference drift, unknown files, nested paths, and symlinks", async () => {
    const f = fixture(), scriptFile = f.file("oracle.py", "pass\n");
    const oracle = { kind: "operator-script" as const, scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) };
    const refs = join(f.root, "refs"), context = referenceContext(refs);
    fs.writeFileSync(join(refs, "input.json"), "changed");
    await expect(runSprintOracle(oracle, join(f.root, "candidates"), f.root, 1000, context)).rejects.toThrow();
    fs.writeFileSync(join(refs, "input.json"), "{}");
    f.file("refs/injected.json", "{}");
    await expect(runSprintOracle(oracle, join(f.root, "candidates"), f.root, 1000, context)).rejects.toThrow();
    fs.unlinkSync(join(refs, "injected.json"));
    fs.mkdirSync(join(refs, "nested"));
    await expect(runSprintOracle(oracle, join(f.root, "candidates"), f.root, 1000, context)).rejects.toThrow();
    fs.rmdirSync(join(refs, "nested")); fs.symlinkSync(scriptFile, join(refs, "injected.json"));
    await expect(runSprintOracle(oracle, join(f.root, "candidates"), f.root, 1000, context)).rejects.toThrow();
  });
  it("isolates __file__ from worker state and rejects snapshot reference mutation", async () => {
    const f = fixture();
    const scriptFile = f.file("oracle.py", 'import os,sys\nfrom pathlib import Path\np=Path(__file__).parent\nassert str(p)!=str(Path(sys.argv[1]).parent)\nassert sorted(x.name for x in p.iterdir())==["oracle.py","reference"]\nassert "BUYER_TOKEN" not in os.environ\n(p/"reference"/"input.json").write_text("changed")\n');
    await expect(runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) },
      join(f.root, "candidates"), f.root, 1000, referenceContext(join(f.root, "refs")))).rejects.toThrow();
    expect(fs.readFileSync(join(f.root, "refs/input.json"), "utf8")).toBe("{}");
  });
  it("provides only declared references beside __file__, with no wallet files or credentials", async () => {
    const f = fixture(); f.file("wallet.json", "fixture-secret");
    const scriptFile = f.file("oracle.py", 'import os,sys\nfrom pathlib import Path\np=Path(__file__).parent\nassert p!=Path(sys.argv[1]).parent\nassert sorted(x.name for x in p.iterdir())==["oracle.py","reference"]\nassert (p/"reference"/"input.json").read_text()=="{}"\nassert "BUYER_TOKEN" not in os.environ\nassert "WALLET_PASSWORD" not in os.environ\nassert len(sys.argv)==2\n');
    const previousToken = process.env.BUYER_TOKEN, previousPassword = process.env.WALLET_PASSWORD;
    process.env.BUYER_TOKEN = "fixture-token"; process.env.WALLET_PASSWORD = "fixture-password";
    try {
      expect(await runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) },
        join(f.root, "candidates"), f.root, 1000, referenceContext(join(f.root, "refs")))).toMatchObject({ semanticOraclePassed: true });
    } finally {
      if (previousToken === undefined) delete process.env.BUYER_TOKEN; else process.env.BUYER_TOKEN = previousToken;
      if (previousPassword === undefined) delete process.env.WALLET_PASSWORD; else process.env.WALLET_PASSWORD = previousPassword;
    }
  });
  it("rejects original reference drift during oracle execution", async () => {
    const f = fixture();
    const scriptFile = f.file("oracle.py", `from pathlib import Path\nPath(${JSON.stringify(join(f.root, "refs/input.json"))}).write_text("changed")\n`);
    const context = referenceContext(join(f.root, "refs"));
    await expect(runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) },
      join(f.root, "candidates"), f.root, 1000, context)).rejects.toThrow();
  });
  it("receives only recovered directory and a clean environment", async () => {
    const f = fixture();
    const scriptFile = f.file("oracle.py", 'import os,sys\nassert len(sys.argv)==2\nassert "BUYER_TOKEN" not in os.environ\nassert "HOME" not in os.environ\nassert os.path.isdir(sys.argv[1])\n');
    process.env.BUYER_TOKEN = "must-not-leak";
    try {
      expect(await runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) }, join(f.root, "candidates"), f.root, 1000)).toEqual({ semanticOraclePassed: true, oracleKind: "operator-script" });
    } finally { delete process.env.BUYER_TOKEN; }
  });
  it("rejects changed script bytes and enforces timeout", async () => {
    const f = fixture();
    const scriptFile = f.file("oracle.py", "while True: pass\n");
    await expect(runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: "a".repeat(64) }, join(f.root, "candidates"), f.root, 20)).rejects.toThrow();
    const start = Date.now();
    await expect(runSprintOracle({ kind: "operator-script", scriptFile, scriptDigest: sprintDigest(fs.readFileSync(scriptFile)) }, join(f.root, "candidates"), f.root, 20)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
