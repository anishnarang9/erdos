// Replays the recorded real Grok drafts (scripts/record-grok.ts) through the API and the real engine.
// The recordings are keyed by sha256(JCS(model input)), so a prompt, schema or catalog change needs a re-record.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, engineConfigFromEnv, engineFromConfig, replayDraftModel } from "../../src/index.ts";
import { CASES } from "./grok-cases.ts";

const DIR = fileURLToPath(new URL("./fixtures/grok/", import.meta.url));
const recorded = existsSync(join(DIR, "summary.json"));
const config = engineConfigFromEnv(process.env);
if (!config) throw new Error("Set ENGINE_MODE=wsl (or native) and ENGINE_PATH to run the real-engine suite");
if (!recorded) console.warn("[grok-replay] NOT RUN: no recordings yet. Run `corepack pnpm record:grok` with XAI_API_KEY in .env.");

const TOKEN = "grok-replay-buyer-token-0000000";
const dbDir = mkdtempSync(join(tmpdir(), "ubc26-grok-replay-"));
const { app, close } = createApp({
  dbPath: join(dbDir, "api.db"),
  buyerToken: TOKEN,
  engine: engineFromConfig(config).engine,
  draftModel: replayDraftModel(DIR),
});
afterAll(() => {
  close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe.skipIf(!recorded)("recorded Grok drafts on the real engine", () => {
  let n = 0;
  const draft = async (body: unknown) => {
    const res = await app.request("/v1/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `r${++n}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("success: Grok's reconciliation plan validates and its examples are labelled by the checker", async () => {
    const r = await draft(CASES.reconciliation!.body);
    // A clarification round may come first; the recorder answered it once.
    const final = r.body.kind === "clarification"
      ? await draft({ ...CASES.reconciliation!.body, clarifications: [{ question: (r.body.questions as string[]).join(" "), answer: CASES.reconciliation!.answer! }] })
      : r;
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect(final.body.kind).toBe("draft");
    expect(final.body.engine.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(final.body.examples.length).toBeGreaterThan(0);
    for (const e of final.body.examples) expect([0, 1, null]).toContain(e.checkerVerdict);
  });

  it("unsupported: the regex request comes back as the engine's capability request", async () => {
    const r = await draft(CASES.regexEmails!.body);
    const final = r.body.kind === "clarification"
      ? await draft({ ...CASES.regexEmails!.body, clarifications: [{ question: (r.body.questions as string[]).join(" "), answer: CASES.regexEmails!.answer! }] })
      : r;
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect(final.body.kind).toBe("unsupported");
    expect(final.body.reason).toBe("capability_unsupported");
    expect(final.body.capabilityError.code).toBe("unsupported_capability");
    expect(final.body.capabilityError.request.kind).toBeTruthy();
  });
});
