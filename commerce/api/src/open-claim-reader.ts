import { decodeEventLog, isAddressEqual, zeroAddress, zeroHash, type Hex, type PublicClient } from "viem";
import { arcCoreAbi, createViemOpenClaimPort, openClaimSignatureAbi } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import type { OpenClaimConfig, OpenClaimReader, OpenClaimReceipt, OpenClaimSnapshot } from "./open-claim.ts";

const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;

/** Turn confirmed viem reads into the API's open-claim receipt and snapshot boundary. */
export function createViemOpenClaimReader(
  client: PublicClient,
  config: Omit<OpenClaimConfig, "reader">,
  confirmations = 3n,
): OpenClaimReader {
  if (config.mode !== "arc" || confirmations < 0n) throw new Error("invalid Arc open-claim reader configuration");
  const deployment = { mode: "open-claim" as const, chainId: config.chainId,
    core: config.core, adapter: config.adapter, verifier: config.verifier, usdc: config.usdc };
  const port = createViemOpenClaimPort(client, { confirmations });

  async function confirmedBlock(): Promise<bigint> {
    const chainId = await client.getChainId();
    if (chainId !== config.chainId) throw new ApiError("chain_unavailable", "Open-claim chain ID differs from configuration");
    const head = await client.getBlockNumber();
    if (head < confirmations) throw new ApiError("chain_unconfirmed", "Open-claim confirmation margin is not reached");
    return head - confirmations;
  }

  return {
    async clock() {
      const blockNumber = await confirmedBlock();
      const block = await client.getBlock({ blockNumber });
      return { chainId: config.chainId, timestamp: block.timestamp, blockNumber };
    },

    async receipt(hash: string): Promise<OpenClaimReceipt | null> {
      const blockNumber = await confirmedBlock();
      let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
      try {
        receipt = await client.getTransactionReceipt({ hash: hash as Hex });
      } catch {
        return null;
      }
      if (receipt.blockNumber > blockNumber) return null;
      const events: OpenClaimReceipt["events"] = [];
      for (const log of receipt.logs) {
        let abi;
        if (isAddressEqual(log.address, config.core)) abi = arcCoreAbi;
        else if (isAddressEqual(log.address, config.adapter)) abi = openClaimSignatureAbi;
        else continue;
        try {
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
          if (decoded.eventName !== "JobFunded" && decoded.eventName !== "TermsRegistered") continue;
          const args = decoded.args as { jobId?: bigint };
          if (typeof args.jobId === "bigint") events.push({ address: log.address, name: decoded.eventName, jobId: args.jobId });
        } catch { /* Other core and adapter events do not count as funding evidence. */ }
      }
      return { hash: receipt.transactionHash, status: receipt.status, to: receipt.to ?? zeroAddress,
        blockNumber: receipt.blockNumber, events };
    },

    async current(chainJobId: bigint): Promise<OpenClaimSnapshot> {
      const snapshot = await port.snapshot(deployment, chainJobId);
      if (snapshot.blockNumber === undefined || snapshot.job === null) {
        throw new ApiError("chain_unconfirmed", "Open-claim core job is absent at the confirmed block");
      }
      const block = await client.getBlock({ blockNumber: snapshot.blockNumber });
      const status = STATUS[snapshot.job.status];
      if (!status) throw new ApiError("chain_unavailable", "Unknown open-claim core job status");
      const terms = snapshot.terms;
      const submission = snapshot.submission;
      return {
        chainId: config.chainId, blockNumber: snapshot.blockNumber, timestamp: block.timestamp,
        core: snapshot.wiring.core, adapter: config.adapter, usdc: snapshot.wiring.usdc, verifier: snapshot.wiring.verifier,
        job: { status, buyer: snapshot.job.client, provider: snapshot.job.provider, evaluator: snapshot.job.evaluator,
          hook: snapshot.job.hook, token: snapshot.token, budget: snapshot.job.budget,
          expiry: snapshot.job.expiredAt, platformFee: snapshot.platformFeeBP, evaluatorFee: snapshot.evaluatorFeeBP },
        terms: terms ?? { registered: false, buyer: zeroAddress, imageId: zeroHash, rulesHash: zeroHash,
          referenceHash: zeroHash, budget: 0n, expiry: 0n },
        submission: submission ?? { accepted: false, solver: zeroAddress, envelopeHash: zeroHash,
          keyCommitment: zeroHash },
        released: snapshot.released,
      };
    },
  };
}
