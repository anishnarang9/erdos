import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { migrationVersions, openDb } from "../../src/db.ts";
import {
  REVIEWED_CALL_MICRO_USD,
  REVIEWED_INPUT_MICRO_USD_PER_MILLION,
  REVIEWED_MODEL_ID,
  REVIEWED_OUTPUT_MICRO_USD_PER_MILLION,
  REVIEWED_OUTPUT_TOKENS,
  REVIEWED_PROVIDER_COST,
  blocksPublicListen,
  callMicroUsd,
  evaluateReady,
  probeDatabase,
  scratchFile,
  type ReadyInput,
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

async function reviewedInput(overrides: Partial<ReadyInput> = {}): Promise<ReadyInput> {
  const file = await scratchFile(Buffer.from("reviewed-engine"));
  const packages = await mkdtemp(join(tmpdir(), "ubc26-ready-packages-"));
  dirs.push(file.dir, packages);
  return {
    mode: "public",
    authoring: "required",
    origin: "https://api.example.test",
    engine: { mode: "real", executable: { path: file.path, sha256: file.sha256 } },
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
    expect(report.ready).toBe(true);
    expect(report.authoring).toBe("disabled");
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

  it("rejects a wrapper whose digest is absent or different and skips the wrapper when native mode has none", async () => {
    const input = await reviewedInput();
    const native = await evaluateReady(input);
    expect(native.checks.find((check) => check.name === "compiler_wrapper")).toMatchObject({ ok: true, state: "not_used" });

    const wrapper = await scratchFile(Buffer.from("wsl-host-bin"));
    dirs.push(wrapper.dir);
    const unpinned = await evaluateReady({
      ...input,
      engine: { ...input.engine, wrapper: { path: wrapper.path } },
    });
    expect(reason(unpinned, "compiler_wrapper")).toBe("unpinned");
    expect(JSON.stringify(unpinned)).not.toContain(wrapper.path);

    const wrong = await evaluateReady({
      ...input,
      engine: { ...input.engine, wrapper: { path: wrapper.path, sha256: "cd".repeat(32) } },
    });
    expect(reason(wrong, "compiler_wrapper")).toBe("digest_mismatch");
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
