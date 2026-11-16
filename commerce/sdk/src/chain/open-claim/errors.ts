export type OpenClaimErrorCode =
  | "unsupported_terms"
  | "unsupported_deployment"
  | "abi_mismatch"
  | "revision_mismatch"
  | "image_mismatch"
  | "awaiting_receipt"
  | "rejected_receipt"
  | "inconsistent_progress"
  | "wrong_payout"
  | "wrong_caller"
  | "wrong_context"
  | "wrong_deployment"
  | "losing_claim"
  | "wrong_key"
  | "wrong_ciphertext"
  | "not_registered"
  | "not_funded"
  | "unsafe_signer";

export class OpenClaimError extends Error {
  readonly code: OpenClaimErrorCode;

  constructor(code: OpenClaimErrorCode, message: string) {
    super(message);
    this.name = "OpenClaimError";
    this.code = code;
  }
}
