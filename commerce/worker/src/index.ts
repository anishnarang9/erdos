// @ubc26/worker: synthetic proving and capability-gated Arc settlement.
export { runFunded, checkJobAndTerms } from "./funded.ts";
export type { ChainJob, ChainTerms, ChainSubmission, SettlementSnapshot, Preflight, SentTx, FundedState, FundedOptions, Phase } from "./funded.ts";
export { createArcSettlementPort } from "./arc-port.ts";
export type { SettlementPort, ArcSettlementSnapshot, ArcPortConfig, ArcPortClients, ArcBroadcastCapability } from "./arc-port.ts";
export type { ArcDeploymentPolicy } from "./arc-deployment.ts";
export { parseDeploymentPolicy, type DeploymentPolicyCandidate } from "./deployment-policy.ts";
export { checkPolicy, PolicyError, ARC_MIN_FEE, SUBMIT_SELECTOR, RELEASE_SELECTOR } from "./policy.ts";
export type { PolicyConfig, OutgoingTx, WriteAuthorization } from "./policy.ts";
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
