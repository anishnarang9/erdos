// Live mode: polls the API and the chain into the store, and runs the buyer's actions.
import type { Hex } from "viem";
import { arc } from "@ubc26/sdk";
import { api, ApiError, type DraftRequest, type Revision } from "./api";
import { connectWallet, deployment, fetchDelivery, publicClient } from "./chain";
import { store } from "./store";

const POLL_MS = 1500;
let timer: ReturnType<typeof setTimeout> | null = null;
let cursor = 0;
let decrypting = false;

function fail(err: unknown) {
  const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  store.set({ error: msg });
}

async function poll() {
  const s = store.get();
  if (s.mode !== "live" || !s.jobId) return;
  const id = s.jobId;
  try {
    const job = await api.job(id);
    const patch: Partial<typeof s> = { job };
    if (job.state === "compiled" || job.state === "selected") patch.quotes = (await api.quotes(id)).quotes;
    if (job.chain) {
      patch.submission = await api.submission(id);
      if (!store.get().chainExpiredAt) {
        const cj = await arc.readJob(publicClient, deployment, BigInt(job.chain.jobId)).catch(() => null);
        if (cj) patch.chainExpiredAt = cj.expiredAt.toString();
      }
    }
    const ev = await api.runEvents(id, cursor).catch(() => null);
    if (ev && ev.events.length > 0) {
      cursor = ev.cursor;
      patch.events = [...store.get().events, ...ev.events];
    }
    for (const k of ["fundOp", "refundOp"] as const) {
      const op = store.get()[k];
      if (op && op.status === "pending") patch[k] = await api.op(op.opId);
    }
    store.set(patch);
    const sub = patch.submission;
    if (sub?.key && sub.submitTx && sub.envelopeHash && sub.keyCommitment && !store.get().delivery && !decrypting) {
      decrypting = true;
      // Decrypt from public chain data only: the envelope in the submit calldata and the released key.
      fetchDelivery(BigInt(sub.chainJob.jobId), sub.submitTx as Hex, sub.key as Hex, { envelopeHash: sub.envelopeHash, keyCommitment: sub.keyCommitment })
        .then((delivery) => store.set({ delivery }))
        .catch(fail)
        .finally(() => (decrypting = false));
    }
  } catch (err) {
    fail(err);
  }
}

export function startLive(jobId: string | null) {
  stopLive();
  cursor = 0;
  store.set({ mode: "live", jobId });
  const loop = async () => {
    await poll();
    timer = setTimeout(loop, POLL_MS);
  };
  void loop();
}

export function stopLive() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export const actions = {
  async draft(req: DraftRequest) {
    store.set({ drafting: true, draftRequest: req, draft: null, error: null });
    try {
      store.set({ draft: await api.draft(req) });
    } catch (err) {
      fail(err);
    } finally {
      store.set({ drafting: false });
    }
  },

  async answerClarification(question: string, answer: string) {
    const req = store.get().draftRequest;
    if (!req) return;
    await actions.draft({ ...req, clarifications: [...(req.clarifications ?? []), { question, answer }] });
  },

  /** Creates the job from the draft and approves the exact engine rulesHash shown to the buyer. */
  async approve() {
    const { draft, draftRequest } = store.get();
    if (draft?.kind !== "draft" || !draftRequest) return;
    try {
      const rev: Revision = draft.revision;
      const created = await api.createJob(rev, draftRequest.references, draft.draftId);
      const h = created.revision.revisionHash;
      await api.approve(created.jobId, h, rev.referenceDigest, draft.engine?.rulesHash);
      history.replaceState(null, "", `#/job/${created.jobId}`);
      startLive(created.jobId);
      await api.compile(created.jobId, h);
    } catch (err) {
      fail(err);
    }
  },

  async compile() {
    const { jobId, job } = store.get();
    if (!jobId || !job) return;
    store.set({ error: null });
    try {
      await api.compile(jobId, job.revision.revisionHash);
    } catch (err) {
      fail(err);
    }
  },

  async selectQuote(quoteId: string) {
    const { jobId, job } = store.get();
    if (!jobId || !job) return;
    try {
      const r = await api.selectQuote(jobId, quoteId, job.revision.revisionHash);
      store.set({ fundingTerms: r.fundingTerms });
    } catch (err) {
      fail(err);
    }
  },

  async fund() {
    const { jobId, signer, fundingTerms } = store.get();
    if (!jobId) return;
    try {
      if (signer === "demo") {
        const op = await api.demoFund(jobId);
        store.set({ fundOp: await api.op(op.opId) });
        return;
      }
      if (!fundingTerms) throw new Error("Select a quote first");
      await fundWithWallet(jobId, fundingTerms);
    } catch (err) {
      fail(err);
    }
  },

  async refund() {
    const { jobId } = store.get();
    if (!jobId) return;
    try {
      const op = await api.demoRefund(jobId);
      store.set({ refundOp: await api.op(op.opId) });
    } catch (err) {
      fail(err);
    }
  },
};

/** MetaMask path: the buyer's own wallet sends Nick's four Poster calls, then the API links the job. */
async function fundWithWallet(jobId: string, t: import("./api").FundingTerms) {
  const wallet = await connectWallet();
  const steps: { label: string; status: string; txHash?: string; at: string }[] = [];
  const op = { opId: "wallet", kind: "fund" as const, status: "pending" as const, chainJobId: null as string | null, steps, error: null };
  const push = (label: string, txHash?: string) => {
    steps.push({ label, status: "confirmed", at: new Date().toISOString(), ...(txHash ? { txHash } : {}) });
    store.set({ fundOp: { ...op, steps: [...steps] } });
  };
  store.set({ fundOp: op });
  const reqs = arc.posterTxRequests(deployment, {
    provider: t.provider as Hex,
    expiredAt: BigInt(t.expiredAt),
    description: t.description,
    budget: BigInt(t.budget),
    imageId: t.imageId as Hex,
    rulesHash: t.rulesHash as Hex,
    referenceHash: t.referenceHash as Hex,
  });
  const created = await arc.sendTx(publicClient, wallet, reqs.createJob);
  const chainJobId = arc.jobIdFromCreateReceipt(deployment, created.receipt);
  push("createJob", created.hash);
  push("setBudget", (await arc.sendTx(publicClient, wallet, reqs.setBudget(chainJobId))).hash);
  push("approve", (await arc.sendTx(publicClient, wallet, reqs.approve)).hash);
  const funded = await arc.sendTx(publicClient, wallet, reqs.fund(chainJobId));
  push("fund", funded.hash);
  await api.fundingReceipt(jobId, funded.hash);
  push("link", funded.hash);
  store.set({ fundOp: { ...op, status: "confirmed", chainJobId: chainJobId.toString(), steps: [...steps] } });
}
