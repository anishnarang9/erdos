// Demo signer (presenter mode only): the API sends the Poster's four funding calls and the job-scoped refund
// with the testnet Poster key, so a recorded demo has no wallet popups. Off unless the server is started with
// DEMO_SIGNER=1 and POSTER_PRIVATE_KEY. It can never sign anything but these calls for a job the buyer selected,
// within a per-job and per-session budget, from a local origin. The browser toggle grants nothing.
import type { Handler, MiddlewareHandler } from "hono";
import type { Address, Hex } from "viem";
import { ApiError } from "./errors.ts";
import { isoAt, readBody, type AppEnv } from "./context.ts";
import type { RouteContext } from "./routes.ts";
import type { FundingTerms } from "./chain.ts";

/** What the demo signer needs from the chain, as the Poster. Implemented over @ubc26/sdk arc in demo-arc.ts. */
export interface PosterChain {
  poster: Address;
  chainId: number;
  now(): Promise<bigint>;
  /** null when the job does not exist on chain. */
  readJob(id: bigint): Promise<{ client: Address; provider: Address; budget: bigint; expiredAt: bigint; status: string } | null>;
  allowance(): Promise<bigint>;
  createJob(t: FundingTerms): Promise<{ hash: Hex; chainJobId: bigint }>;
  setBudget(id: bigint, amount: bigint): Promise<{ hash: Hex }>;
  approve(amount: bigint): Promise<{ hash: Hex }>;
  /** Preflights, then sends fund(jobId, abi.encode(imageId, rulesHash, referenceHash)). */
  fund(id: bigint, t: FundingTerms): Promise<{ hash: Hex }>;
  /** The JobFunded transaction of a job (after a crash between fund and recording it). */
  fundTxOf(id: bigint): Promise<Hex | null>;
  /** Preflights, then sends claimRefund(jobId). */
  refund(id: bigint): Promise<{ hash: Hex }>;
}

export interface DemoSignerOptions {
  chain: PosterChain;
  /** Largest budget the signer will fund for one job (USDC units). */
  maxBudgetPerJob: bigint;
  /** Total the signer may fund in this server process (USDC units). */
  sessionBudget: bigint;
}

export interface Step {
  label: "createJob" | "setBudget" | "approve" | "fund" | "link" | "refund";
  status: "pending" | "confirmed" | "skipped";
  txHash?: Hex;
  at: string;
}

