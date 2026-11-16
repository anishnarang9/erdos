// The API's chain reads on Nick's deployed contracts (Arc testnet), through @ubc26/sdk `arc`.
import { createPublicClient, getAddress, http, isAddressEqual, type PublicClient } from "viem";
import { arc, JobStatus, type DecodedEvent, type FrozenTerms, type JobView } from "@ubc26/sdk";
import type { ApiChain, ChainReader } from "./chain.ts";

/** ChainReader over the real core and SettlementHook. Events use the API's stored shape (contract core|hook). */
export function arcReader(pc: PublicClient, d: arc.Deployment): ChainReader {
  return {
    decodeLogs(logs) {
      const out: DecodedEvent[] = [];
      for (const log of logs) {
        const e = arc.decodeSettlementLog(log as never, d);
        // Only mined logs are stored: a pending log has no block, index or transaction yet.
        if (!e || e.blockNumber === null || e.logIndex === null || e.transactionHash === null) continue;
        out.push({
          name: e.name,
          contract: isAddressEqual(e.address, d.core) ? "core" : "hook",
          args: e.args as Record<string, unknown>,
          blockNumber: e.blockNumber,
          logIndex: e.logIndex,
          transactionHash: e.transactionHash,
        });
      }
      return out;
    },
    async getJob(id): Promise<JobView> {
      const j = await arc.readJob(pc, d, id);
      return {
        client: j.client,
        provider: j.provider,
        evaluator: j.evaluator,
        hook: j.hook,
        budget: j.budget,
        expiredAt: j.expiredAt,
        status: JobStatus[j.status as keyof typeof JobStatus],
        description: j.description,
      };
    },
    async getTerms(id): Promise<FrozenTerms | null> {
      const t = await arc.readTerms(pc, d, id);
      if (!t.frozen) return null;
      return {
        imageId: t.imageId,
        rulesHash: t.rulesHash,
        referenceHash: t.referenceHash,
        provider: t.provider,
        budget: t.budget,
        expiredAt: t.expiry,
      };
    },
  };
}

/** ApiChain for a deployment: config, a public client on its RPC (or CHAIN_RPC_URL), and the Arc reader. */
export function arcChain(d: arc.Deployment = arc.ARC_TESTNET, rpcUrl: string = d.rpcUrl): ApiChain {
  const publicClient = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
  return {
    config: { chainId: d.chainId, core: getAddress(d.core), hook: getAddress(d.hook), usdc: getAddress(d.usdc) },
    publicClient,
    reader: arcReader(publicClient, d),
  };
}
