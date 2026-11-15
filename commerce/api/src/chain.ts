// T7/T8 chain dependency for the API. Owner: Coder D. Implements ../CONTRACT-T5-T8.md §5–6.
// SIMULATED: ABI is the @ubc26/sdk stub until Nick publishes the settlement ABI.
import { encodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  createCommerceChain,
  mockUsdcAbi,
  stubCoreAbi,
  type ChainConfig,
  type DecodedEvent,
  type FrozenTerms,
  type JobView,
} from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import type { Deps } from "./context.ts";

/**
 * The three chain reads the API needs. Two implementations: the SIMULATED stub adapter (tests on anvil) and
 * the real Arc deployment (arcReader in arc.ts). Events use the stub's DecodedEvent shape; jobs and terms use
 * JobView and FrozenTerms (getTerms returns null while the hook has not frozen terms for the job).
 */
export interface ChainReader {
  decodeLogs(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hex | null }[]): DecodedEvent[];
  getJob(jobId: bigint): Promise<JobView>;
  getTerms(jobId: bigint): Promise<FrozenTerms | null>;
}

export interface ApiChain {
  config: ChainConfig;
  publicClient: PublicClient;
  /** Real-deployment reader. Absent: the SIMULATED stub adapter over the same config. */
  reader?: ChainReader;
}

/** §5: EIP-712 domain chainId when no chain is configured. */
export const DEFAULT_QUOTE_CHAIN_ID = 5042002;

/** 503 chain_unavailable unless a chain is configured. */
export function requireChain(deps: Deps): ApiChain {
  if (!deps.chain) throw new ApiError("chain_unavailable", "No chain is configured");
  return deps.chain;
}

/** Read-only chain access (no wallet: the API never signs). */
export function readChain(chain: ApiChain): ChainReader {
  if (chain.reader) return chain.reader;
  const stub = createCommerceChain(chain.config, { public: chain.publicClient });
  return {
    decodeLogs: (logs) => stub.decodeLogs(logs as Parameters<typeof stub.decodeLogs>[0]),
    getJob: (id) => stub.getJob(id),
    getTerms: (id) => stub.getTerms(id),
  };
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

/**
 * The two Poster calls that need the on-chain jobId (read from JobCreated after createJob). Nick's core
 * (nick-settlement 80c8a4a): setBudget is client-only and takes empty optParams; fund takes only optParams =
 * abi.encode(imageId, rulesHash, referenceHash). The full order is createJob -> setBudget -> approve -> fund
 * (approve may come earlier; it must equal the budget exactly). @ubc26/sdk `arc.posterTxRequests` builds them.
 */
export interface AfterCreateStep {
  kind: "setBudget" | "fund";
  to: Address;
  signature: string;
  args: Record<string, string>;
}

export function afterCreateSteps(t: FundingTerms): { order: string[]; steps: AfterCreateStep[] } {
  const fundOptParams = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [t.imageId, t.rulesHash, t.referenceHash],
  );
  return {
    order: ["createJob", "setBudget", "approve", "fund"],
    steps: [
      { kind: "setBudget", to: t.core, signature: "setBudget(uint256 jobId,uint256 amount,bytes optParams)", args: { amount: t.budget, optParams: "0x" } },
      { kind: "fund", to: t.core, signature: "fund(uint256 jobId,bytes optParams)", args: { optParams: fundOptParams } },
    ],
  };
}

export function checksum(a: string): Address {
  return getAddress(a);
}
