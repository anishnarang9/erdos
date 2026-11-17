import type { BotReviewConfig } from "./bot-review-types.ts";
import type { ReadyReport } from "./ready.ts";

/** Callback bootstrap only. This profile cannot start a paid Bot task. */
export function botReviewFromEnv(env: Record<string, string | undefined>): BotReviewConfig | undefined {
  if (env.BOT_REVIEW_WEBHOOK_URL || env.BOT_REVIEW_WEBHOOK_TOKEN || (env.BOT_REVIEW_LIVE_DISPATCH && env.BOT_REVIEW_LIVE_DISPATCH !== "0")) {
    throw new Error("Live Bot dispatch requires a reviewed spending policy");
  }
  const required = env.BOT_REVIEW_REQUIRED ?? "0";
  if (required === "0") return undefined;
  const token = env.BOT_REVIEW_SERVICE_TOKEN;
  if (required !== "1" || !token || !/^[A-Za-z0-9._~-]{32,512}$/.test(token)
    || token === env.BUYER_API_TOKEN || token === env.OPERATOR_TOKEN) throw new Error("Invalid Bot review configuration");
  return { serviceToken: token };
}

/** A live process can accept restricted callbacks while normal public readiness remains false. */
export function withBotReviewReady(report: ReadyReport, config: BotReviewConfig | undefined): ReadyReport {
  if (!config || config.dispatch) return report;
  return { ...report, ready: false, checks: [...report.checks,
    { name: "bot_review", ok: false, reason: "dispatch_disabled", blocksListen: false }] };
}
