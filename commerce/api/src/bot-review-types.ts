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
  /** Restricts the live synthetic pilot to one wallet. */
  pilotOwner?: string;
  /** Durable maximum number of webhook claims for that wallet. */
  maxDispatches?: 1 | 2 | 3 | 4 | 10;
  /** Durable draft limit for the same wallet. Defaults to maxDispatches. */
  maxDrafts?: 1 | 2 | 3 | 4 | 5 | 10;
}
