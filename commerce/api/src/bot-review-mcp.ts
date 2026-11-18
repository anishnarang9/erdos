import { createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { AppEnv, Deps } from "./context.ts";
import { ApiError } from "./errors.ts";
import { botReviewStore } from "./bot-review-store.ts";
import { isPlainObject } from "./revision.ts";

export const BOT_REVIEW_MCP_PATH = "/integrations/grok-bot/mcp";
export const BOT_REVIEW_MCP_MAX_BYTES = 16_384;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const hex = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const indexes = { type: "array", items: { type: "integer", minimum: 0, maximum: 63 }, maxItems: 64, uniqueItems: true };
const shortText = { type: "string", minLength: 1, maxLength: 512 };
const idSchema = { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" };
const tool = {
  name: "submit_constraint_review",
  description: "Submit one semantic review for the captured brief and rules. Use the exact review ID, input hash and callback ticket from the webhook. Quote source text verbatim. Cover every rule for pass. Never approve or fund a job.",
  inputSchema: { type: "object", additionalProperties: false, required: ["reviewId", "callbackTicket", "result"], properties: {
    reviewId: idSchema, callbackTicket: { type: "string", pattern: "^[a-f0-9]{64}$" },
    result: { type: "object", additionalProperties: false,
      required: ["version", "reviewId", "inputHash", "decision", "coveredRuleIndices", "findings", "questions"], properties: {
        version: { const: 1 }, reviewId: idSchema, inputHash: hex,
        decision: { type: "string", enum: ["pass", "needs_changes", "clarify", "unsupported"] }, coveredRuleIndices: indexes,
        questions: { type: "array", items: shortText, maxItems: 3 },
        findings: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false,
          required: ["kind", "sourceQuote", "ruleIndices", "message"], properties: {
            kind: { type: "string", enum: ["omission", "contradiction", "ambiguous", "unsupported"] },
            sourceQuote: shortText, ruleIndices: indexes, message: shortText,
          } } },
      } },
  } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const digest = (token: string) => createHash("sha256").update(token, "utf8").digest();

/** Stateless Streamable HTTP subset with no job reader, wallet, revision or approval tool. */
export function registerBotReviewMcp(app: Hono<AppEnv>, deps: Deps): void {
  const config = deps.botReview;
  if (!config) return;
  const expected = digest(config.serviceToken), store = botReviewStore(deps.db);
  app.use(BOT_REVIEW_MCP_PATH, async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (header.length > 1024 || !header.startsWith("Bearer ") || !timingSafeEqual(digest(header.slice(7)), expected)) {
      throw new ApiError("unauthorized", "Invalid Bot service credential");
    }
    const protocol = c.req.header("mcp-protocol-version");
    if (protocol !== undefined && !PROTOCOLS.includes(protocol)) throw new ApiError("validation_failed", "Unsupported MCP protocol version");
    await next();
  });
  app.get(BOT_REVIEW_MCP_PATH, c => c.body(null, 405, { Allow: "POST" }));
  app.delete(BOT_REVIEW_MCP_PATH, c => c.body(null, 405, { Allow: "POST" }));
  app.post(BOT_REVIEW_MCP_PATH, async c => {
    if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return c.json({ error: "Content-Type must be application/json" }, 415);
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return c.json({ error: "Accept must include application/json and text/event-stream" }, 406);
    const declared = c.req.header("content-length");
    if (declared !== undefined && Number(declared) > BOT_REVIEW_MCP_MAX_BYTES) throw oversized();
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > BOT_REVIEW_MCP_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw oversized(); }
      chunks.push(part.value);
    }
    let message: unknown;
    try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, 400); }
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string"
      || (message.id !== undefined && typeof message.id !== "string" && !(typeof message.id === "number" && Number.isSafeInteger(message.id)))) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
    }
    if (message.id === undefined) return c.body(null, 202);
    const ok = (result: unknown) => c.json({ jsonrpc: "2.0", id: message.id, result });
    const error = (code: number, text: string) => c.json({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    if (message.method === "initialize") {
      if (!isPlainObject(message.params) || typeof message.params.protocolVersion !== "string") return error(-32602, "Invalid initialize parameters");
      return ok({ protocolVersion: PROTOCOLS.includes(message.params.protocolVersion) ? message.params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} }, serverInfo: { name: "ubc26-constraint-review", version: "1.0.0" } });
    }
    if (message.method === "ping") return ok({});
    if (message.method === "tools/list") return ok({ tools: [tool] });
    if (message.method !== "tools/call") return error(-32601, "Method not found");
    const params = message.params;
    if (!isPlainObject(params) || params.name !== tool.name || !isPlainObject(params.arguments)) return error(-32602, "Invalid tool parameters");
    const args = params.arguments;
    if (Object.keys(args).some(key => !["reviewId", "callbackTicket", "result"].includes(key))
      || typeof args.reviewId !== "string" || typeof args.callbackTicket !== "string") return error(-32602, "Invalid tool arguments");
    try {
      const receipt = store.complete(args.reviewId, args.callbackTicket, args.result, deps.now());
      const result = { reviewId: receipt.reviewId, inputHash: receipt.inputHash, status: receipt.status, decision: receipt.decision, resultHash: receipt.resultHash };
      return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      return ok({ isError: true, content: [{ type: "text", text: JSON.stringify(err.toBody()) }] });
    }
  });
}
const oversized = () => new ApiError("payload_too_large", "Bot callback exceeds the size limit");
