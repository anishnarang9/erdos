// @ubc26/api public entry. See ../CONTRACT.md.
export { createApp, type CreateAppOptions, type CreatedApp } from "./app.ts";
export {
  simulatedValidatePlan,
  revisionHash,
  validateRevisionShape,
  REVISION_HASH_DOMAIN,
  type PlanValidator,
  type Revision,
  type FieldError,
} from "./revision.ts";
export { providerAuthMessage, AUTH_WINDOW_SECONDS } from "./auth.ts";
export { ApiError, ERROR_STATUS, type ErrorCode, type ErrorBody } from "./errors.ts";
export { MAX_BODY_BYTES, type AppEnv } from "./context.ts";
export {
  simulatedEngine,
  cliEngine,
  wslEngine,
  engineConfigFromEnv,
  engineFromConfig,
  wslEngineBin,
  windowsToWslPath,
  parseEngineError,
  parseManifest,
  manifestSchema,
  EngineError,
  type Engine,
  type EngineBin,
  type CliEngineOptions,
  type Manifest,
  type ValidateResult,
  type CompileResult,
  type EvalResult,
  type PlanHashes,
  type EngineErrorBody,
  type WslEngineOptions,
  type EngineEnvConfig,
} from "./engine.ts";
export {
  grokDraftModel,
  recordingDraftModel,
  replayDraftModel,
  draftRecordKey,
  draftResponseSchema,
  parseModelDraft,
  fromWireReply,
  ModelError,
  DRAFT_SYSTEM_PROMPT,
  type DraftModel,
  type DraftModelInput,
  type DraftModelResult,
  type DraftOutput,
  type ModelDraft,
  type GrokOptions,
} from "./grok.ts";
export {
  validateReferences,
  referenceDigestOf,
  EMPTY_REFERENCE_DIGEST,
  MAX_REFERENCE_FILES,
  MAX_REFERENCE_BYTES,
} from "./revision.ts";
// T7/T8 (Coder D)
export {
  chainViewFor,
  quoteDomain,
  QUOTE_TYPES,
  QUOTE_DOMAIN_NAME,
  QUOTE_DOMAIN_VERSION,
  EVENT_STATUS,
  type ChainView,
} from "./market.ts";
export { DEFAULT_QUOTE_CHAIN_ID, fundingTxRequests, type ApiChain, type FundingTerms, type TxRequest } from "./chain.ts";
export { createIndexer, type Indexer, type IndexerOptions } from "./indexer.ts";
export { PLAN_SCHEMA, ENGINE_CATALOG } from "./authoring.ts";
export { checkPlanFiles, FORMAT_PARSER } from "./revision.ts";
