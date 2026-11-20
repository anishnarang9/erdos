// Black-box helpers for T5/T6 spec tests, derived only from
// commerce/api/CONTRACT.md, commerce/api/CONTRACT-T5-T8.md and commerce/sdk/CONTRACT.md.
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { expect } from "vitest";
import { createApp } from "../../src/index.ts";
import { BUYER_TOKEN, T0, buyerHeaders, expectedRevisionHash } from "./helpers.ts";
import type { SpecApp } from "./helpers.ts";

export type Hex = `0x${string}`;

// ---------- local mirrors of the contract types ----------
export type BundleFile = { name: string; content: Uint8Array };
export type Manifest = {
  imageId: string;
  rulesHash: string;
  referenceHash: string;
  structureHash: string;
  toolchain: Record<string, string>;
  files: { name: string; sha256: string }[];
};
export type ValidateResult =
  | { ok: true; hashes?: { structureHash: string; rulesHash: string }; preview?: unknown }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown };
export type CompileResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; kind: "invalid"; errors: { path: string; message: string }[] }
  | { ok: false; kind: "unsupported"; capabilityError: unknown };
export type SpecEngine = {
  validate(plan: unknown): Promise<ValidateResult>;
  compile(input: { plan: unknown; reference: BundleFile[] }): Promise<CompileResult>;
};
export type ModelDraft =
  | {
      kind: "draft";
      plan: unknown;
      examples: { name: string; files: { name: string; content: string }[]; predictedVerdict: 0 | 1 }[];
      sourceQuotes: { path: string; quote: string }[];
    }
  | { kind: "clarification"; questions: string[] }
  | { kind: "unsupported"; reason: string };
export type DraftInput = {
  request: string;
  outputs: unknown[];
  referenceNames: string[];
  clarifications: { question: string; answer: string }[];
  schema: unknown;
  repair?: { previousPlan?: Record<string, unknown> };
};
export type DraftReply = { result: ModelDraft; model: string; traceId: string };
export type SpecDraftModel = { draft(input: DraftInput): Promise<DraftReply> };

// ---------- app construction ----------
export function makeApp56(
  opts: { engine?: SpecEngine; draftModel?: SpecDraftModel; dbPath?: string } = {},
): SpecApp {
  const clock = { t: T0 };
  const o: Record<string, unknown> = {
    dbPath: opts.dbPath ?? ":memory:",
    buyerToken: BUYER_TOKEN,
    now: () => clock.t,
  };
  if (opts.engine) o.engine = opts.engine;
  if (opts.draftModel) o.draftModel = opts.draftModel;
  const created = createApp(o as unknown as Parameters<typeof createApp>[0]);
  return { app: created.app as SpecApp["app"], close: created.close, clock };
}

// ---------- hashing (computed independently) ----------
export function sha256Bytes(...parts: (Uint8Array | string)[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
  return h.digest();
}
export function hex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}
export function jcs(v: unknown): string {
  const s = canonicalize(v);
  if (s === undefined) throw new Error("canonicalize returned undefined");
  return s;
}

/** sdk CONTRACT §1 encodeBundle: 0x01 ‖ u16be(count) ‖ per file u16be(nameLen) ‖ name ‖ u32be(len) ‖ content, sorted by name bytes. */
export function encodeBundleSpec(files: BundleFile[]): Buffer {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(3);
  head[0] = 1;
  head.writeUInt16BE(sorted.length, 1);
  parts.push(head);
  for (const f of sorted) {
    const name = Buffer.from(f.name, "utf8");
    const nl = Buffer.alloc(2);
    nl.writeUInt16BE(name.length, 0);
    const cl = Buffer.alloc(4);
    cl.writeUInt32BE(f.content.length, 0);
    parts.push(nl, name, cl, Buffer.from(f.content));
  }
  return Buffer.concat(parts);
}
export function sortFiles(files: BundleFile[]): BundleFile[] {
  return [...files].sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
}
/** referenceHash = SHA256(ASCII("UBC26/reference/v1") ‖ bundle) */
export function referenceHashSpec(files: BundleFile[]): string {
  return hex(sha256Bytes("UBC26/reference/v1", encodeBundleSpec(files)));
}
export const EMPTY_REF_HASH = hex(sha256Bytes("UBC26/reference/v1", Buffer.from([1, 0, 0])));

export function file(name: string, content: string | Uint8Array): BundleFile {
  return { name, content: typeof content === "string" ? Buffer.from(content, "utf8") : content };
}
export function refsPayload(files: BundleFile[]): { name: string; contentBase64: string }[] {
  return files.map((f) => ({ name: f.name, contentBase64: Buffer.from(f.content).toString("base64") }));
}

/**
 * simulatedEngine compile (T5-T8 §1). Reading: "‖" concatenates raw bytes; hash operands
 * (structureHash, sha256(JCS(parameters))) are their raw 32-byte digests; tags are UTF-8.
 */
export function simulatedManifestSpec(plan: Record<string, unknown>, files: BundleFile[]): Manifest {
  const structure = plan.structure ?? plan;
  const params = plan.parameters ?? {};
  const structureHash = sha256Bytes("UBC26/structure/v1", jcs(structure));
  const rulesHash = sha256Bytes("UBC26/rules/v1", structureHash, sha256Bytes(jcs(params)));
  const imageId = sha256Bytes("SIMULATED/image/v1", structureHash);
  return {
    imageId: hex(imageId),
    rulesHash: hex(rulesHash),
    referenceHash: referenceHashSpec(files),
    structureHash: hex(structureHash),
    toolchain: { engine: "simulated" },
    files: sortFiles(files).map((f) => ({ name: f.name, sha256: hex(sha256Bytes(f.content)) })),
  };
}

