// Arc settlement client for Nick's deployed contracts. Exported from @ubc26/sdk as `arc`.
// See README.md in this folder for use and INTERFACE.md for the contract.
export { coreAbi, erc20Abi, errorsAbi, hookAbi, verifierAbi } from "./abi.ts";
export { ARC_TESTNET, ARC_TESTNET_CHAIN_ID, deploymentFrom, MAX_LOG_WINDOW, MIN_MAX_FEE_PER_GAS } from "./deployment.ts";
export type { Deployment } from "./deployment.ts";
export { ArcError, decodeRevert, revertDataOf } from "./errors.ts";
export type { ArcErrorCode, DecodedRevert } from "./errors.ts";
export {
  checkChain,
  JOB_STATUS,
  latestTimestamp,
  contextOf,
  readExpectedJournal,
  readHookConfig,
  readHookWhitelisted,
  readJob,
  readJobCount,
  readReleased,
  readSubmission,
  readTerms,
  readUsdc,
  verifyDeployment,
} from "./reads.ts";
export type { HookConfig, Job, JobStatusName, Submission, Terms } from "./reads.ts";
export { contextForJob, fundOptParams, releaseKeyMatches, submitOptParams } from "./encode.ts";
export {
  calldataBytes,
  claimRefundTx,
  fundTx,
  posterTxRequests,
  releaseTx,
  SUBMIT_EXECUTION_ALLOWANCE,
  submitGasLimit,
  submitTx,
} from "./tx.ts";
export type { PosterArgs, PosterTxRequests, TxLabel, TxRequest } from "./tx.ts";
export {
  DUMMY_RELEASE_KEY,
  preflightFund,
  preflightRefund,
  preflightRelease,
  preflightSubmit,
  RELEASE_EXPIRY_MARGIN_SECONDS,
} from "./preflight.ts";
export type { PreflightFundArgs, PreflightRefundArgs, PreflightReleaseArgs, PreflightResult, PreflightSubmitArgs } from "./preflight.ts";
export {
  blockWindows,
  CORE_EVENT_FIELDS,
  decodeSettlementLog,
  decodeSettlementLogs,
  getSettlementEvents,
  HOOK_EVENT_FIELDS,
  jobIdFromCreateReceipt,
} from "./events.ts";
export type { DecodedEvent, EventArgs, EventMeta, RawLog, SettlementEventName } from "./events.ts";
export { arcFees, DEFAULT_RECEIPT_TIMEOUT_MS, DEFAULT_RELEASE_GAS, sendTx } from "./send.ts";
export type { SendOptions } from "./send.ts";
