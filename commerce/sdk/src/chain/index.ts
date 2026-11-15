// T3 chain adapter (SIMULATED ABI). Implements ../../CONTRACT.md §2.
export { createCommerceChain, decodeRevertName, DEFAULT_RELEASE_GAS, DEFAULT_RELEASE_MARGIN_SEC, extractRevertData } from "./chain.ts";
export type { CommerceChain } from "./chain.ts";
export { ChainError } from "./errors.ts";
export type { ChainErrorCode } from "./errors.ts";
export { LogCursor } from "./cursor.ts";
export type { CursorStore, LogCursorOptions } from "./cursor.ts";
export { isRateLimitError, withRetry } from "./retry.ts";
export type { RetryOptions } from "./retry.ts";
export { JobStatus } from "./types.ts";
export type {
  ChainConfig,
  DecodedEvent,
  FrozenTerms,
  JobView,
  PreflightResult,
  SubmissionInput,
  SubmittedEnvelope,
  WriteOptions,
} from "./types.ts";
export { fundJob } from "./fund.ts";
export type { FundingTerms, FundJobResult } from "./fund.ts";
export { mockRiscZeroVerifierAbi, mockUsdcAbi, stubCoreAbi, stubProofGateAbi } from "./abi.ts";
