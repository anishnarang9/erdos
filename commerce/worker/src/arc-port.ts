// SettlementPort on Nick's deployed contracts, through @ubc26/sdk `arc`. Every transaction passes the signer
// policy (policy.ts) before it is signed. Preflights never see the real release key.
import { getAddress, type Hex, type PublicClient, type WalletClient } from "viem";
import { arc, type ProofPackage } from "@ubc26/sdk";
import type { ChainJob, ChainTerms, Preflight, SentTx, SettlementPort } from "./funded.ts";
import { checkPolicy, type PolicyConfig } from "./policy.ts";

export interface ArcPortOptions {
  pc: PublicClient;
  /** The Solver's wallet (a local account from WORKER_PRIVATE_KEY). */
  wallet: WalletClient;
  deployment?: arc.Deployment;
  /** Gas cap for any single transaction (signer policy). Default 3,000,000. */
  maxGas?: bigint;
}

function events(d: arc.Deployment, logs: readonly unknown[]): SentTx["events"] {
  return arc.decodeSettlementLogs(logs as never, d).map((e) => ({ name: e.name, args: e.args as Record<string, unknown> }));
}

export function arcPort(o: ArcPortOptions): SettlementPort {
  const d = o.deployment ?? arc.ARC_TESTNET;
  const { pc, wallet } = o;
  const account = wallet.account;
  if (!account) throw new Error("arcPort: the wallet has no account");
  const self = getAddress(account.address);
  const policy: PolicyConfig = { chainId: d.chainId, core: d.core, hook: d.hook, maxGas: o.maxGas ?? 3_000_000n };

  const send = async (req: arc.TxRequest, gas: bigint): Promise<SentTx> => {
    checkPolicy(policy, { chainId: req.chainId, to: req.to, data: req.data, value: req.value, gas });
    const { hash, receipt } = await arc.sendTx(pc, wallet, req, gas);
    return { hash, events: events(d, receipt.logs) };
  };

  return {
    chainId: d.chainId,
    core: d.core,
    hook: d.hook,
    self,
    now: () => arc.latestTimestamp(pc),
    async job(id): Promise<ChainJob> {
      const j = await arc.readJob(pc, d, id);
      return { provider: j.provider, evaluator: j.evaluator, hook: j.hook, budget: j.budget, expiredAt: j.expiredAt, status: j.status };
    },
    async terms(id): Promise<ChainTerms> {
      const t = await arc.readTerms(pc, d, id);
      return { imageId: t.imageId, rulesHash: t.rulesHash, referenceHash: t.referenceHash, provider: t.provider, budget: t.budget, expiry: t.expiry, funded: t.frozen };
    },
    contextOf: (id) => arc.contextOf(pc, d, id),
    async submission(id) {
      const s = await arc.readSubmission(pc, d, id);
      return { envelopeHash: s.envelopeHash, keyCommitment: s.keyCommitment, accepted: s.submitted };
    },
    released: (id) => arc.readReleased(pc, d, id),
    async preflightSubmit(id, p: ProofPackage): Promise<Preflight> {
      const r = await arc.preflightSubmit(pc, d, { jobId: id, provider: self, envelope: p.envelope, seal: p.seal, keyCommitment: p.keyCommitment });
      return r.ok ? { ok: true } : { ok: false, reason: r.revertName ?? r.reason };
    },
    async preflightRelease(id): Promise<Preflight> {
      const r = await arc.preflightRelease(pc, d, { jobId: id, provider: self });
      return r.ok ? { ok: true } : { ok: false, reason: r.revertName ?? r.reason };
    },
    submit(id, p: ProofPackage) {
      const req = arc.submitTx(d, id, p.envelope, p.seal, p.keyCommitment);
      return send(req, arc.submitGasLimit(arc.calldataBytes(req)));
    },
    release(id, key: Hex) {
      return send(arc.releaseTx(d, id, key), arc.DEFAULT_RELEASE_GAS);
    },
    async receipt(hash) {
      try {
        const r = await pc.getTransactionReceipt({ hash });
        return { status: r.status, events: events(d, r.logs) };
      } catch {
        return null; // unknown or still pending
      }
    },
  };
}
