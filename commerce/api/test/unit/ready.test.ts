import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { migrationVersions, openDb } from "../../src/db.ts";
import {
  REVIEWED_CALL_MICRO_USD,
  REVIEWED_DOCKERFILE_FRONTEND,
  REVIEWED_GUEST_BUILDER,
  REVIEWED_INPUT_MICRO_USD_PER_MILLION,
  REVIEWED_MODEL_ID,
  REVIEWED_OUTPUT_MICRO_USD_PER_MILLION,
  REVIEWED_OUTPUT_TOKENS,
  REVIEWED_PROVIDER_COST,
  blocksPublicListen,
  callMicroUsd,
  createReadyCache,
  evaluateReady,
  probeDatabase,
  scratchFile,
  type ReadyInput,
  type ReadyReport,
} from "../../src/ready.ts";

const reviewedBudget = {
  requestCeilingMicroUsd: REVIEWED_CALL_MICRO_USD,
  dailyCeilingMicroUsd: REVIEWED_CALL_MICRO_USD,
  inputMicroUsdPerMillion: REVIEWED_INPUT_MICRO_USD_PER_MILLION,
  outputMicroUsdPerMillion: REVIEWED_OUTPUT_MICRO_USD_PER_MILLION,
};

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SOURCE_SHA = "a".repeat(40);

async function reviewedInput(overrides: Partial<ReadyInput> = {}): Promise<ReadyInput> {
  const file = await scratchFile(Buffer.from("reviewed-engine"));
  const root = await mkdtemp(join(tmpdir(), "ubc26-ready-compiler-"));
  const bin = join(root, "docker-bin");
  const packages = join(root, "packages");
  await mkdir(bin);
  await mkdir(packages);
  const wrapperPath = join(bin, "docker");
  const wrapperBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  await writeFile(wrapperPath, wrapperBytes);
  const wrapperSha = createHash("sha256").update(wrapperBytes).digest("hex");
  const readyPath = join(root, "compiler-ready.json");
  await writeFile(readyPath, JSON.stringify({
    version: 1,
    status: "compiler-warmed",
    sourceSha: SOURCE_SHA,
    engineSha256: file.sha256,
    dockerfileFrontend: REVIEWED_DOCKERFILE_FRONTEND,
    guestBuilder: REVIEWED_GUEST_BUILDER,
    imageId: "img-reviewed",
    guestSha256: "e".repeat(64),
    passingVerdict: 1,
    failingVerdict: 0,
    proofGenerated: false,
    chainTransactionSent: false,
  }));
  dirs.push(file.dir, root);
  return {
    mode: "public",
    authoring: "required",
    origin: "https://api.example.test",
    engine: {
      mode: "real",
      executable: { path: file.path, sha256: file.sha256 },
      compilerPath: `${bin}:/usr/bin:/bin`,
      compilerWrapper: { path: wrapperPath, sha256: wrapperSha },
    },
    compiler: {
      sourceSha: SOURCE_SHA,
      dockerfileFrontend: REVIEWED_DOCKERFILE_FRONTEND,
      guestBuilder: REVIEWED_GUEST_BUILDER,
      readyPath,
      engineSha256: file.sha256,
    },
    model: {
      state: "live",
      id: REVIEWED_MODEL_ID,
      outputTokenBound: { parameter: "max_tokens", maxTokens: REVIEWED_OUTPUT_TOKENS },
      providerCostBound: { ...REVIEWED_PROVIDER_COST },
    },
    budget: reviewedBudget,
    chain: "arc",
    rateLimit: { expensivePerPrincipal: 4, expensivePerIp: 8 },
    database: {
      durable: true,
      writable: true,
      applied: ["001_init.sql"],
      expected: ["001_init.sql"],
    },
    packages: { path: packages },
    worker: "running",
    requireWorker: true,
    expensiveDisabled: false,
    ...overrides,
  };
}

function reason(report: { checks: { name: string; reason?: string; blocksListen: boolean; ok: boolean }[] }, name: string): string | undefined {
  return report.checks.find((check) => check.name === name)?.reason;
}