interface OpRow {
  id: string;
  job_id: string;
  kind: "fund" | "refund";
  status: "pending" | "confirmed" | "failed";
  chain_job_id: string | null;
  budget: string | null;
  steps_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function view(r: OpRow) {
  return {
    opId: r.id,
    jobId: r.job_id,
    kind: r.kind,
    status: r.status,
    chainJobId: r.chain_job_id,
    budget: r.budget,
    steps: JSON.parse(r.steps_json) as Step[],
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function registerDemoSignerRoutes(ctx: RouteContext): void {
  const { app, buyer, deps, newId } = ctx;
  const signer = deps.demoSigner;
  const db = deps.db;
  const q = {
    insert: db.prepare(
      "INSERT INTO demo_ops (id, job_id, kind, status, chain_job_id, budget, steps_json, error, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, '[]', NULL, ?, ?)",
    ),
    get: db.prepare("SELECT * FROM demo_ops WHERE id = ?"),
    latest: db.prepare("SELECT * FROM demo_ops WHERE job_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1"),
    save: db.prepare("UPDATE demo_ops SET status = ?, chain_job_id = ?, steps_json = ?, error = ?, updated_at = ? WHERE id = ?"),
    spent: db.prepare("SELECT budget FROM demo_ops WHERE kind = 'fund' AND status = 'confirmed'"),
    job: db.prepare("SELECT id, state FROM jobs WHERE id = ?"),
    selection: db.prepare("SELECT funding_terms_json FROM selections WHERE job_id = ?"),
    link: db.prepare("SELECT chain_job_id FROM chain_links WHERE job_id = ?"),
  };
  const running = new Set<string>();
  const startedAt = new Date(deps.now()).toISOString();
  const sessionSpent = (): bigint =>
    (q.spent.all() as { budget: string | null }[]).reduce((a, r) => a + BigInt(r.budget ?? "0"), 0n);

  const requireSigner = (): DemoSignerOptions => {
    if (!signer) throw new ApiError("not_found", "The demo signer is disabled (start the API with DEMO_SIGNER=1)");
    return signer;
  };
  const localOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) throw new ApiError("forbidden", "The demo signer accepts only local origins");
    await next();
  };
  const jobParam = (raw: string | undefined): string => {
    const id = raw ?? "";
    if (!ULID_RE.test(id)) throw new ApiError("not_found", "Job not found");
    return id;
  };

  const persist = (op: OpRow, steps: Step[], patch: Partial<Pick<OpRow, "status" | "chain_job_id" | "error">> = {}) => {
    Object.assign(op, patch);
    op.steps_json = JSON.stringify(steps);
    op.updated_at = isoAt(deps.now());
    q.save.run(op.status, op.chain_job_id, op.steps_json, op.error, op.updated_at, op.id);
  };

  /** Funding, resumable: every step first reads chain state, so a retry never creates a second escrow. */
  const runFund = async (op: OpRow, terms: FundingTerms) => {
    const { chain } = requireSigner();
    const steps: Step[] = JSON.parse(op.steps_json) as Step[];
    const mark = (label: Step["label"], status: Step["status"], txHash?: Hex) => {
      const s: Step = { label, status, at: isoAt(deps.now()), ...(txHash ? { txHash } : {}) };
      const i = steps.findIndex((x) => x.label === label);
      if (i >= 0) steps[i] = s;
      else steps.push(s);
      persist(op, steps);
    };
    const budget = BigInt(terms.budget);
    let id = op.chain_job_id ? BigInt(op.chain_job_id) : null;
    if (id === null) {
      mark("createJob", "pending");
      const c = await chain.createJob(terms);
      id = c.chainJobId;
      persist(op, steps, { chain_job_id: id.toString() });
      mark("createJob", "confirmed", c.hash);
    }
    const job = await chain.readJob(id);
    if (!job || job.client.toLowerCase() !== chain.poster.toLowerCase()) throw new Error(`chain job ${id} is not the Poster's`);
    if (job.status === "Open") {
      if (job.budget !== budget) {
        mark("setBudget", "pending");
        mark("setBudget", "confirmed", (await chain.setBudget(id, budget)).hash);
      } else if (!steps.some((s) => s.label === "setBudget")) mark("setBudget", "skipped");
      if ((await chain.allowance()) < budget) {
        mark("approve", "pending");
        mark("approve", "confirmed", (await chain.approve(budget)).hash);
      } else if (!steps.some((s) => s.label === "approve")) mark("approve", "skipped");
      mark("fund", "pending");
      mark("fund", "confirmed", (await chain.fund(id, terms)).hash);
    } else if (job.status !== "Funded") {
      throw new Error(`chain job ${id} is ${job.status}, not fundable`);
    }
    const fundTx = steps.find((s) => s.label === "fund")?.txHash ?? (await chain.fundTxOf(id));
    if (!fundTx) throw new Error(`no funding transaction found for chain job ${id}`);
    // Link exactly as the buyer would: the same funding-receipt checks against the manifest and the quote.
    mark("link", "pending");
    const res = await app.request(`/v1/jobs/${op.job_id}/funding-receipt`, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.buyerToken}`, "content-type": "application/json", "idempotency-key": `demo-link-${op.id}-${fundTx}` },
      body: JSON.stringify({ txHash: fundTx }),
    });
    if (res.status !== 200) throw new Error(`funding-receipt returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    mark("link", "confirmed", fundTx);
    persist(op, steps, { status: "confirmed" });
  };

  const runRefund = async (op: OpRow) => {
    const { chain } = requireSigner();
    const steps: Step[] = [{ label: "refund", status: "pending", at: isoAt(deps.now()) }];
    persist(op, steps);
    const { hash } = await chain.refund(BigInt(op.chain_job_id!));
    steps[0] = { label: "refund", status: "confirmed", txHash: hash, at: isoAt(deps.now()) };
    persist(op, steps, { status: "confirmed" });
  };

  const launch = (op: OpRow, work: () => Promise<void>) => {
    running.add(op.job_id);
    void work()
      .catch((err: unknown) => {
        const steps = JSON.parse(op.steps_json) as Step[];
        persist(op, steps, { status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : "failed" });
      })
      .finally(() => running.delete(op.job_id));
  };

  /** GET /v1/demo/capabilities: whether the demo signer is on, as whom, and its limits. No secrets. */
  const capabilities: Handler<AppEnv> = (c) => {
    if (!signer) return c.json({ enabled: false });
    return c.json({
      enabled: true,
      chainId: signer.chain.chainId,
      poster: signer.chain.poster,
      actions: ["fund", "refund"],
      maxBudgetPerJob: signer.maxBudgetPerJob.toString(),
      sessionBudget: signer.sessionBudget.toString(),
      sessionSpent: sessionSpent().toString(),
      since: startedAt,
    });
  };

  /** POST /v1/demo/jobs/:id/fund: fund the buyer's selected quote (202 with an operation to poll). */
  const fund: Handler<AppEnv> = (c) => {
    const s = requireSigner();
    const jobId = jobParam(c.req.param("id"));
    const job = q.job.get(jobId) as { id: string; state: string } | undefined;
    if (!job) throw new ApiError("not_found", `Job ${jobId} not found`);
    const prev = q.latest.get(jobId, "fund") as OpRow | undefined;
    if (job.state === "linked" && prev?.status === "confirmed") return c.json(view(prev), 200);
    if (job.state !== "selected") throw new ApiError("wrong_state", `Job in state ${job.state} cannot be funded`, { state: job.state });
    if (running.has(jobId)) throw new ApiError("conflict", "A demo operation for this job is already running");
    const sel = q.selection.get(jobId) as { funding_terms_json: string } | undefined;
    if (!sel) throw new Error(`job ${jobId} is selected without a selection`);
    const terms = JSON.parse(sel.funding_terms_json) as FundingTerms;
    if (terms.chainId !== s.chain.chainId) throw new ApiError("forbidden", "The selected terms are for another chain");
    const budget = BigInt(terms.budget);
    if (budget > s.maxBudgetPerJob) throw new ApiError("forbidden", "Budget exceeds the demo signer's per-job limit", { budget: terms.budget, max: s.maxBudgetPerJob.toString() });
    // A failed earlier attempt is resumed (same chain job), so it does not count twice against the session budget.
    if (!prev || prev.status !== "failed") {
      if (sessionSpent() + budget > s.sessionBudget) throw new ApiError("forbidden", "Session budget for the demo signer is exhausted");
    }
    const at = isoAt(deps.now());
    let op: OpRow;
    if (prev && prev.status !== "confirmed") {
      op = { ...prev, status: "pending", error: null };
      persist(op, JSON.parse(prev.steps_json) as Step[], { status: "pending", error: null });
    } else {
      op = { id: newId(), job_id: jobId, kind: "fund", status: "pending", chain_job_id: null, budget: terms.budget, steps_json: "[]", error: null, created_at: at, updated_at: at };
      q.insert.run(op.id, jobId, "fund", null, terms.budget, at, at);
    }
    launch(op, () => runFund(op, terms));
    return c.json(view(op), 202);
  };

  /** POST /v1/demo/jobs/:id/refund: claim the Poster's refund after real chain expiry. */
  const refund: Handler<AppEnv> = async (c) => {
    const s = requireSigner();
    const jobId = jobParam(c.req.param("id"));
    const link = q.link.get(jobId) as { chain_job_id: string } | undefined;
    if (!link) throw new ApiError("wrong_state", "The job is not funded on chain");
    const prev = q.latest.get(jobId, "refund") as OpRow | undefined;
    if (prev?.status === "confirmed") return c.json(view(prev), 200);
    if (running.has(jobId)) throw new ApiError("conflict", "A demo operation for this job is already running");
    const id = BigInt(link.chain_job_id);
    const [job, now] = await Promise.all([s.chain.readJob(id), s.chain.now()]);
    if (!job) throw new ApiError("not_found", "Chain job not found");
    if (job.status !== "Funded" && job.status !== "Submitted") throw new ApiError("wrong_state", `Chain job is ${job.status}; nothing to refund`, { state: job.status });
    if (now < job.expiredAt) {
      throw new ApiError("wrong_state", "The job has not expired on chain yet", { secondsLeft: (job.expiredAt - now).toString() });
    }
    const at = isoAt(deps.now());
    const op: OpRow = { id: newId(), job_id: jobId, kind: "refund", status: "pending", chain_job_id: link.chain_job_id, budget: null, steps_json: "[]", error: null, created_at: at, updated_at: at };
    q.insert.run(op.id, jobId, "refund", link.chain_job_id, null, at, at);
    launch(op, () => runRefund(op));
    return c.json(view(op), 202);
  };

  /** GET /v1/demo/ops/:id: an operation's status and its transactions. */
  const getOp: Handler<AppEnv> = (c) => {
    const id = c.req.param("id") ?? "";
    const row = ULID_RE.test(id) ? (q.get.get(id) as OpRow | undefined) : undefined;
    if (!row) throw new ApiError("not_found", "Operation not found");
    return c.json(view(row));
  };

  app.get("/v1/demo/capabilities", readBody, buyer, capabilities);
  app.post("/v1/demo/jobs/:id/fund", readBody, localOrigin, buyer, fund);
  app.post("/v1/demo/jobs/:id/refund", readBody, localOrigin, buyer, refund);
  app.get("/v1/demo/ops/:id", readBody, buyer, getOp);
}
