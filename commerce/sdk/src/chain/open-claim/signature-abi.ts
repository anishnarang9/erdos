import type { Abi } from "viem";
import exportedAdapterAbi from "../arc/abi/OpenClaimAdapter.json" with { type: "json" };

/** Exported from the compiled OpenClaimAdapter at source checkpoint 4c41a55. */
export const OPEN_CLAIM_INTERFACE_REVISION = "4c41a55";
export const OPEN_CLAIM_ABI_STATUS = "exported-json" as const;
export const OPEN_CLAIM_MAX_ENVELOPE_BYTES = 16_412;
export const OPEN_CLAIM_MIN_EXPIRY_MARGIN_SEC = 600;
/** 1 USDC in Arc native USDC's six-decimal base units. */
export const OPEN_CLAIM_ONE_USDC = 1_000_000n;

/** The old export name remains for source compatibility. Calls use the compiled JSON ABI. */
export const openClaimSignatureAbi = exportedAdapterAbi as unknown as Abi;