describe("production readiness evidence", () => {
  it("prices one reviewed call at the full context and the visible output cap", () => {
    expect(callMicroUsd(REVIEWED_INPUT_MICRO_USD_PER_MILLION, REVIEWED_OUTPUT_MICRO_USD_PER_MILLION)).toBe(2_540_960);
    expect(REVIEWED_CALL_MICRO_USD).toBe(2_540_960);
  });

  it("accepts the reviewed model, digest, budget, and durable database", async () => {
    const input = await reviewedInput();
    const report = await evaluateReady(input);
    expect(report.ready).toBe(true);
    expect(report.authoring).toBe("required");
    expect(blocksPublicListen(report)).toBe(false);
    expect(report.checks.some((check) => check.name.includes("quota"))).toBe(false);
    const body = JSON.stringify(report);
    expect(body).not.toContain(input.engine.executable?.path);
    expect(body).not.toContain(input.packages?.path);
  });

  it("accepts an explicit authoring opt-out without treating it as a configured model", async () => {
    const input = await reviewedInput({
      authoring: "disabled",
      model: { state: "absent" },
      budget: undefined,
    });
    const report = await evaluateReady(input);
    expect(report.ready).toBe(false);
    expect(blocksPublicListen(report)).toBe(false);
    expect(report.authoring).toBe("disabled");
    expect(reason(report, "authoring_release")).toBe("disabled");
    expect(report.checks.find((check) => check.name === "model")).toMatchObject({ ok: true, state: "disabled" });
    expect(report.checks.find((check) => check.name === "budget")).toMatchObject({ ok: true, state: "not_required" });
  });

  it("rejects an absolute executable until the configured digest matches the file bytes", async () => {
    const input = await reviewedInput();
    const path = input.engine.executable?.path ?? "";
    const missing = await evaluateReady({ ...input, engine: { mode: "real", executable: { path } } });
    expect(reason(missing, "engine_executable")).toBe("unpinned");
    expect(blocksPublicListen(missing)).toBe(true);
    expect(JSON.stringify(missing)).not.toContain(path);

    const mismatch = await evaluateReady({
      ...input,
      engine: { mode: "real", executable: { path, sha256: "ab".repeat(32) } },
    });
    expect(reason(mismatch, "engine_executable")).toBe("digest_mismatch");
    expect(JSON.stringify(mismatch)).not.toContain(path);
    expect(JSON.stringify(mismatch)).not.toContain("ab".repeat(32));

    const upper = await evaluateReady({
      ...input,
      engine: {
        mode: "real",
        executable: { path, sha256: (input.engine.executable?.sha256 ?? "").toUpperCase() },
      },
    });
    expect(upper.checks.find((check) => check.name === "engine_executable")?.ok).toBe(true);
  });

  it("accepts the dated visible cap and keeps max_tokens only for the reviewed model", async () => {
    const input = await reviewedInput();
    const dated = await evaluateReady({
      ...input,
      model: {
        ...input.model,
        outputTokenBound: { parameter: "max_completion_tokens", maxTokens: REVIEWED_OUTPUT_TOKENS },
      },
    });
    expect(dated.ready).toBe(true);
    const other = await evaluateReady({
      ...input,
      model: {
        ...input.model,
        outputTokenBound: { parameter: "max_output_tokens", maxTokens: REVIEWED_OUTPUT_TOKENS } as unknown as ReadyInput["model"]["outputTokenBound"],
      },
    });
    expect(reason(other, "model")).toBe("output_bound_unreliable");
  });

  it("pins the docker shim only when the child PATH selects that file", async () => {
    const input = await reviewedInput();
    expect(await evaluateReady(input)).toMatchObject({ ready: true });
    const unrelated = await scratchFile(Buffer.from("other-docker"));
    dirs.push(unrelated.dir);
    const missed = await evaluateReady({
      ...input,
      engine: {
        ...input.engine,
        compilerWrapper: { path: join(unrelated.dir, "docker"), sha256: unrelated.sha256 },
      },
    });
    expect(reason(missed, "compiler_wrapper")).toBe("not_selected");
    expect(blocksPublicListen(missed)).toBe(true);
    expect(JSON.stringify(missed)).not.toContain(unrelated.path);

    const selected = input.engine.compilerWrapper?.path ?? "";
    const mismatch = await evaluateReady({
      ...input,
      engine: { ...input.engine, compilerWrapper: { path: selected, sha256: "cd".repeat(32) } },
    });
    expect(reason(mismatch, "compiler_wrapper")).toBe("digest_mismatch");
    expect(JSON.stringify(mismatch)).not.toContain(selected);

    const linkDir = await mkdtemp(join(tmpdir(), "ubc26-ready-link-"));
    dirs.push(linkDir);
    const link = join(linkDir, "docker");
    await symlink(selected, link);
    const linked = await evaluateReady({
      ...input,
      engine: {
        ...input.engine,
        compilerPath: `${linkDir}:/usr/bin:/bin`,
        compilerWrapper: { path: link, sha256: input.engine.compilerWrapper?.sha256 },
      },
    });
    expect(reason(linked, "compiler_wrapper")).toBe("unreadable");
    expect(JSON.stringify(linked)).not.toContain(link);
  });

  it("rejects replay, recording, and an unreviewed live model even when authoring is disabled", async () => {
    const input = await reviewedInput({ authoring: "disabled", budget: undefined });
    expect(reason(await evaluateReady({ ...input, model: { state: "replay" } }), "model")).toBe("replay_model");
    expect(reason(await evaluateReady({ ...input, model: { state: "recording" } }), "model")).toBe("recording_model");
    const wrong = await evaluateReady({
      ...input,
      authoring: "required",
      budget: reviewedBudget,
      model: {
        state: "live",
        id: "grok-4.7",
        outputTokenBound: { parameter: "max_tokens", maxTokens: REVIEWED_OUTPUT_TOKENS },
        providerCostBound: { ...REVIEWED_PROVIDER_COST },
      },
    });
    expect(reason(wrong, "model")).toBe("unreviewed_model");
    expect(blocksPublicListen(wrong)).toBe(true);
  });

  it("rejects a live model whose visible cap or context price is not the reviewed bound", async () => {
    const input = await reviewedInput();
    const short = await evaluateReady({
      ...input,
      model: {
        state: "live",
        id: REVIEWED_MODEL_ID,
        outputTokenBound: { parameter: "max_tokens", maxTokens: 1024 },
        providerCostBound: { ...REVIEWED_PROVIDER_COST },
      },
    });
    expect(reason(short, "model")).toBe("output_bound_unreliable");
    const unbounded = await evaluateReady({
      ...input,
      model: {
        state: "live",
        id: REVIEWED_MODEL_ID,
        outputTokenBound: { parameter: "max_tokens", maxTokens: REVIEWED_OUTPUT_TOKENS },
      },
    });
    expect(reason(unbounded, "model")).toBe("context_bound_unreliable");
  });

  it("labels estimated spending for local pilots and rejects it in public mode", async () => {
    const input = await reviewedInput({
      mode: "local",
      budget: { ...reviewedBudget, requestCeilingMicroUsd: 60_000, reservationMode: "estimated" },
    });
    const local = await evaluateReady(input);
    expect(local.checks.find((c) => c.name === "budget")).toMatchObject({ ok: true, state: "estimated" });
    expect(reason(await evaluateReady({ ...input, mode: "public" }), "budget")).toBe("estimated_requires_local");
  });

  it("requires the request ceiling to cover the operator tariff, not only the reviewed floor", async () => {
    const input = await reviewedInput({
      budget: {
        ...reviewedBudget,
        inputMicroUsdPerMillion: 3_000_000,
        requestCeilingMicroUsd: REVIEWED_CALL_MICRO_USD,
      },
    });
    expect(reason(await evaluateReady(input), "budget")).toBe("below_call");
    const covered = callMicroUsd(3_000_000, REVIEWED_OUTPUT_MICRO_USD_PER_MILLION);
    expect(covered).toBe(3_040_960);
    const enough = await evaluateReady({
      ...input,
      budget: {
        ...reviewedBudget,
        inputMicroUsdPerMillion: 3_000_000,
        requestCeilingMicroUsd: covered ?? 0,
        dailyCeilingMicroUsd: covered ?? 0,
      },
    });
    expect(enough.checks.find((check) => check.name === "budget")?.ok).toBe(true);
  });

  it("rejects a cached rate above the input rate and a missing public budget", async () => {
    const highCache = await reviewedInput({
      budget: { ...reviewedBudget, cachedInputMicroUsdPerMillion: REVIEWED_INPUT_MICRO_USD_PER_MILLION + 1 },
    });
    expect(reason(await evaluateReady(highCache), "budget")).toBe("cached_rate_above_input");
    const missing = await reviewedInput({ budget: undefined });
    expect(reason(await evaluateReady(missing), "budget")).toBe("missing");
  });

  it("rejects simulated and missing chains, insecure origins, and credentials in the origin", async () => {
    const input = await reviewedInput();
    expect(reason(await evaluateReady({ ...input, chain: "simulated" }), "chain")).toBe("simulated_chain");
    expect(reason(await evaluateReady({ ...input, chain: "absent" }), "chain")).toBe("missing");
    expect(reason(await evaluateReady({ ...input, origin: "http://api.example.test" }), "origin")).toBe("not_https");
    const secret = "s3cret-password";
    const leaked = await evaluateReady({ ...input, origin: `https://operator:${secret}@api.example.test` });
    expect(reason(leaked, "origin")).toBe("origin_has_credentials");
    expect(JSON.stringify(leaked)).not.toContain(secret);
  });

  it("rejects a memory database, a missing migration, and an unwritable package directory", async () => {
    const input = await reviewedInput();
    expect(reason(await evaluateReady({
      ...input,
      database: { durable: false, writable: true, applied: ["001_init.sql"], expected: ["001_init.sql"] },
    }), "database")).toBe("not_durable");
    const missing = await evaluateReady({
      ...input,
      database: { durable: true, writable: true, applied: ["001_init.sql"], expected: ["001_init.sql", "017_example.sql"] },
    });
    expect(reason(missing, "migrations")).toBe("missing:017_example.sql");
    expect(reason(await evaluateReady({ ...input, packages: { path: "relative-packages" } }), "packages")).toBe("not_absolute");
    expect(reason(await evaluateReady({ ...input, packages: {} }), "packages")).toBe("unconfigured");
  });

  it("reports a draining worker and a paused runner without blocking listen", async () => {
    const input = await reviewedInput();
    const draining = await evaluateReady({ ...input, worker: "draining" });
    expect(draining.ready).toBe(false);
    expect(reason(draining, "worker")).toBe("draining");
    expect(blocksPublicListen(draining)).toBe(false);
    const paused = await evaluateReady({ ...input, expensiveDisabled: true });
    expect(paused.ready).toBe(false);
    expect(reason(paused, "expensive_ops")).toBe("disabled");
    expect(blocksPublicListen(paused)).toBe(false);
  });

  it("keeps local mode listening while the same gaps stay visible", async () => {
    const input = await reviewedInput({ mode: "local", engine: { mode: "simulated" }, chain: "absent", origin: "http://localhost" });
    const report = await evaluateReady(input);
    expect(report.ready).toBe(false);
    expect(reason(report, "engine")).toBe("simulated_engine");
    expect(blocksPublicListen(report)).toBe(false);
    expect(report.checks.every((check) => check.blocksListen === false)).toBe(true);
  });

  it("keeps a missing or warming compiler record not ready without blocking listen", async () => {
    const input = await reviewedInput();
    const missing = await evaluateReady({ ...input, compiler: { ...input.compiler, readyPath: `${input.compiler?.readyPath ?? ""}.missing` } });
    expect(reason(missing, "compiler_ready")).toBe("not_warmed");
    expect(blocksPublicListen(missing)).toBe(false);
    expect(missing.ready).toBe(false);
    await writeFile(input.compiler?.readyPath ?? "", JSON.stringify({ version: 1, status: "warming", sourceSha: SOURCE_SHA }));
    const warming = await evaluateReady(input);
    expect(reason(warming, "compiler_ready")).toBe("warming");
    expect(blocksPublicListen(warming)).toBe(false);
    await writeFile(input.compiler?.readyPath ?? "", JSON.stringify({
      version: 1, status: "compiler-warmed", sourceSha: "b".repeat(40), engineSha256: input.compiler?.engineSha256,
      dockerfileFrontend: REVIEWED_DOCKERFILE_FRONTEND, guestBuilder: REVIEWED_GUEST_BUILDER,
      imageId: "img", guestSha256: "e".repeat(64), passingVerdict: 1, failingVerdict: 0,
      proofGenerated: false, chainTransactionSent: false,
    }));
    const wrong = await evaluateReady(input);
    expect(reason(wrong, "compiler_ready")).toBe("identity_mismatch");
    expect(blocksPublicListen(wrong)).toBe(false);
    expect(JSON.stringify(wrong)).not.toContain("b".repeat(40));

    const link = `${input.compiler?.readyPath}.link`;
    await symlink(input.compiler?.readyPath ?? "", link);
    const linked = await evaluateReady({ ...input, compiler: { ...input.compiler, readyPath: link } });
    expect(reason(linked, "compiler_ready")).toBe("corrupt");
    expect(blocksPublicListen(linked)).toBe(false);
    expect(JSON.stringify(linked)).not.toContain(link);

    const huge = `${input.compiler?.readyPath}.huge`;
    await writeFile(huge, Buffer.alloc(65_537, 1));
    const oversized = await evaluateReady({ ...input, compiler: { ...input.compiler, readyPath: huge } });
    expect(reason(oversized, "compiler_ready")).toBe("corrupt");
    expect(blocksPublicListen(oversized)).toBe(false);
  });

  it("blocks public listen when the image identity is not the reviewed pin", async () => {
    const input = await reviewedInput({ compiler: { sourceSha: "short", dockerfileFrontend: REVIEWED_DOCKERFILE_FRONTEND, guestBuilder: REVIEWED_GUEST_BUILDER } });
    const report = await evaluateReady(input);
    expect(reason(report, "compiler_identity")).toBe("identity_mismatch");
    expect(blocksPublicListen(report)).toBe(true);
  });

  it("reports a read-only database as not writable and leaves no probe table", async () => {
    const root = await mkdtemp(join(tmpdir(), "ubc26-ready-ro-"));
    dirs.push(root);
    const file = join(root, "ready.db");
    const writer = openDb(file, () => Date.now());
    writer.close();
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      expect(probeDatabase(reader, file).writable).toBe(false);
    } finally {
      reader.close();
    }
    const check = new DatabaseSync(file);
    try {
      expect(probeDatabase(check, file).writable).toBe(true);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'ready_write_probe'").all()).toEqual([]);
    } finally {
      check.close();
    }
  });

  it("shares one readiness evaluation and drops a cached success as soon as draining starts", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const pending = new Promise<ReadyReport>((resolve) => {
      release = () => resolve({ ready: true, authoring: "required", checks: [{ name: "worker", ok: true, blocksListen: false }] });
    });
    const gate = createReadyCache(() => {
      calls += 1;
      return pending;
    });
    const first = gate.current("running", true);
    const second = gate.current("running", true);
    expect(calls).toBe(1);
    const drained = await gate.current("draining", true);
    expect(drained.ready).toBe(false);
    expect(drained.checks.find((check) => check.name === "worker")?.reason).toBe("draining");
    expect(calls).toBe(1);
    release();
    expect((await first).ready).toBe(true);
    expect((await second).ready).toBe(true);
    const again = createReadyCache(async () => {
      calls += 1;
      return { ready: true, authoring: "required", checks: [] };
    }, 0);
    await again.current("running", true);
    await again.current("running", true);
    expect(calls).toBe(3);
  });

  it("probes database durability without putting the path in the result", () => {
    const memory = openDb(":memory:", () => Date.now());
    try {
      const probed = probeDatabase(memory, ":memory:");
      expect(probed.durable).toBe(false);
      expect(probed.writable).toBe(true);
      expect(probed.applied).toEqual(migrationVersions());
      expect(JSON.stringify(probed)).not.toContain(":memory:");
    } finally {
      memory.close();
    }
  });
});

