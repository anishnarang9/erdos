import { encodeFunctionData, isAddressEqual, type Address, type Hex } from "viem";
import { arcCoreAbi, arcErc20Abi } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import { isoAt, parseJson, readBody, requireJobId, ULID_RE, type AppEnv } from "./context.ts";
import { assertFundingBuyer, requireOwnedJob } from "./ownership.ts";
import { requireRealArtifact } from "./artifact.ts";
import { isPlainObject } from "./revision.ts";
import type { RouteContext } from "./routes.ts";

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export interface OpenClaimReceipt {
  hash: string;
  status: "success" | "reverted";
  to: string;
  blockNumber: bigint;
  events: { address: string; name: string; jobId: bigint }[];
}

export interface OpenClaimSnapshot {
  chainId: number;
  blockNumber: bigint;
  timestamp: bigint;
  core: string;
  adapter: string;
  usdc: string;
  verifier: string;
  job: {
    status: "Open" | "Funded" | "Submitted" | "Completed" | "Expired" | "Rejected";
    buyer: string; provider: string; evaluator: string; hook: string; token: string;
    budget: bigint; expiry: bigint; platformFee: bigint; evaluatorFee: bigint;
  };
  terms: {
    registered: boolean; buyer: string; imageId: string; rulesHash: string;
    referenceHash: string; budget: bigint; expiry: bigint;
  };
  submission: { accepted: boolean; solver: string; envelopeHash: string; keyCommitment: string };
  released: boolean;
}

/** Read-only chain boundary. The arc implementation must use one confirmed block for each snapshot. */
export interface OpenClaimReader {
  clock(): Promise<{ chainId: number; timestamp: bigint; blockNumber: bigint }>;
  receipt(hash: string): Promise<OpenClaimReceipt | null>;
  current(chainJobId: bigint): Promise<OpenClaimSnapshot>;
}

export interface OpenClaimConfig {
  mode: "arc" | "fixture";
  chainId: number;
  core: Address;
  adapter: Address;
  usdc: Address;
  verifier: Address;
  reader: OpenClaimReader;
}

type Job = { id: string; state: string; current_revision_id: string };
type Revision = { id: string; revision_hash: string; revision_json: string };
type Manifest = { image_id: string; rules_hash: string; reference_hash: string };
type Intent = { job_id: string; revision_id: string; buyer: string; budget: string; expiry: string };
type Link = { job_id: string; chain_id: number; core: string; adapter: string; chain_job_id: string; funding_tx: string; registration_tx: string };

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new ApiError("validation_failed", `${field} must be an address`);
  return value as Address;
}

function decimal(value: unknown, field: string, max: bigint): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value) || value.length > 78 || BigInt(value) > max) {
    throw new ApiError("validation_failed", `${field} must be a decimal integer in range`);
  }
  return BigInt(value);
}

function hash(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HASH.test(value)) throw new ApiError("validation_failed", `${field} must be 32-byte hex`);
  return value.toLowerCase() as Hex;
}

function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function sameAddress(a: string, b: string): boolean {
  return ADDRESS.test(a) && ADDRESS.test(b) && isAddressEqual(a as Address, b as Address);
}
function termsMismatch(field: string): never { throw new ApiError("terms_mismatch", `Confirmed ${field} differs from buyer-approved terms`, { field }); }
function pending(reason: string): never { throw new ApiError("chain_unconfirmed", "Open-claim transaction is not confirmed", { reason }); }

const DISCOVERY_LIMIT = 50;
const DISCOVERY_FIELDS = new Set(["cursor", "limit"]);
const LINK_SKIP = new Set(["terms_mismatch", "not_found", "wrong_state", "approval_required"]);

function discoveryValidation(message: string, path: string): ApiError {
  return new ApiError("validation_failed", "Request validation failed", { errors: [{ path, message }] });
}

/** Opaque discovery cursor. `oc1` plus the last scanned API job id, unpadded base64url. */
function encodeDiscoveryCursor(jobId: string): string {
  return Buffer.from(`oc1\n${jobId}`, "utf8").toString("base64url");
}

function decodeDiscoveryCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw discoveryValidation("is malformed", "/cursor");
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const split = text.indexOf("\n");
  const jobId = split < 0 ? "" : text.slice(split + 1);
  if (split < 0 || text.slice(0, split) !== "oc1" || !ULID_RE.test(jobId) || encodeDiscoveryCursor(jobId) !== cursor) {
    throw discoveryValidation("is malformed", "/cursor");
  }
  return jobId;
}

function discoveryLimit(raw: string | undefined): number {
  if (raw === undefined) return DISCOVERY_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) throw discoveryValidation("must be an integer from 1 to 50", "/limit");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISCOVERY_LIMIT) {
    throw discoveryValidation("must be an integer from 1 to 50", "/limit");
  }
  return limit;
}

function discoveryQuery(url: string): { after: string; limit: number } {
  const params = new URL(url).searchParams;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) throw discoveryValidation("is repeated", `/${key}`);
    seen.add(key);
    if (!DISCOVERY_FIELDS.has(key)) throw discoveryValidation("is not a discovery field", `/${key}`);
  }
  return {
    after: params.has("cursor") ? decodeDiscoveryCursor(params.get("cursor") ?? "") : "",
    limit: discoveryLimit(params.has("limit") ? params.get("limit") ?? "" : undefined),
  };
}

function chainReadFailed(error: unknown): never {
  if (error instanceof ApiError && error.code !== "chain_unavailable" && error.code !== "chain_unconfirmed") throw error;
  throw new ApiError("chain_unavailable", "Open-claim chain is unavailable");
}

function validateConfig(config: OpenClaimConfig): void {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0 ||
      ![config.core, config.adapter, config.usdc, config.verifier].every(a => ADDRESS.test(a)) ||
      sameAddress(config.core, config.adapter) || sameAddress(config.core, config.usdc)) {
    throw new Error("invalid open-claim deployment configuration");
  }
}

function assertSnapshot(s: OpenClaimSnapshot, config: OpenClaimConfig, intent: Intent, manifest: Manifest): void {
  if (s.chainId !== config.chainId) termsMismatch("chainId");
  for (const field of ["core", "adapter", "usdc", "verifier"] as const) {
    if (!sameAddress(s[field], config[field])) termsMismatch(field);
  }
  if (!sameAddress(s.job.buyer, intent.buyer) || !sameAddress(s.terms.buyer, intent.buyer)) termsMismatch("buyer");
  if (!sameAddress(s.job.provider, config.adapter) || !sameAddress(s.job.evaluator, config.adapter) ||
      !sameAddress(s.job.hook, ZERO) || !sameAddress(s.job.token, config.usdc)) termsMismatch("core roles or token");
  if (s.job.platformFee !== 0n || s.job.evaluatorFee !== 0n) termsMismatch("core fees");
  if (!s.terms.registered) termsMismatch("registration");
  if (s.job.budget !== BigInt(intent.budget) || s.terms.budget !== BigInt(intent.budget)) termsMismatch("budget");
  if (s.job.expiry !== BigInt(intent.expiry) || s.terms.expiry !== BigInt(intent.expiry)) termsMismatch("expiry");
  if (!same(s.terms.imageId, manifest.image_id) || !same(s.terms.rulesHash, manifest.rules_hash) ||
      !same(s.terms.referenceHash, manifest.reference_hash)) termsMismatch("proof commitments");
}

function confirmed(r: OpenClaimReceipt | null, txHash: Hex, to: Address, event: string, jobId: bigint): void {
  if (!r || r.status !== "success" || r.blockNumber <= 0n || !same(r.hash, txHash) || !sameAddress(r.to, to) ||
      !r.events.some(e => sameAddress(e.address, to) && e.name === event && e.jobId === jobId)) {
    pending(event);
  }
}

