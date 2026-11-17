// PosterChain over Nick's deployed contracts, for the demo signer. Every write is preflighted where the SDK
// supports it and sent through arc.sendTx (Arc fee floor, explicit gas, waits for the receipt).
import { encodeFunctionData, getAddress, type Hex, type PublicClient, type WalletClient } from "viem";
import { arc } from "@ubc26/sdk";
import type { FundingTerms } from "./chain.ts";
import type { PosterChain } from "./demo-signer.ts";

export function arcPosterChain(pc: PublicClient, wallet: WalletClient, d: arc.Deployment = arc.ARC_TESTNET): PosterChain {
  const account = wallet.account;
  if (!account) throw new Error("arcPosterChain: the wallet has no account");
  const poster = getAddress(account.address);
  const reqs = (t: FundingTerms) =>
    arc.posterTxRequests(d, {
      provider: getAddress(t.provider),
      expiredAt: BigInt(t.expiredAt),
      description: t.description,
      budget: BigInt(t.budget),
      imageId: t.imageId,
      rulesHash: t.rulesHash,
      referenceHash: t.referenceHash,
    });
  const send = async (req: arc.TxRequest) => (await arc.sendTx(pc, wallet, req)).hash;

  return {
    poster,
    chainId: d.chainId,
    now: () => arc.latestTimestamp(pc),
    async readJob(id) {
      try {
        const j = await arc.readJob(pc, d, id);
        return { client: j.client, provider: j.provider, budget: j.budget, expiredAt: j.expiredAt, status: j.status };
      } catch (err) {
        if ((err as { code?: string }).code === "not_found") return null;
        throw err;
      }
    },
    allowance: async () => (await arc.readUsdc(pc, d, poster)).allowanceToCore,
    async createJob(t) {
      const { hash, receipt } = await arc.sendTx(pc, wallet, reqs(t).createJob);
      return { hash, chainJobId: arc.jobIdFromCreateReceipt(d, receipt) };
    },
    setBudget: async (id, amount) =>
      ({ hash: await send({ to: d.core, data: encodeFunctionData({ abi: arc.coreAbi, functionName: "setBudget", args: [id, amount, "0x"] }), value: 0n, chainId: d.chainId, label: "setBudget" }) }),
    approve: async (amount) =>
      ({ hash: await send({ to: d.usdc, data: encodeFunctionData({ abi: arc.erc20Abi, functionName: "approve", args: [d.core, amount] }), value: 0n, chainId: d.chainId, label: "approve" }) }),
    async fund(id, t) {
      const pf = await arc.preflightFund(pc, d, { jobId: id, poster, imageId: t.imageId, rulesHash: t.rulesHash, referenceHash: t.referenceHash, budget: BigInt(t.budget) });
      if (!pf.ok) throw new Error(`fund preflight failed: ${pf.revertName ?? pf.reason}`);
      return { hash: await send(reqs(t).fund(id)) };
    },
    async fundTxOf(id) {
      const evs = await arc.getSettlementEvents(pc, d, d.deployBlock);
      const e = evs.find((x) => x.name === "JobFunded" && (x.args as { jobId?: bigint }).jobId === id);
      return (e?.transactionHash as Hex | undefined) ?? null;
    },
    async refund(id) {
      const pf = await arc.preflightRefund(pc, d, { jobId: id, caller: poster });
      if (!pf.ok) throw new Error(`refund preflight failed: ${pf.revertName ?? pf.reason}`);
      return { hash: await send(arc.claimRefundTx(d, id)) };
    },
  };
}
