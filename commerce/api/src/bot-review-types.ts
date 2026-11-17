export interface BotReviewDelivery {
  reviewId: string;
  callbackTicket: string;
  inputHash: string;
  input: unknown;
  expiresAt: number;
  callbackUrl: string;
}
/** Absent configuration disables the integration and its approval gate. */
export interface BotReviewConfig {
  /** A dedicated random credential for the result MCP tool. */
  serviceToken: string;
  /** Omitted keeps reviews queued. Production needs spending authority before setting this. */
  dispatch?: (delivery: BotReviewDelivery) => Promise<void>;
}