/** Public discovery is live-checked. A pending intent never appears in the feed. */
export function registerOpenClaimRoutes(ctx: RouteContext, config: OpenClaimConfig | undefined): void {
  if (config) {
    validateConfig(config);
    if (config.mode === "arc" && ctx.deps.engine.mode !== "real") {
      throw new Error("Arc open-claim routes require a real engine");
    }
  }
  const { app, deps, buyer, idem } = ctx;
  const owned = requireOwnedJob(deps);
  const { db } = deps;
  const q = {
    job: db.prepare("SELECT id, state, current_revision_id FROM jobs WHERE id = ?"),
    revision: db.prepare("SELECT id, revision_hash, revision_json FROM revisions WHERE id = ?"),
    manifest: db.prepare("SELECT image_id, rules_hash, reference_hash FROM manifests WHERE revision_id = ?"),
    approval: db.prepare("SELECT 1 FROM approvals WHERE revision_id = ? AND voided_at IS NULL"),
    intent: db.prepare("SELECT * FROM open_claim_intents WHERE job_id = ?"),
    insertIntent: db.prepare("INSERT INTO open_claim_intents (job_id, revision_id, buyer, budget, expiry, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    link: db.prepare("SELECT * FROM open_claim_links WHERE job_id = ?"),
    insertLink: db.prepare("INSERT INTO open_claim_links (job_id, chain_id, core, adapter, chain_job_id, funding_tx, registration_tx, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    linkPage: db.prepare("SELECT * FROM open_claim_links WHERE job_id > ? ORDER BY job_id ASC LIMIT ?"),
    setState: db.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?"),
  };
  const load = (id: string) => {
    const job = q.job.get(id) as Job | undefined;
    if (!job) throw new ApiError("not_found", "Job not found");
    const revision = q.revision.get(job.current_revision_id) as Revision | undefined;
    if (!revision) throw new ApiError("internal", "Current revision is missing");
    const manifest = q.manifest.get(revision.id) as Manifest | undefined;
    if (!manifest) throw new ApiError("wrong_state", "Job is not compiled", { state: job.state });
    if (!q.approval.get(revision.id)) throw new ApiError("approval_required", "Current revision is not approved");
    if (config?.mode === "arc") requireRealArtifact(db, revision.id);
    return { job, revision, manifest };
  };

  app.post("/v1/jobs/:id/open-claim-terms", readBody, buyer, parseJson, requireJobId, owned, idem.middleware, async c => {
    const principal = c.get("principal");
    if (principal?.kind === "wallet") {
      const named = c.get("json");
      const buyerName = isPlainObject(named) && typeof named.buyer === "string" ? named.buyer : "";
      assertFundingBuyer(principal, buyerName);
    }
    if (!config) throw new ApiError("chain_unavailable", "Open-claim chain is not configured");
    const body = c.get("json");
    if (!isPlainObject(body) || Object.keys(body).some(k => !["revisionHash", "buyer", "budget", "expiry"].includes(k))) {
      throw new ApiError("validation_failed", "Open-claim terms body has unknown fields");
    }
    const revisionHash = hash(body.revisionHash, "revisionHash");
    const buyerAddress = address(body.buyer, "buyer");
    const budget = decimal(body.budget, "budget", MAX_UINT256);
    const expiry = decimal(body.expiry, "expiry", MAX_UINT64);
    const { job, revision, manifest } = load(c.req.param("id") ?? "");
    if (job.state !== "compiled" && job.state !== "open_prepared") {
      throw new ApiError("wrong_state", "Job must be compiled before open-claim terms", { state: job.state });
    }
    if (!same(revision.revision_hash, revisionHash)) throw new ApiError("revision_conflict", "revisionHash is not current");
    const fields = JSON.parse(revision.revision_json) as { maxBudget: string };
    if (budget === 0n || budget > BigInt(fields.maxBudget)) throw new ApiError("validation_failed", "budget exceeds the approved maximum");
    const chainClock = await config.reader.clock();
    if (chainClock.chainId !== config.chainId) termsMismatch("chainId");
    if (expiry < chainClock.timestamp + 1200n) throw new ApiError("validation_failed", "expiry leaves less than 1200 seconds");
    const prior = q.intent.get(job.id) as Intent | undefined;
    if (job.state === "open_prepared" && !prior) throw new ApiError("internal", "Prepared job has no terms");
    if (prior && (prior.revision_id !== revision.id || !sameAddress(prior.buyer, buyerAddress) ||
        prior.budget !== String(budget) || prior.expiry !== String(expiry))) {
      throw new ApiError("terms_mismatch", "Open-claim terms were already approved for this job");
    }
    const description = `UBC26 open claim ${job.id}`;
    const txRequests = [
      { kind: "createJob", to: config.core, data: encodeFunctionData({ abi: arcCoreAbi, functionName: "createJob",
        args: [config.adapter, config.adapter, expiry, description, ZERO] }), value: "0" },
      { kind: "approve", to: config.usdc, data: encodeFunctionData({ abi: arcErc20Abi, functionName: "approve",
        args: [config.core, budget] }), value: "0" },
    ];
    const response = { state: "open_prepared", fundingTerms: { chainId: config.chainId, core: config.core,
      adapter: config.adapter, usdc: config.usdc, verifier: config.verifier, buyer: buyerAddress,
      budget: String(budget), expiry: String(expiry), imageId: manifest.image_id,
      rulesHash: manifest.rules_hash, referenceHash: manifest.reference_hash, description },
      order: ["createJob", "setBudget", "approve", "fund", "register"],
      txRequests, afterCreate: [
        { kind: "setBudget", to: config.core, signature: "setBudget(uint256,uint256,bytes)", args: { amount: String(budget), optParams: "0x" } },
        { kind: "fund", to: config.core, signature: "fund(uint256,bytes)", args: { optParams: "0x" } },
        { kind: "register", to: config.adapter, signature: "register(uint256,bytes32,bytes32,bytes32,uint256,uint64)",
          args: { imageId: manifest.image_id, rulesHash: manifest.rules_hash, referenceHash: manifest.reference_hash, budget: String(budget), expiry: String(expiry) } },
      ],
    };
    return idem.commit(c, 200, response, () => {
      const current = q.job.get(job.id) as Job;
      if (!["compiled", "open_prepared"].includes(current.state) || current.current_revision_id !== revision.id) {
        throw new ApiError("wrong_state", "Job changed before terms approval");
      }
      if (!prior) {
        q.insertIntent.run(job.id, revision.id, buyerAddress.toLowerCase(), String(budget), String(expiry), isoAt(deps.now()));
        q.setState.run("open_prepared", isoAt(deps.now()), job.id);
      }
    });
  });

  app.post("/v1/jobs/:id/open-claim-link", readBody, buyer, parseJson, requireJobId, owned, idem.middleware, async c => {
    if (!config) throw new ApiError("chain_unavailable", "Open-claim chain is not configured");
    const body = c.get("json");
    if (!isPlainObject(body) || Object.keys(body).some(k => !["revisionHash", "chainJobId", "fundingTx", "registrationTx"].includes(k))) {
      throw new ApiError("validation_failed", "Open-claim link body has unknown fields");
    }
    const revisionHash = hash(body.revisionHash, "revisionHash");
    const chainJobId = decimal(body.chainJobId, "chainJobId", MAX_UINT256);
    if (chainJobId === 0n) throw new ApiError("validation_failed", "chainJobId must be positive");
    const fundingTx = hash(body.fundingTx, "fundingTx");
    const registrationTx = hash(body.registrationTx, "registrationTx");
    if (fundingTx === registrationTx) throw new ApiError("validation_failed", "Funding and registration need separate transactions");
    const { job, revision, manifest } = load(c.req.param("id") ?? "");
    if (!same(revision.revision_hash, revisionHash)) throw new ApiError("revision_conflict", "revisionHash is not current");
    const intent = q.intent.get(job.id) as Intent | undefined;
    if (!intent || intent.revision_id !== revision.id) throw new ApiError("approval_required", "Exact open-claim terms are not approved");
    const prior = q.link.get(job.id) as Link | undefined;
    if (prior && (prior.chain_job_id !== String(chainJobId) || !same(prior.funding_tx, fundingTx) ||
        !same(prior.registration_tx, registrationTx))) termsMismatch("existing link");
    if (job.state !== "open_prepared" && job.state !== "open_registered") {
      throw new ApiError("wrong_state", "Job cannot link open-claim funding", { state: job.state });
    }
    const [funded, registered, snapshot] = await Promise.all([
      config.reader.receipt(fundingTx), config.reader.receipt(registrationTx), config.reader.current(chainJobId),
    ]);
    confirmed(funded, fundingTx, config.core, "JobFunded", chainJobId);
    confirmed(registered, registrationTx, config.adapter, "TermsRegistered", chainJobId);
    if (funded!.blockNumber > registered!.blockNumber || snapshot.blockNumber < registered!.blockNumber) pending("registration order");
    assertSnapshot(snapshot, config, intent, manifest);
    if (snapshot.job.status !== "Funded" || snapshot.submission.accepted || snapshot.released ||
        snapshot.timestamp >= snapshot.job.expiry) termsMismatch("open funded state");
    const response = { state: "open_registered", jobId: job.id, chainJobId: String(chainJobId),
      chainId: config.chainId, core: config.core, adapter: config.adapter,
      fundingTx, registrationTx, status: snapshot.job.status };
    return idem.commit(c, 200, response, () => {
      const current = q.job.get(job.id) as Job;
      if (current.current_revision_id !== revision.id || !["open_prepared", "open_registered"].includes(current.state)) {
        throw new ApiError("wrong_state", "Job changed before open-claim link");
      }
      if (!prior) {
        q.insertLink.run(job.id, config.chainId, config.core.toLowerCase(), config.adapter.toLowerCase(), String(chainJobId), fundingTx, registrationTx, isoAt(deps.now()));
        q.setState.run("open_registered", isoAt(deps.now()), job.id);
      }
    });
  });

  async function view(link: Link): Promise<Record<string, unknown>> {
    if (!config || link.chain_id !== config.chainId || !sameAddress(link.core, config.core) ||
        !sameAddress(link.adapter, config.adapter)) termsMismatch("deployment");
    const { job, revision, manifest } = load(link.job_id);
    if (job.state !== "open_registered") termsMismatch("API state");
    const intent = q.intent.get(job.id) as Intent | undefined;
    if (!intent || intent.revision_id !== revision.id) termsMismatch("approval");
    const snapshot = await config.reader.current(BigInt(link.chain_job_id));
    assertSnapshot(snapshot, config, intent, manifest);
    // Expiry uses this snapshot's confirmed timestamp and this snapshot's job expiry together.
    const expired = snapshot.timestamp >= snapshot.job.expiry;
    return { jobId: job.id, revisionHash: revision.revision_hash, chainJobId: link.chain_job_id,
      chainId: config.chainId, core: config.core, adapter: config.adapter, status: snapshot.job.status,
      winner: snapshot.submission.accepted ? snapshot.submission.solver : null,
      envelopeHash: snapshot.submission.accepted ? snapshot.submission.envelopeHash : null,
      keyCommitment: snapshot.submission.accepted ? snapshot.submission.keyCommitment : null,
      released: snapshot.released, expired,
      confirmedTimestamp: snapshot.timestamp.toString(), confirmedBlockNumber: snapshot.blockNumber.toString(),
      budget: intent.budget, expiry: intent.expiry, buyer: intent.buyer,
      manifest: { imageId: manifest.image_id, rulesHash: manifest.rules_hash, referenceHash: manifest.reference_hash },
      fundingTx: link.funding_tx, registrationTx: link.registration_tx,
      evidenceMode: config.mode,
    };
  }

  app.get("/v1/open-jobs", readBody, async c => {
    const query = discoveryQuery(c.req.url);
    // Read one extra row so a full window can advance without a chain call for that row.
    const rows = q.linkPage.all(query.after, query.limit + 1) as Link[];
    const window = rows.slice(0, query.limit);
    if (window.length > 0 && !config) throw new ApiError("chain_unavailable", "Open-claim chain is not configured");
    const jobs: Record<string, unknown>[] = [];
    for (const link of window) {
      try {
        const item = await view(link);
        if (item.status === "Funded" && item.winner === null && item.released === false && item.expired === false) jobs.push(item);
      } catch (error) {
        if (error instanceof ApiError && LINK_SKIP.has(error.code)) continue;
        chainReadFailed(error);
      }
    }
    const last = window[window.length - 1];
    return c.json({ jobs, nextCursor: rows.length > query.limit && last ? encodeDiscoveryCursor(last.job_id) : null });
  });
  app.get("/v1/open-jobs/:id", readBody, requireJobId, async c => {
    const link = q.link.get(c.req.param("id") ?? "") as Link | undefined;
    if (!link) throw new ApiError("not_found", "Open job not found");
    return c.json(await view(link));
  });
}
