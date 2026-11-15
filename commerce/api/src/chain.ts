// T7/T8 chain dependency for the API. Owner: Coder D. Implements ../CONTRACT-T5-T8.md §5–6.
// SIMULATED: ABI is the @ubc26/sdk stub until Nick publishes the settlement ABI.
import { encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { createCommerceChain, mockUsdcAbi, stubCoreAbi, type ChainConfig, type CommerceChain } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import type { Deps } from "./context.ts";

export interface ApiChain {
  config: ChainConfig;
  publicClient: PublicClient;
}

/** §5: EIP-712 domain chainId when no chain is configured. */
export const DEFAULT_QUOTE_CHAIN_ID = 5042002;

/** 503 chain_unavailable unless a chain is configured. */
export function requireChain(deps: Deps): ApiChain {
  if (!deps.chain) throw new ApiError("chain_unavailable", "No chain is configured");
  return deps.chain;
}

/** Read-only SDK adapter over the configured public client (no wallet: the API never signs). */
export function readChain(chain: ApiChain): CommerceChain {
  return createCommerceChain(chain.config, { public: chain.publicClient });
}

/** fundingTerms (§5). budget and expiredAt are decimal strings; addresses are EIP-55. */
export interface FundingTerms {
  chainId: number;
  core: Address;
  hook: Address;
  usdc: Address;
  provider: Address;
  budget: string;
  expiredAt: string;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  description: string;
}

export interface TxRequest {
  kind: "approve" | "createJob";
  to: Address;
  data: Hex;
  value: "0";
}

/** The two prebuilt transactions of §5. setBudget and fund need the on-chain jobId, so they are not prebuilt. */
export function fundingTxRequests(t: FundingTerms): TxRequest[] {
  // SIMULATED: stub ABI (createJob(provider, evaluator, expiredAt, description, hook) with evaluator = hook).
  const approve = encodeFunctionData({
    abi: mockUsdcAbi,
    functionName: "approve",
    args: [t.core, BigInt(t.budget)],
  });
  const createJob = encodeFunctionData({
    abi: stubCoreAbi,
    functionName: "createJob",
    args: [t.provider, t.hook, BigInt(t.expiredAt), t.description, t.hook],
  });
  return [
    { kind: "approve", to: t.usdc, data: approve, value: "0" },
    { kind: "createJob", to: t.core, data: createJob, value: "0" },
  ];
}

export function checksum(a: string): Address {
  return getAddress(a);
}
