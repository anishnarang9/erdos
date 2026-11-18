import { describe, expect, it } from "vitest";
import { botReviewFromEnv, withBotReviewReady } from "../../src/bot-review-config.ts";
import type { ReadyReport } from "../../src/ready.ts";
const token = "callback-only-test-credential-0123456789";
describe("production Bot callback profile", () => {
  it("stays off by default and never substitutes an xAI key", () => {
    expect(botReviewFromEnv({})).toBeUndefined();
    expect(botReviewFromEnv({ BOT_REVIEW_REQUIRED: "0", XAI_API_KEY: "not-a-bot-key" })).toBeUndefined();
    expect(() => botReviewFromEnv({ BOT_REVIEW_REQUIRED: "1", XAI_API_KEY: token })).toThrow("Invalid Bot review configuration");
  });
  it("enables only authenticated callbacks and an approval gate, with no paid dispatcher", () => {
    const config = botReviewFromEnv({ BOT_REVIEW_REQUIRED: "1", BOT_REVIEW_SERVICE_TOKEN: token });
    expect(config).toEqual({ serviceToken: token }); expect(config?.dispatch).toBeUndefined();
  });
  it("rejects unsafe credentials, conflicting credentials and ambiguous flags without reflecting secrets", () => {
    for (const fields of [{ BOT_REVIEW_REQUIRED: "yes" }, { BOT_REVIEW_REQUIRED: "1" },
      { BOT_REVIEW_REQUIRED: "1", BOT_REVIEW_SERVICE_TOKEN: "secret\nline" },
      { BOT_REVIEW_REQUIRED: "1", BOT_REVIEW_SERVICE_TOKEN: token, BUYER_API_TOKEN: token },
      { BOT_REVIEW_REQUIRED: "1", BOT_REVIEW_SERVICE_TOKEN: token, OPERATOR_TOKEN: token }]) {
      expect(() => botReviewFromEnv(fields)).toThrow(/^Invalid Bot review configuration$/);
    }
  });
  it("refuses live webhook environment settings before a reviewed spending policy exists", () => {
    for (const extra of [{ BOT_REVIEW_WEBHOOK_URL: "https://secret.example/routine" }, { BOT_REVIEW_WEBHOOK_TOKEN: token }, { BOT_REVIEW_LIVE_DISPATCH: "1" }]) {
      expect(() => botReviewFromEnv({ BOT_REVIEW_REQUIRED: "1", BOT_REVIEW_SERVICE_TOKEN: token, ...extra }))
        .toThrow(/^Live Bot dispatch requires a reviewed spending policy$/);
    }
  });
  it("keeps public readiness false during callback bootstrap without blocking process startup", () => {
    const base: ReadyReport = { ready: true, authoring: "required", checks: [] };
    expect(withBotReviewReady(base, undefined)).toBe(base);
    const result = withBotReviewReady(base, { serviceToken: token });
    expect(result.ready).toBe(false); expect(result.checks).toEqual([{ name: "bot_review", ok: false, reason: "dispatch_disabled", blocksListen: false }]);
    expect(base.ready).toBe(true); expect(base.checks).toEqual([]);
  });
  it("accepts only a one-wallet, bounded live pilot with an exact HTTPS callback", () => {
    const live = { BOT_REVIEW_REQUIRED: "1", BOT_REVIEW_SERVICE_TOKEN: token,
      BOT_REVIEW_LIVE_DISPATCH: "1", BOT_REVIEW_WEBHOOK_URL: "https://bot.example/hook",
      BOT_REVIEW_WEBHOOK_TOKEN: token + "-webhook", BOT_REVIEW_PILOT_OWNER: "0x" + "a".repeat(40),
      BOT_REVIEW_PILOT_MAX_DISPATCHES: "1" };
    const callback = "https://api.example/integrations/grok-bot/mcp";
    const config = botReviewFromEnv(live, callback);
    expect(config).toMatchObject({ pilotOwner: live.BOT_REVIEW_PILOT_OWNER, maxDispatches: 1 });
    expect(config?.dispatch).toBeTypeOf("function");
    expect(botReviewFromEnv({ ...live, BOT_REVIEW_PILOT_MAX_DISPATCHES: "2" }, callback)?.maxDispatches).toBe(2);
    expect(botReviewFromEnv({ ...live, BOT_REVIEW_PILOT_MAX_DISPATCHES: "3" }, callback)?.maxDispatches).toBe(3);
    const oneMoreDraft = botReviewFromEnv({ ...live, BOT_REVIEW_PILOT_MAX_DISPATCHES: "3",
      BOT_REVIEW_PILOT_MAX_DRAFTS: "4" }, callback, "public");
    expect(oneMoreDraft).toMatchObject({ maxDispatches: 3, maxDrafts: 4 });
    expect(() => botReviewFromEnv({ ...live, BOT_REVIEW_PILOT_MAX_DRAFTS: "5" }, callback, "public")).toThrow();
    expect(() => botReviewFromEnv({ ...live, BOT_REVIEW_PILOT_MAX_DISPATCHES: "10" }, callback)).toThrow();
    expect(() => botReviewFromEnv({ ...live, BOT_REVIEW_PILOT_MAX_DISPATCHES: "10" }, callback, "public")).toThrow();
    expect(botReviewFromEnv({ ...live, BOT_REVIEW_PILOT_MAX_DISPATCHES: "10" }, callback, "local")?.maxDispatches).toBe(10);
    for (const changed of [{ BOT_REVIEW_PILOT_OWNER: undefined }, { BOT_REVIEW_PILOT_MAX_DISPATCHES: "4" },
      { BOT_REVIEW_WEBHOOK_TOKEN: undefined }, { BOT_REVIEW_WEBHOOK_URL: "http://bot.example/hook" }]) {
      expect(() => botReviewFromEnv({ ...live, ...changed }, callback)).toThrow();
    }
    expect(() => botReviewFromEnv(live, "http://api.example/integrations/grok-bot/mcp")).toThrow();
  });
});
