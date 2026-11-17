// T7/T8 chain dependency for the API. Owner: Coder D. Implements ../CONTRACT-T5-T8.md §5–6.
// Real Arc deployments and legacy simulated adapters have explicit, separate provenance.
import { encodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  createCommerceChain,
  createArcReader,
  arcCoreAbi,
  arcHookAbi,
  arcErc20Abi,
  mockUsdcAbi,
  stubCoreAbi,
  type ChainConfig,
  type DecodedEvent,
  type FrozenTerms,
  type JobView,
} from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import type { Deps } from "./context.ts";
import type { Engine } from "./engine.ts";

export interface ChainSnapshot {
  blockNumber: bigint;
  timestamp: bigint;
  job: JobView;
  terms: FrozenTerms | null;
  context: Uint8Array;
  submission: { envelopeHash: Hex; keyCommitment: Hex; accepted: boolean };
  released: boolean;
}

/**
 * The three chain reads the API needs. Two implementations: the SIMULATED stub adapter (tests on anvil) and
 * the real Arc deployment (SDK createArcReader). Events use the shared DecodedEvent shape; jobs and terms use
 * JobView and FrozenTerms (getTerms returns null while the hook has not frozen terms for the job).
 */
export interface ChainReader {
  decodeLogs(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hex | null }[]): DecodedEvent[];
  getJob(jobId: bigint): Promise<JobView>;
  getTerms(jobId: bigint): Promise<FrozenTerms | null>;
  /** Required in Arc mode: all reads must use the funding receipt's block. */
  getSnapshot?(jobId: bigint, blockNumber?: bigint): Promise<ChainSnapshot>;
}

export interface ApiChain {
  /** Required for every chain injection; no deployment may silently infer simulated execution. */
  readonly mode: "arc" | "simulated";
  config: ChainConfig;
  publicClient: PublicClient;
  /** Real-deployment reader. Absent: the SIMULATED stub adapter over the same config. */
  reader?: ChainReader;
}

/** Server chain wiring: never installs a simulated adapter for a configured deployment. */
export function createApiArcChain(config: ChainConfig, publicClient: PublicClient): ApiChain {
  return { mode: "arc", config, publicClient, reader: createArcReader(config, publicClient) };
}

function assertChainMode(chain: ApiChain): void {
  if (chain.mode !== "simulated" && chain.mode !== "arc") {
    throw new Error("Explicit chain.mode is required: arc or simulated");
  }
}

/** Validate deployment provenance without performing IO. Display labels are never consulted. */
export function assertChainEngine(chain: ApiChain | undefined, engine: Engine): void {
  if (!chain) return;
  assertChainMode(chain);
  if (chain.mode === "arc") {
    if (engine.mode !== "real") throw new Error("Arc chain requires an explicitly real engine; simulated or unidentified engines are unsafe");
    if (!chain.reader?.getSnapshot) throw new Error("Arc chain requires a real reader with getSnapshot");
  }
}

/** §5: EIP-712 domain chainId when no chain is configured. */
export const DEFAULT_QUOTE_CHAIN_ID = 5042002;

/** 503 chain_unavailable unless a chain is configured. */
export function requireChain(deps: Deps): ApiChain {
  if (!deps.chain) throw new ApiError("chain_unavailable", "No chain is configured");
  assertChainEngine(deps.chain, deps.engine);
  return deps.chain;
}

/** Read-only chain access (no wallet: the API never signs). */
export function readChain(chain: ApiChain): ChainReader {
  assertChainMode(chain);
  if (chain.mode === "arc" && !chain.reader?.getSnapshot) {
    throw new Error("Arc chain requires a real reader with getSnapshot; stub fallback is forbidden");
  }
  if (chain.reader) return chain.reader;
  const stub = createCommerceChain(chain.config, { public: chain.publicClient });
  return {
    decodeLogs: (logs) => stub.decodeLogs(logs as Parameters<typeof stub.decodeLogs>[0]),
    getJob: (id) => stub.getJob(id),
    getTerms: (id) => stub.getTerms(id),
  };
}

/** Conservative measured deadline budget: proof + submit + release + funding overhead. */
export const ARC_MIN_DEADLINE_SECONDS = 1200n;
export const ARC_FUNDING_OVERHEAD_SECONDS = 120n;

/** Read deployment timing at one block. RPC failure never falls back to the host clock. */
export async function arcSelectionTiming(chain: ApiChain): Promise<{ timestamp: bigint; minimumExpirySeconds: bigint }> {
  try {
    if (await chain.publicClient.getChainId() !== chain.config.chainId) throw new Error("wrong chain");
    const blockNumber = await chain.publicClient.getBlockNumber({ cacheTime: 0 });
    const [block, margin] = await Promise.all([
      chain.publicClient.getBlock({ blockNumber }),
      chain.publicClient.readContract({ address: chain.config.hook, abi: arcHookAbi, functionName: "MIN_EXPIRY_MARGIN", blockNumber }),
    ]);
    if (block.number !== blockNumber || typeof block.timestamp !== "bigint" || block.timestamp < 0n || typeof margin !== "bigint" || margin < 0n) throw new Error("invalid chain timing");
    const deployedMinimum = margin + ARC_FUNDING_OVERHEAD_SECONDS;
    return { timestamp: block.timestamp, minimumExpirySeconds: deployedMinimum > ARC_MIN_DEADLINE_SECONDS ? deployedMinimum : ARC_MIN_DEADLINE_SECONDS };
  } catch {
    throw new ApiError("chain_unavailable", "Cannot verify Arc chain time and deployed MIN_EXPIRY_MARGIN");
  }
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
  /** Set for a wallet caller. Legacy local sessions omit it. */
  buyer?: Address;
}

export interface TxRequest {
  kind: "approve" | "createJob";
  to: Address;
  data: Hex;
  value: "0";
}

/** The two prebuilt transactions of §5. setBudget and fund need the on-chain jobId, so they are not prebuilt. */
export function fundingTxRequests(t: FundingTerms, mode: ApiChain["mode"] = "simulated"): TxRequest[] {
  // Both deployments take the same createJob arguments, but use their own exported ABI.
  const approve = encodeFunctionData({
    abi: mode === "arc" ? arcErc20Abi : mockUsdcAbi,
    functionName: "approve",
    args: [t.core, BigInt(t.budget)],
  });
  const createJob = encodeFunctionData({
    abi: mode === "arc" ? arcCoreAbi : stubCoreAbi,
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
 * (approve may come earlier; it must equal the budget exactly). These are instructions, not signed transactions.
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
