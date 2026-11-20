import type { BotReviewConfig } from "./bot-review-types.ts";
import type { ReadyReport } from "./ready.ts";
import { createBotWebhook } from "./bot-review-webhook.ts";

/** Configure callback bootstrap, public review, or a bounded test pilot. */
export function botReviewFromEnv(env: Record<string, string | undefined>, callbackUrl?: string,
  deploymentMode?: "local" | "public"): BotReviewConfig | undefined {
  if (env.BOT_REVIEW_PUBLIC_ACCESS !== undefined
    && (env.BOT_REVIEW_PUBLIC_ACCESS !== "1" || env.BOT_REVIEW_LIVE_DISPATCH !== "1")) {
    throw new Error("Public Bot review requires live dispatch");
  }
  const live = env.BOT_REVIEW_LIVE_DISPATCH === "1";
  if (env.BOT_REVIEW_LIVE_DISPATCH && !["0", "1"].includes(env.BOT_REVIEW_LIVE_DISPATCH))
    throw new Error("Live Bot dispatch requires a reviewed spending policy");
  if (!live && [env.BOT_REVIEW_WEBHOOK_URL, env.BOT_REVIEW_WEBHOOK_TOKEN,
    env.BOT_REVIEW_PILOT_OWNER, env.BOT_REVIEW_PILOT_MAX_DISPATCHES].some(Boolean))
    throw new Error("Live Bot dispatch requires a reviewed spending policy");
  const required = env.BOT_REVIEW_REQUIRED ?? "0";
  if (required === "0" && !live) return undefined;
  const token = env.BOT_REVIEW_SERVICE_TOKEN;
  if (required !== "1" || !token || !/^[A-Za-z0-9._~-]{32,512}$/.test(token)
    || token === env.BUYER_API_TOKEN || token === env.OPERATOR_TOKEN) throw new Error("Invalid Bot review configuration");
  if (!live) return { serviceToken: token };
  if (env.BOT_REVIEW_PUBLIC_ACCESS === "1") {
    if (deploymentMode !== "public"
      || Object.keys(env).some(key => key.startsWith("BOT_REVIEW_PILOT_") && env[key])
      || !env.BOT_REVIEW_WEBHOOK_URL || !env.BOT_REVIEW_WEBHOOK_TOKEN || !callbackUrl
      || [token, env.BUYER_API_TOKEN, env.OPERATOR_TOKEN].includes(env.BOT_REVIEW_WEBHOOK_TOKEN)) {
      throw new Error("Public Bot review requires a separate webhook and callback credential");
    }
    return { serviceToken: token, publicAccess: true,
      dispatch: createBotWebhook({ url: env.BOT_REVIEW_WEBHOOK_URL, token: env.BOT_REVIEW_WEBHOOK_TOKEN, callbackUrl }) };
  }
  const owner = env.BOT_REVIEW_PILOT_OWNER;
  const maxDispatches = env.BOT_REVIEW_PILOT_MAX_DISPATCHES;
  if (!owner || !/^0x[0-9a-f]{40}$/.test(owner)
    || !["1", "2", "3", ...(deploymentMode === "local" ? ["10"] : [])].includes(maxDispatches ?? "")
    || !env.BOT_REVIEW_WEBHOOK_URL || !env.BOT_REVIEW_WEBHOOK_TOKEN || !callbackUrl
    || env.BOT_REVIEW_WEBHOOK_TOKEN === token || env.BOT_REVIEW_WEBHOOK_TOKEN === env.BUYER_API_TOKEN
    || env.BOT_REVIEW_WEBHOOK_TOKEN === env.OPERATOR_TOKEN) throw new Error("Live Bot dispatch requires a reviewed spending policy");
  const dispatch = createBotWebhook({ url: env.BOT_REVIEW_WEBHOOK_URL,
    token: env.BOT_REVIEW_WEBHOOK_TOKEN, callbackUrl });
  return { serviceToken: token, pilotOwner: owner,
    maxDispatches: maxDispatches === "10" ? 10 : maxDispatches === "3" ? 3
      : maxDispatches === "2" ? 2 : 1, dispatch };
}

/** A live process can accept restricted callbacks while normal public readiness remains false. */
export function withBotReviewReady(report: ReadyReport, config: BotReviewConfig | undefined): ReadyReport {
  if (!config || config.dispatch) return report;
  return { ...report, ready: false, checks: [...report.checks,
    { name: "bot_review", ok: false, reason: "dispatch_disabled", blocksListen: false }] };
}
