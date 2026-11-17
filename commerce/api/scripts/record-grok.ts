// Records real Grok drafts through the API with the real engine, for the integration tests and for Anish.
//   cd commerce/api && corepack pnpm record:grok
// Needs in commerce/api/.env (gitignored): XAI_API_KEY, XAI_MODEL (unset: lists the models your key can use),
// ENGINE_MODE=wsl, ENGINE_PATH, ENGINE_WORK_DIR. Writes test/integration/fixtures/grok/<sha256(input)>.json
// (input and the model's reply; never the key) and summary.json (the API responses).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, engineConfigFromEnv, engineFromConfig, grokDraftModel, recordingDraftModel } from "../src/index.ts";
import { CASES } from "../test/integration/grok-cases.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) throw new Error("XAI_API_KEY is not set (put it in commerce/api/.env)");

if (!process.env.XAI_MODEL) {
  const res = await fetch("https://api.x.ai/v1/models", { headers: { authorization: `Bearer ${apiKey}` } });
  const body = (await res.json()) as { data?: { id: string }[] };
  console.log("XAI_MODEL is not set. Models available to this key:", (body.data ?? []).map((m) => m.id).join(", "));
  process.exit(1);
}
const config = engineConfigFromEnv(process.env);
if (!config) throw new Error("Set ENGINE_MODE=wsl and ENGINE_PATH: drafts are validated by the real engine");

const OUT = fileURLToPath(new URL("../test/integration/fixtures/grok/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const { engine, label } = engineFromConfig(config);
const TOKEN = "record-grok-buyer-token-000000";
const model = recordingDraftModel(grokDraftModel({ apiKey, model: process.env.XAI_MODEL }), OUT);
const { app, close } = createApp({ dbPath: ":memory:", buyerToken: TOKEN, engine, draftModel: model });

const summary: Record<string, unknown> = { model: process.env.XAI_MODEL, engine: label, recordedAt: new Date().toISOString(), cases: {} };
let i = 0;
for (const [name, c] of Object.entries(CASES)) {
  let body = c.body;
  for (let round = 0; round < 3; round++) {
    const res = await app.request("/v1/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": `rec-${++i}` },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as Record<string, any>;
    console.log(`[${name}] round ${round + 1}: HTTP ${res.status} kind=${out.kind ?? out.error?.code} ${out.reason ?? ""}`);
    (summary.cases as Record<string, unknown[]>)[name] ??= [];
    (summary.cases as Record<string, unknown[]>)[name]!.push({ request: body, status: res.status, response: out });
    // Answer a clarification once with the case's prepared answer, then stop.
    if (out.kind === "clarification" && c.answer && round === 0) {
      body = { ...body, clarifications: [{ question: (out.questions as string[]).join(" "), answer: c.answer }] };
      continue;
    }
    break;
  }
}
close();
const text = JSON.stringify(summary, null, 2) + "\n";
if (text.includes(apiKey)) throw new Error("refusing to write: the summary contains the API key");
writeFileSync(join(OUT, "summary.json"), text);
console.log(`Wrote ${OUT}summary.json.`);