describe("GET /readyz", () => {
  it("returns 503 when the app has no readiness callback and keeps liveness separate", async () => {
    const created = createApp({ dbPath: ":memory:", buyerToken: "0123456789abcdef" });
    try {
      const live = await created.app.request("/healthz");
      expect(live.status).toBe(200);
      const ready = await created.app.request("/readyz");
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ ready: false, checks: [{ name: "ready", reason: "not_configured" }] });
    } finally {
      created.close();
    }
  });

  it("returns the readiness report without paths or origin credentials", async () => {
    const input = await reviewedInput({ origin: "https://operator:s3cret-password@api.example.test" });
    const created = createApp({
      dbPath: ":memory:",
      buyerToken: "0123456789abcdef",
      ready: () => evaluateReady(input),
    });
    try {
      const ready = await created.app.request("/readyz");
      expect(ready.status).toBe(503);
      const body = await ready.text();
      expect(body).not.toContain(input.engine.executable?.path);
      expect(body).not.toContain("s3cret-password");
      expect(body).toContain("origin_has_credentials");
    } finally {
      created.close();
    }
  });

  it("returns 200 when the callback reports ready", async () => {
    const created = createApp({
      dbPath: ":memory:",
      buyerToken: "0123456789abcdef",
      ready: async () => ({ ready: true, authoring: "disabled", checks: [] }),
    });
    try {
      const ready = await created.app.request("/readyz");
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ ready: true, authoring: "disabled" });
    } finally {
      created.close();
    }
  });
});

describe("digest helper", () => {
  it("hashes the bytes it writes", async () => {
    const file = await scratchFile(Buffer.from("pin-me"));
    dirs.push(file.dir);
    expect(file.sha256).toBe(createHash("sha256").update("pin-me").digest("hex"));
  });
});
