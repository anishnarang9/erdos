export type ChainErrorCode = "reverted" | "wrong_chain" | "not_submit" | "no_wallet";

export class ChainError extends Error {
  readonly code: ChainErrorCode;
  readonly errorName?: string;

  constructor(code: ChainErrorCode, message?: string, errorName?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "ChainError";
    this.code = code;
    if (errorName !== undefined) this.errorName = errorName;
  }
}
