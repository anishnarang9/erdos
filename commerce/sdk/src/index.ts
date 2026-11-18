// @ubc26/sdk public entry. See ../CONTRACT.md.
export * from "./codec/index.ts";
export * from "./chain/index.ts";
export * from "./hosted/client.ts";
export { type HostedBotDecision, type HostedBotResult, type HostedBotReview, type HostedBotReviewInput } from "./hosted/bot-review.ts";
// Real Arc settlement client (Nick's deployed contracts): `import { arc } from "@ubc26/sdk"`. See chain/arc/README.md.
export * as arc from "./chain/arc/index.ts";