export { expectedRevisionHash };

// ---------- revision builders ----------
export const OUTPUTS = [{ name: "result.json", format: "json" }];
export function revisionWith(referenceDigest: string, plan: unknown = { version: 1 }): Record<string, unknown> {
  return { plan, referenceDigest, outputs: OUTPUTS, expirySeconds: 600, maxBudget: "5000000" };
}

// ---------- HTTP helpers ----------
export async function req(
  s: SpecApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: method === "GET" ? headers : buyerHeaders(headers) };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return await s.app.request(path, init);
}
export async function json(res: Response): Promise<Record<string, any>> {
  const t = await res.text();
  try {
    return JSON.parse(t) as Record<string, any>;
  } catch {
    throw new Error(`non-JSON body (status ${res.status}): ${t}`);
  }
}
export async function createJob56(
  s: SpecApp,
  revision: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<{ jobId: string; revisionHash: string }> {
  const res = await req(s, "POST", "/v1/jobs", { revision, source: "import", ...extra });
  const body = await json(res);
  expect(res.status, JSON.stringify(body)).toBe(201);
  return { jobId: body.jobId, revisionHash: body.revision.revisionHash };
}
export async function approve(s: SpecApp, jobId: string, revisionHash: string, referenceDigest: string): Promise<Response> {
  return await req(s, "POST", `/v1/jobs/${jobId}/approve`, { revisionHash, referenceDigest }, { "if-match": `"${revisionHash}"` });
}
export async function approveOk(s: SpecApp, jobId: string, revisionHash: string, referenceDigest: string): Promise<void> {
  const res = await approve(s, jobId, revisionHash, referenceDigest);
  expect(res.status, await res.clone().text()).toBe(200);
}
export async function compile(s: SpecApp, jobId: string, revisionHash: string): Promise<Response> {
  return await req(s, "POST", `/v1/jobs/${jobId}/compile`, { revisionHash });
}
export async function revise(
  s: SpecApp,
  jobId: string,
  ifMatch: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  return await req(s, "POST", `/v1/jobs/${jobId}/revisions`, body, ifMatch === undefined ? {} : { "if-match": ifMatch });
}
export async function view(s: SpecApp, jobId: string): Promise<Record<string, any>> {
  const res = await s.app.request(`/v1/jobs/${jobId}`);
  const b = await json(res);
  expect(res.status, JSON.stringify(b)).toBe(200);
  return b;
}

// ---------- fakes ----------
export function fakeModel(
  replies: DraftReply | DraftReply[] | ((input: DraftInput) => DraftReply | Promise<DraftReply>),
): SpecDraftModel & { calls: DraftInput[] } {
  const calls: DraftInput[] = [];
  let i = 0;
  return {
    calls,
    async draft(input: DraftInput) {
      calls.push(structuredClone(input));
      if (typeof replies === "function") return await replies(input);
      if (Array.isArray(replies)) return structuredClone(replies[Math.min(i++, replies.length - 1)]!);
      return structuredClone(replies);
    },
  };
}
export function draftReply(plan: unknown = { version: 1 }): DraftReply {
  return {
    result: {
      kind: "draft",
      plan,
      examples: [
        { name: "pass-case", files: [{ name: "in.txt", content: "hello" }], predictedVerdict: 1 },
        { name: "fail-case", files: [], predictedVerdict: 0 },
      ],
      sourceQuotes: [{ path: "/request", quote: "count words" }],
    },
    model: "grok-spec-model",
    traceId: "trace-spec-1",
  };
}
export function clarReply(questions = ["Which language?"]): DraftReply {
  return { result: { kind: "clarification", questions }, model: "grok-spec-model", traceId: "trace-clar" };
}
export function unsupReply(reason = "needs network"): DraftReply {
  return { result: { kind: "unsupported", reason }, model: "grok-spec-model", traceId: "trace-unsup" };
}

/** Engine with counters; behaviour overridable per method. */
export function countingEngine(
  over: Partial<{
    validate: (plan: unknown) => Promise<ValidateResult>;
    compile: (input: { plan: unknown; reference: BundleFile[] }) => Promise<CompileResult>;
  }> = {},
): SpecEngine & { validateCalls: unknown[]; compileCalls: { plan: unknown; reference: BundleFile[] }[] } {
  const validateCalls: unknown[] = [];
  const compileCalls: { plan: unknown; reference: BundleFile[] }[] = [];
  return {
    validateCalls,
    compileCalls,
    async validate(plan) {
      validateCalls.push(plan);
      return over.validate ? await over.validate(plan) : { ok: true };
    },
    async compile(input) {
      compileCalls.push(input);
      if (over.compile) return await over.compile(input);
      const plan = (input.plan ?? {}) as Record<string, unknown>;
      return { ok: true, manifest: simulatedManifestSpec(plan, input.reference) };
    },
  };
}

export const DRAFT_BODY = {
  request: "Count the words in input.txt and output result.json",
  outputs: OUTPUTS,
  expirySeconds: 600,
  maxBudget: "5000000",
};
