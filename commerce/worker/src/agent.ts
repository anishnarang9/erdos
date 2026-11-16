// The solver agent loop (COMMERCE-IMPLEMENTATION §5.1): quote open jobs it can solve, then prove, submit and
// release the jobs funded to it. Each tick: GET /v1/jobs -> quote new ones; GET /v1/assignments -> runFunded.
// Quoted job ids and finished attempts are persisted in <dataDir>/agent.json, so a restart neither re-quotes
// nor re-runs a settled job (runFunded itself resumes from <attemptDir>/state.json).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex, LocalAccount } from "viem";
import { providerAuthMessage, QUOTE_TYPES, quoteDomain } from "@ubc26/api";
import type { ApiClient } from "./client.ts";
import type { EngineRunner } from "./engine.ts";
import { runFunded, type FundedState, type SettlementPort } from "./funded.ts";
import type { Solver } from "./solvers/index.ts";

export interface FeedJob {
  jobId: string;
  revisionHash: string;
  outputs: { name: string; format: string }[];
  expirySeconds: number;
  maxBudget: string;
}

export interface Assignment {
  jobId: string;
  chainJob: { chainId: number; core: string; jobId: string };
}

export interface AgentOptions {
  apiUrl: string;
  client: ApiClient;
  account: LocalAccount;
  port: SettlementPort;
  runner: EngineRunner;
  chainId: number;
  /** Picks a solver for a job from its outputs and reference names, or null to not quote it. */
  solverFor(job: FeedJob, referenceNames: string[]): Solver | null;
  /** Price in USDC units (6 decimals) for a job, or null to not quote it. */
  priceFor(job: FeedJob): bigint | null;
  dataDir: string;
  proveBudgetSec: number;
  quoteValiditySec?: number;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
}

interface AgentFile {
  quoted: Record<string, { quoteId: string; at: string }>;
  done: Record<string, { phase: FundedState["phase"]; at: string }>;
}

export function createAgent(o: AgentOptions) {
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? ((m: string) => console.error(`[agent] ${m}`));
  const base = o.apiUrl.replace(/\/+$/, "");
  mkdirSync(o.dataDir, { recursive: true });
  const file = join(o.dataDir, "agent.json");
  const st: AgentFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as AgentFile) : { quoted: {}, done: {} };
  const save = () => {
    writeFileSync(file + ".tmp", JSON.stringify(st, null, 2));
    renameSync(file + ".tmp", file);
  };
  const solvers = new Map<string, Solver>();

  /** EIP-191 provider-authenticated request (the API's providerAuth). */
  const providerFetch = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(12).toString("hex");
    const message = providerAuthMessage({ method, pathWithQuery: path, bodySha256Hex: "0x" + createHash("sha256").update(raw).digest("hex"), timestamp, nonce });
    const headers: Record<string, string> = {
      "x-ubc26-address": o.account.address,
      "x-ubc26-timestamp": String(timestamp),
      "x-ubc26-nonce": nonce,
      "x-ubc26-signature": await o.account.signMessage({ message }),
    };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = `agent-${nonce}`;
    }
    const res = await doFetch(base + path, { method, headers, ...(method === "POST" ? { body: raw } : {}) });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };

  const quoteNew = async (): Promise<number> => {
    const feed = (await (await doFetch(`${base}/v1/jobs`)).json()) as { jobs: FeedJob[] };
    let n = 0;
    for (const job of feed.jobs) {
      if (st.quoted[job.jobId]) continue;
      const refs = await o.client.references(job.jobId);
      const solver = o.solverFor(job, refs.files.map((f) => f.name));
      const price = o.priceFor(job);
      if (!solver || price === null || price > BigInt(job.maxBudget)) continue;
      const validUntil = Math.floor(Date.now() / 1000) + (o.quoteValiditySec ?? 1800);
      const nonce = BigInt("0x" + randomBytes(8).toString("hex"));
      const signature = await o.account.signTypedData({
        domain: quoteDomain(o.chainId),
        types: QUOTE_TYPES,
        primaryType: "Quote",
        message: { revisionHash: job.revisionHash as Hex, provider: o.account.address, price, validUntil: BigInt(validUntil), nonce },
      });
      const quote = { revisionHash: job.revisionHash, provider: o.account.address, price: price.toString(), validUntil, nonce: nonce.toString() };
      const r = await providerFetch("POST", `/v1/jobs/${job.jobId}/quotes`, { quote, signature });
      st.quoted[job.jobId] = { quoteId: String(r.quoteId), at: new Date().toISOString() };
      solvers.set(job.jobId, solver);
      save();
      log(`quoted ${job.jobId} at ${price} units with ${solver.name}`);
      n++;
    }
    return n;
  };

  const runAssigned = async (): Promise<FundedState[]> => {
    const r = (await providerFetch("GET", "/v1/assignments")) as { assignments: Assignment[] };
    const out: FundedState[] = [];
    for (const a of r.assignments) {
      const key = `${a.jobId}:${a.chainJob.jobId}`;
      if (st.done[key]) continue;
      let solver = solvers.get(a.jobId);
      if (!solver) {
        // After a restart: pick the solver again from the job.
        const view = await o.client.job(a.jobId);
        const refs = await o.client.references(a.jobId);
        solver = o.solverFor({ jobId: a.jobId, revisionHash: view.revision.revisionHash, outputs: view.revision.revision.outputs, expirySeconds: 0, maxBudget: "0" }, refs.files.map((f) => f.name)) ?? undefined;
        if (!solver) continue;
      }
      log(`assigned ${a.jobId} (chain job ${a.chainJob.jobId}): proving`);
      const state = await runFunded({
        client: o.client,
        runner: o.runner,
        port: o.port,
        jobId: a.jobId,
        chainJobId: BigInt(a.chainJob.jobId),
        solver,
        attemptDir: join(o.dataDir, `attempt-${a.jobId}-${a.chainJob.jobId}`),
        proveBudgetSec: o.proveBudgetSec,
      });
      log(`job ${a.jobId}: ${state.phase}${state.verdict !== undefined ? ` (verdict ${state.verdict})` : ""}`);
      if (state.phase === "released" || state.phase === "rejected" || state.phase === "abandoned") {
        st.done[key] = { phase: state.phase, at: new Date().toISOString() };
        save();
      }
      out.push(state);
    }
    return out;
  };

  return {
    /** One pass: quote new jobs, then work assigned ones. Errors are logged per step and do not stop the loop. */
    async tick(): Promise<{ quoted: number; ran: FundedState[] }> {
      let quoted = 0;
      let ran: FundedState[] = [];
      try {
        quoted = await quoteNew();
      } catch (err) {
        log(`quote step failed: ${(err as Error).message}`);
      }
      try {
        ran = await runAssigned();
      } catch (err) {
        log(`assignment step failed: ${(err as Error).message}`);
      }
      return { quoted, ran };
    },
  };
}
