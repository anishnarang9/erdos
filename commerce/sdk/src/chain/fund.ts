// §5a of commerce/api/CONTRACT-T5-T8.md: fund a selected job from the API's fundingTerms. Owner: Coder D.
// SIMULATED: the four calls follow the stub core (approve -> createJob -> setBudget -> fund).
import { getAddress, isAddressEqual } from "viem";
import type { Address, Hex } from "viem";
import type { CommerceChain } from "./chain.ts";
import { ChainError } from "./errors.ts";

/** The `fundingTerms` object returned by `POST /v1/jobs/:id/select-quote`. */
export interface FundingTerms {
  chainId: number;
  core: Address;
  hook: Address;
  usdc: Address;
  provider: Address;
  /** Decimal string (as served by the API) or bigint. */
  budget: string | bigint;
  /** Unix seconds, decimal string or bigint. */
  expiredAt: string | bigint;
  imageId: Hex;
  rulesHash: Hex;
  referenceHash: Hex;
  description: string;
}

export interface FundJobResult {
  jobId: bigint;
  /** The `fund` transaction hash; POST it to /v1/jobs/:id/funding-receipt. */
  fundTx: Hex;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function toUint(v: string | bigint, field: string): bigint {
  if (typeof v === "bigint") {
    if (v < 0n) throw new RangeError(`fundingTerms.${field} must be non-negative`);
    return v;
  }
  if (typeof v !== "string" || !DECIMAL.test(v)) throw new RangeError(`fundingTerms.${field} must be a decimal string`);
  return BigInt(v);
}

/**
 * Runs approve -> createJob -> setBudget -> fund with the buyer wallet bound to `chain`.
 * Every step goes through a CommerceChain write, which waits for the receipt and throws
 * ChainError("reverted") on a reverted receipt (allowRevert is never passed). The chain's
 * config must be the one the terms were issued for, otherwise ChainError("wrong_chain")
 * is thrown before anything is sent.
 */
export async function fundJob(chain: CommerceChain, terms: FundingTerms): Promise<FundJobResult> {
  const cfg = chain.config;
  const mismatch: string[] = [];
  if (terms.chainId !== cfg.chainId) mismatch.push("chainId");
  if (!isAddressEqual(terms.core, cfg.core)) mismatch.push("core");
  if (!isAddressEqual(terms.hook, cfg.hook)) mismatch.push("hook");
  if (!isAddressEqual(terms.usdc, cfg.usdc)) mismatch.push("usdc");
  if (mismatch.length > 0) {
    throw new ChainError("wrong_chain", `fundingTerms do not match the chain config: ${mismatch.join(", ")}`);
  }
  const budget = toUint(terms.budget, "budget");
  const expiredAt = toUint(terms.expiredAt, "expiredAt");
  if (budget === 0n) throw new RangeError("fundingTerms.budget must be positive");

  await chain.approveUsdc(budget);
  const { jobId } = await chain.createJob({
    provider: getAddress(terms.provider),
    expiredAt,
    description: terms.description,
  });
  await chain.setBudget(jobId, budget);
  const fundTx = await chain.fund({
    jobId,
    expectedBudget: budget,
    imageId: terms.imageId,
    rulesHash: terms.rulesHash,
    referenceHash: terms.referenceHash,
  });
  return { jobId, fundTx };
}
