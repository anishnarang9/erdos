// @ubc26/worker: the solver agent. Today it proves on a synthetic funded context; chain submit and
// release (T10) follow once the settlement contracts are deployed.
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
