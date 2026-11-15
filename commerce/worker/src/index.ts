// @ubc26/worker: synthetic proving and capability-gated Arc settlement.
export { runFunded, checkJobAndTerms } from "./funded.ts";
export type { ChainJob, ChainTerms, ChainSubmission, SettlementSnapshot, Preflight, SentTx, FundedState, FundedOptions, Phase } from "./funded.ts";
export { createArcSettlementPort } from "./arc-port.ts";
export type { SettlementPort, ArcSettlementSnapshot, ArcPortConfig, ArcPortClients, ArcBroadcastCapability } from "./arc-port.ts";
export type { ArcDeploymentPolicy } from "./arc-deployment.ts";
export { parseDeploymentPolicy, type DeploymentPolicyCandidate } from "./deployment-policy.ts";
export {
  authoringInput, loadSprintInput, parseSprintInput, parseSprintState, validateSprintTransition, SprintStateStore,
  type SprintInput, type LoadedSprintInput, type SprintState, type SprintPhase,
} from "./sprint-state.ts";
export { checkPolicy, PolicyError, ARC_MIN_FEE, SUBMIT_SELECTOR, RELEASE_SELECTOR } from "./policy.ts";
export {
  createLocalBroadcaster, type LocalBroadcaster, type LocalBroadcasterConfig,
  type LocalBroadcasterPublic, type LocalRawSend,
} from "./local-broadcaster.ts";
export type { PolicyConfig, OutgoingTx, WriteAuthorization } from "./policy.ts";
export {
  loadOperatorKeystore, type OperatorKeystoreConfig, type OperatorKeystoreResult, type OperatorPasswordSource,
} from "./operator-keystore.ts";
export {
  createPosterFunding, PosterFundingError, type PosterFunding, type PosterFundingConfig,
  type PosterFundingResult, type PosterFundingDisposition, type PosterFundingLink, type PosterFundingPublic,
} from "./poster-funding.ts";
export {
  recoverArcDelivery, recoverArcDeliveryDual, type ArcRecoveryRequest, type ArcRecoveryEvidence, type ArcRecoveredDelivery,
} from "./buyer-recovery.ts";
export { sprintCli, parseSprintArgs, type SprintArgs, type SprintAction } from "./sprint-cli.ts";
export { executeSprint, createSprintEngineRunner, sprintEngineWrapperDigest, type SprintDependencies } from "./sprint-runner.ts";
export { parseSprintAuthorization, assertSprintAuthorization, type SprintAuthorization } from "./sprint-authorization.ts";
export { apiClient, ApiClientError, type ApiClient, type JobView, type PackageListing } from "./client.ts";
export { decrypt, engineRunner, evaluate, prove, WorkerEngineError, type EngineRunner, type ProveOutput } from "./engine.ts";
export {
  downloadPackage,
  runSynthetic,
  syntheticJob,
  SYNTHETIC_CHAIN_ID,
  SYNTHETIC_ESCROW,
  WorkerCheckError,
  type RunOptions,
  type RunReport,
  type SyntheticJob,
} from "./run.ts";
export { filesSolver, reconciliationSolver, type Solver, type SolveInput } from "./solvers/index.ts";
