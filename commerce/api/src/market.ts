// T7/T8 routes: job feed, quotes, select-quote, funding-receipt, assignments. Owner: Coder D.
// Implements ../CONTRACT-T5-T8.md §5–6 with explicit real Arc / legacy simulated chain readers.
import type { Handler } from "hono";
import {
  isAddress,
  isAddressEqual,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { JobStatus, withRetry } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import { requireRealArtifact } from "./artifact.ts";
import { readBody, parseJson, requireJobId, isoAt, type AppEnv, type Deps } from "./context.ts";
import { requireOwnedJob } from "./ownership.ts";
import type { RouteContext } from "./routes.ts";
import { isPlainObject, type FieldError } from "./revision.ts";
import {
  afterCreateSteps,
  arcSelectionTiming,
  checksum,
  DEFAULT_QUOTE_CHAIN_ID,
  fundingTxRequests,
  readChain,
  requireChain,
  type FundingTerms,
} from "./chain.ts";

/** Job-view `chain` field (CONTRACT-T5-T8 §6). jobs.ts calls chainViewFor. */
export interface ChainView {
  chainId: number;
  core: string;
  jobId: string;
  status: string;
  statusSource: "index" | "live";
  fundTx: string;
}

// ---------------------------------------------------------------------------------------------------------------
// EIP-712 quote (§5)

export const QUOTE_DOMAIN_NAME = "UBC26 Commerce";
export const QUOTE_DOMAIN_VERSION = "1";
export const QUOTE_TYPES = {
  Quote: [
    { name: "revisionHash", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "price", type: "uint256" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function quoteDomain(chainId: number) {
  return { name: QUOTE_DOMAIN_NAME, version: QUOTE_DOMAIN_VERSION, chainId } as const;
}

/** §5 quote check 7: validUntil must lie in [now + 60, now + 86400]. */
export const QUOTE_MIN_VALIDITY_SEC = 60;
export const QUOTE_MAX_VALIDITY_SEC = 86_400;
/** §5 select-quote: a quote is expired once now >= validUntil - 60. */
export const SELECT_MARGIN_SEC = 60;
export const FEED_DEFAULT_LIMIT = 50;
export const FEED_MAX_LIMIT = 100;

const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------------------------------------------
// Rows

interface JobRow {
  id: string;
  state: string;
  current_revision_id: string;
}
interface RevisionRow {
  id: string;
  revision_json: string;
  revision_hash: string;
}
interface ManifestRow {
  image_id: string;
  rules_hash: string;
  reference_hash: string;
  manifest_json: string;
}
interface QuoteRow {
  id: string;
  job_id: string;
  revision_hash: string;
  provider: string;
  price_units: string;
  valid_until: number;
}
interface SelectionRow {
  quote_id: string;
  funding_terms_json: string;
}
interface LinkRow {
  job_id: string;
  chain_id: number;
  core: string;
  chain_job_id: string;
  funding_tx: string;
}

interface RevisionFields {
  plan?: unknown;
  outputs: unknown;
  expirySeconds: number;
  maxBudget: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

function invalid(errors: FieldError[]): ApiError {
  return new ApiError("validation_failed", "Request validation failed", { errors });
}

function wrongState(state: string, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError("wrong_state", `Job in state ${state} does not allow this action`, { state, ...extra });
}

function revisionConflict(current: string): ApiError {
  return new ApiError("revision_conflict", "revisionHash is not the current revision", {
    currentRevisionHash: current,
  });
}

function mismatch(field: string, expected?: unknown, actual?: unknown): ApiError {
  const details: Record<string, unknown> = { field };
  if (expected !== undefined) details.expected = String(expected);
  if (actual !== undefined) details.actual = String(actual);
  return new ApiError("terms_mismatch", `On-chain ${field} does not match the agreed terms`, details);
}

function unconfirmed(reason: string): ApiError {
  return new ApiError("chain_unconfirmed", "Funding transaction is not confirmed", { reason });
}

/** Rejects unknown keys and returns the errors for them (rule 2b). */
function unknownKeys(obj: Record<string, unknown>, allowed: string[], prefix = ""): FieldError[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => ({ path: `${prefix}/${k}`, message: "unknown field" }));
}

const lower = (s: string): string => s.toLowerCase();
const nowSec = (deps: Deps): number => Math.floor(deps.now() / 1000);

// ---------------------------------------------------------------------------------------------------------------
// Chain status (§6): latest indexed core event, otherwise a live getJob.

/** Status derivation table of §6, keyed by core event name. */
export const EVENT_STATUS: Record<string, string> = {
  JobCreated: "Open",
  JobFunded: "Funded",
  JobSubmitted: "Submitted",
  JobCompleted: "Completed",
  Refunded: "Expired",
  JobExpired: "Expired",
  JobRejected: "Rejected",
};

/** Returned when nothing is indexed and no live read is possible (no chain configured, or the RPC failed). */
export const UNKNOWN_STATUS = "Unknown";

const STATUS_EVENT_NAMES = Object.keys(EVENT_STATUS);

function latestIndexedStatus(deps: Deps, link: LinkRow): string | null {
  const row = deps.db
    .prepare(
      `SELECT name FROM events WHERE chain_id = ? AND address = ? AND job_id = ? AND contract = 'core'
         AND name IN (${STATUS_EVENT_NAMES.map(() => "?").join(", ")})
       ORDER BY block DESC, log_index DESC LIMIT 1`,
    )
    .get(link.chain_id, lower(link.core), link.chain_job_id, ...STATUS_EVENT_NAMES) as { name: string } | undefined;
  return row ? (EVENT_STATUS[row.name] ?? null) : null;
}

async function chainStatus(deps: Deps, link: LinkRow): Promise<{ status: string; source: "index" | "live" }> {
  const indexed = latestIndexedStatus(deps, link);
  if (indexed !== null) return { status: indexed, source: "index" };
  const chain = deps.chain;
  if (!chain || chain.config.chainId !== link.chain_id || !isAddressEqual(chain.config.core, link.core as Address)) {
    return { status: UNKNOWN_STATUS, source: "live" };
  }
  try {
    const job = await readChain(chain).getJob(BigInt(link.chain_job_id));
    return { status: JobStatus[job.status] ?? UNKNOWN_STATUS, source: "live" };
  } catch (err) {
    console.error("[api] live getJob failed", err);
    return { status: UNKNOWN_STATUS, source: "live" };
  }
}

function linkRow(deps: Deps, jobId: string): LinkRow | undefined {
  return deps.db
    .prepare("SELECT job_id, chain_id, core, chain_job_id, funding_tx FROM chain_links WHERE job_id = ?")
    .get(jobId) as LinkRow | undefined;
}

function chainJobOf(link: LinkRow): { chainId: number; core: Address; jobId: string } {
  return { chainId: link.chain_id, core: checksum(link.core), jobId: link.chain_job_id };
}

/** The job view's `chain` field: null until the job is linked (§6). */
export async function chainViewFor(deps: Deps, jobId: string): Promise<ChainView | null> {
  const link = linkRow(deps, jobId);
  if (!link) return null;
  const { status, source } = await chainStatus(deps, link);
  return { ...chainJobOf(link), status, statusSource: source, fundTx: link.funding_tx };
}

// ---------------------------------------------------------------------------------------------------------------
// Body parsing

interface QuoteInput {
  revisionHash: string;
  provider: string;
  price: bigint;
  validUntil: number;
  nonce: string;
  signature: Hex;
}

function parseQuoteBody(body: unknown): QuoteInput {
  if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
  const errors = unknownKeys(body, ["quote", "signature"]);
  if (typeof body.signature !== "string" || !SIG_RE.test(body.signature)) {
    errors.push({ path: "/signature", message: "must be 0x hex of 65 bytes" });
  }
  const q = body.quote;
  if (!isPlainObject(q)) {
    errors.push({ path: "/quote", message: "required object" });
    throw invalid(errors);
  }
  errors.push(...unknownKeys(q, ["revisionHash", "provider", "price", "validUntil", "nonce"], "/quote"));
  if (typeof q.revisionHash !== "string" || !HASH32_RE.test(q.revisionHash)) {
    errors.push({ path: "/quote/revisionHash", message: "must be 32-byte 0x hex" });
  }
  if (typeof q.provider !== "string" || !isAddress(q.provider, { strict: false })) {
    errors.push({ path: "/quote/provider", message: "must be an address" });
  }
  const uint256 = (v: unknown, path: string): boolean => {
    if (typeof v !== "string" || !DECIMAL_RE.test(v) || v.length > 78 || BigInt(v) > UINT256_MAX) {
      errors.push({ path, message: "must be a uint256 decimal string without leading zeros" });
      return false;
    }
    return true;
  };
  uint256(q.price, "/quote/price");
  uint256(q.nonce, "/quote/nonce");
  if (typeof q.validUntil !== "number" || !Number.isSafeInteger(q.validUntil) || q.validUntil < 0) {
    errors.push({ path: "/quote/validUntil", message: "must be integer unix seconds" });
  }
  if (errors.length > 0) throw invalid(errors);
  return {
    revisionHash: q.revisionHash as string,
    provider: q.provider as string,
    price: BigInt(q.price as string),
    validUntil: q.validUntil as number,
    nonce: q.nonce as string,
    signature: body.signature as Hex,
  };
}

function parseSelectBody(body: unknown): { quoteId: string; revisionHash: string } {
  if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
  const errors = unknownKeys(body, ["quoteId", "revisionHash"]);
  if (typeof body.quoteId !== "string" || body.quoteId.length === 0 || body.quoteId.length > 128) {
    errors.push({ path: "/quoteId", message: "required string" });
  }
  if (typeof body.revisionHash !== "string" || !HASH32_RE.test(body.revisionHash)) {
    errors.push({ path: "/revisionHash", message: "must be 32-byte 0x hex" });
  }
  if (errors.length > 0) throw invalid(errors);
  return { quoteId: body.quoteId as string, revisionHash: body.revisionHash as string };
}

function parseReceiptBody(body: unknown): { txHash: Hex } {
  if (!isPlainObject(body)) throw invalid([{ path: "", message: "body must be a JSON object" }]);
  const errors = unknownKeys(body, ["txHash"]);
  if (typeof body.txHash !== "string" || !HASH32_RE.test(body.txHash)) {
    errors.push({ path: "/txHash", message: "must be 32-byte 0x hex" });
  }
  if (errors.length > 0) throw invalid(errors);
  return { txHash: lower(body.txHash as string) as Hex };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return FEED_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > FEED_MAX_LIMIT) {
    throw invalid([{ path: "/query/limit", message: `must be an integer from 1 to ${FEED_MAX_LIMIT}` }]);
  }
  return Number(raw);
}

/** `plan.jobType` when it is a string, otherwise null (§5). */
function jobTypeOf(rev: RevisionFields): string | null {
  const plan = rev.plan;
  return isPlainObject(plan) && typeof plan.jobType === "string" ? plan.jobType : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Routes

export function registerMarketRoutes(ctx: RouteContext): void {
  const { app, deps, buyer, provider, idem, notImplemented, newId } = ctx;
  const owned = requireOwnedJob(deps);
  const { db } = deps;
  const commit = idem.commit;

  const q = {
    job: db.prepare("SELECT id, state, current_revision_id FROM jobs WHERE id = ?"),
    revision: db.prepare("SELECT id, revision_json, revision_hash FROM revisions WHERE id = ?"),
    manifest: db.prepare(
      "SELECT image_id, rules_hash, reference_hash, manifest_json FROM manifests WHERE revision_id = ?",
    ),
    compiledJobs: db.prepare(
      `SELECT j.id AS id, r.revision_json AS revision_json, r.revision_hash AS revision_hash,
              m.image_id AS image_id, m.rules_hash AS rules_hash, m.reference_hash AS reference_hash
         FROM jobs j JOIN revisions r ON r.id = j.current_revision_id JOIN manifests m ON m.revision_id = r.id
        WHERE j.state = 'compiled' ORDER BY j.id DESC`,
    ),
    quoteDup: db.prepare("SELECT 1 FROM quotes WHERE job_id = ? AND provider = ? AND nonce = ?"),
    insertQuote: db.prepare(
      `INSERT INTO quotes (id, job_id, revision_hash, provider, price_units, valid_until, nonce, signature, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ),
    quote: db.prepare(
      "SELECT id, job_id, revision_hash, provider, price_units, valid_until FROM quotes WHERE id = ?",
    ),
    setQuoteStatus: db.prepare("UPDATE quotes SET status = ? WHERE id = ?"),
    insertSelection: db.prepare(
      "INSERT INTO selections (job_id, quote_id, funding_terms_json, selected_at) VALUES (?, ?, ?, ?)",
    ),
    selection: db.prepare("SELECT quote_id, funding_terms_json FROM selections WHERE job_id = ?"),
    linkByChainJob: db.prepare(
      "SELECT job_id FROM chain_links WHERE chain_id = ? AND core = ? AND chain_job_id = ?",
    ),
    insertLink: db.prepare(
      "INSERT INTO chain_links (job_id, chain_id, core, chain_job_id, funding_tx, verified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    setState: db.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?"),
    assignments: db.prepare(
      `SELECT l.job_id AS job_id, l.chain_id AS chain_id, l.core AS core, l.chain_job_id AS chain_job_id,
              l.funding_tx AS funding_tx, s.funding_terms_json AS funding_terms_json,
              r.revision_hash AS revision_hash, r.revision_json AS revision_json, m.manifest_json AS manifest_json
         FROM chain_links l
         JOIN jobs j ON j.id = l.job_id
         JOIN selections s ON s.job_id = l.job_id
         JOIN quotes qu ON qu.id = s.quote_id
         JOIN revisions r ON r.id = j.current_revision_id
         JOIN manifests m ON m.revision_id = r.id
        WHERE j.state = 'linked' AND qu.provider = ?
        ORDER BY l.job_id ASC`,
    ),
  };

  const loadJob = (id: string): { job: JobRow; rev: RevisionRow; fields: RevisionFields } => {
    const job = q.job.get(id) as JobRow | undefined;
    if (!job) throw new ApiError("not_found", `Job ${id} not found`);
    const rev = q.revision.get(job.current_revision_id) as RevisionRow | undefined;
    if (!rev) throw new Error(`job ${id} has no current revision`);
    return { job, rev, fields: JSON.parse(rev.revision_json) as RevisionFields };
  };

  const loadManifest = (rev: RevisionRow): ManifestRow => {
    const m = q.manifest.get(rev.id) as ManifestRow | undefined;
    if (!m) throw new Error(`revision ${rev.id} has no manifest`);
    return m;
  };

  /** GET /v1/jobs?jobType=&limit= (public) */
  const feed: Handler<AppEnv> = (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const jobType = c.req.query("jobType");
    const rows = q.compiledJobs.all() as unknown as (RevisionRow & ManifestRow & { id: string })[];
    const jobs = [];
    for (const row of rows) {
      const fields = JSON.parse(row.revision_json) as RevisionFields;
      const jt = jobTypeOf(fields);
      if (jobType !== undefined && jt !== jobType) continue;
      jobs.push({
        jobId: row.id,
        revisionHash: row.revision_hash,
        jobType: jt,
        outputs: fields.outputs,
        expirySeconds: fields.expirySeconds,
        maxBudget: fields.maxBudget,
        manifest: { imageId: row.image_id, rulesHash: row.rules_hash, referenceHash: row.reference_hash },
      });
      if (jobs.length >= limit) break;
    }
    return c.json({ jobs });
  };

  /** POST /v1/jobs/:id/quotes (provider). Checks run in the order of the §5 table. */
  const postQuote: Handler<AppEnv> = async (c) => {
    const input = parseQuoteBody(c.get("json")); // 1
    const { job, rev, fields } = loadJob(c.req.param("id") ?? ""); // 2
    if (job.state !== "compiled") throw wrongState(job.state); // 3
    if (lower(input.revisionHash) !== rev.revision_hash) throw revisionConflict(rev.revision_hash); // 4
    const caller = c.get("caller");
    if (lower(input.provider) !== caller) {
      throw new ApiError("unauthorized", "quote.provider is not the authenticated provider"); // 5
    }
    if (input.price <= 0n || input.price > BigInt(fields.maxBudget)) {
      throw invalid([{ path: "/quote/price", message: `must be > 0 and <= maxBudget ${fields.maxBudget}` }]); // 6
    }
    const now = nowSec(deps);
    if (input.validUntil < now + QUOTE_MIN_VALIDITY_SEC || input.validUntil > now + QUOTE_MAX_VALIDITY_SEC) {
      throw invalid([
        { path: "/quote/validUntil", message: `must be within [now + ${QUOTE_MIN_VALIDITY_SEC}, now + ${QUOTE_MAX_VALIDITY_SEC}]` },
      ]); // 7
    }
    let valid = false;
    try {
      valid = await verifyTypedData({
        address: caller as Address,
        domain: quoteDomain(deps.chain?.config.chainId ?? DEFAULT_QUOTE_CHAIN_ID),
        types: QUOTE_TYPES,
        primaryType: "Quote",
        message: {
          revisionHash: lower(input.revisionHash) as Hex,
          provider: caller as Address,
          price: input.price,
          validUntil: BigInt(input.validUntil),
          nonce: BigInt(input.nonce),
        },
        signature: input.signature,
      });
    } catch {
      valid = false;
    }
    if (!valid) throw new ApiError("unauthorized", "Quote signature does not recover quote.provider"); // 8

    const duplicate = (): ApiError => wrongState(job.state, { reason: "duplicate_quote" });
    if (q.quoteDup.get(job.id, caller, input.nonce)) throw duplicate(); // 9
    const quoteId = newId();
    const at = isoAt(deps.now());
    return commit(c, 201, { quoteId, validUntil: input.validUntil }, () => {
      // Re-checked inside the write transaction: the signature check above awaited.
      const cur = q.job.get(job.id) as unknown as JobRow;
      if (cur.state !== "compiled") throw wrongState(cur.state);
      if (q.quoteDup.get(job.id, caller, input.nonce)) throw duplicate();
      q.insertQuote.run(
        quoteId,
        job.id,
        rev.revision_hash,
        caller,
        input.price.toString(),
        input.validUntil,
        input.nonce,
        input.signature,
        at,
      );
    });
  };

  /** POST /v1/jobs/:id/select-quote (buyer) */
  const selectQuote: Handler<AppEnv> = async (c) => {
    const chain = requireChain(deps);
    const body = parseSelectBody(c.get("json"));
    const { job, rev, fields } = loadJob(c.req.param("id") ?? "");
    if (job.state !== "compiled") throw wrongState(job.state);
    if (lower(body.revisionHash) !== rev.revision_hash) throw revisionConflict(rev.revision_hash);
    const quote = q.quote.get(body.quoteId) as QuoteRow | undefined;
    if (!quote || quote.job_id !== job.id) throw new ApiError("not_found", `Quote ${body.quoteId} not found`);
    // Quotes are only accepted for the current revision of a compiled job, and a compiled job's revision is
    // fixed, so this cannot fail today; kept so a stale quote can never fund a different revision.
    if (quote.revision_hash !== rev.revision_hash) throw revisionConflict(rev.revision_hash);
    if (chain.mode === "arc") requireRealArtifact(db, rev.id);
    let chainTimestamp = BigInt(nowSec(deps));
    if (chain.mode === "arc") {
      const timing = await arcSelectionTiming(chain);
      chainTimestamp = timing.timestamp;
      if (BigInt(fields.expirySeconds) < timing.minimumExpirySeconds) {
        throw new ApiError("validation_failed", `Approved expirySeconds is too short for Arc proving, settlement and funding; at least ${timing.minimumExpirySeconds} seconds required. Revise and reapprove; expiry was not changed.`, {
          reason: "expiry_too_short", minimumExpirySeconds: timing.minimumExpirySeconds.toString(), expirySeconds: fields.expirySeconds,
        });
      }
    }
    if (chainTimestamp >= BigInt(quote.valid_until - SELECT_MARGIN_SEC)) {
      throw new ApiError("quote_expired", "Quote is expired or within 60 s of validUntil", {
        validUntil: quote.valid_until,
      });
    }
    const manifest = loadManifest(rev);
    const cfg = chain.config;
    const fundingTerms: FundingTerms = {
      chainId: cfg.chainId,
      core: checksum(cfg.core),
      hook: checksum(cfg.hook),
      usdc: checksum(cfg.usdc),
      provider: checksum(quote.provider),
      budget: quote.price_units,
      expiredAt: String(chainTimestamp + BigInt(fields.expirySeconds)),
      imageId: manifest.image_id as Hex,
      rulesHash: manifest.rules_hash as Hex,
      referenceHash: manifest.reference_hash as Hex,
      description: "ubc26:" + job.id,
    };
    const resBody = {
      state: "selected",
      fundingTerms,
      txRequests: fundingTxRequests(fundingTerms, chain.mode),
      afterCreate: afterCreateSteps(fundingTerms),
    };
    const at = isoAt(deps.now());
    return commit(c, 200, resBody, () => {
      const current = loadJob(job.id);
      if (current.job.state !== "compiled") throw wrongState(current.job.state);
      if (current.rev.id !== rev.id) throw revisionConflict(current.rev.revision_hash);
      if (chain.mode === "arc") requireRealArtifact(db, rev.id);
      q.insertSelection.run(job.id, quote.id, JSON.stringify(fundingTerms), at);
      q.setQuoteStatus.run("selected", quote.id);
      q.setState.run("selected", at, job.id);
    });
  };

  const linkedBody = (link: LinkRow) => ({ state: "linked", chainJob: chainJobOf(link) });

  /** POST /v1/jobs/:id/funding-receipt (buyer) */
  const fundingReceipt: Handler<AppEnv> = async (c) => {
    const chain = requireChain(deps);
    const { txHash } = parseReceiptBody(c.get("json"));
    const { job, rev } = loadJob(c.req.param("id") ?? "");
    if (chain.mode === "arc") requireRealArtifact(db, rev.id);
    const existing = linkRow(deps, job.id);
    if (job.state === "linked" && existing && existing.funding_tx === txHash) {
      return commit(c, 200, linkedBody(existing)); // repeat for the same transaction
    }
    if (job.state !== "selected") throw wrongState(job.state);
    const selection = q.selection.get(job.id) as SelectionRow | undefined;
    if (!selection) throw new Error(`job ${job.id} is selected but has no selection row`);
    const terms = JSON.parse(selection.funding_terms_json) as FundingTerms;
    const quote = q.quote.get(selection.quote_id) as unknown as QuoteRow;
    const manifest = loadManifest(rev);
    const cfg = chain.config;
    // The terms were issued for a chain config; a reconfigured server must not link against another deployment.
    if (terms.chainId !== cfg.chainId) throw mismatch("chainId", terms.chainId, cfg.chainId);
    if (!isAddressEqual(terms.core, cfg.core)) throw mismatch("core", terms.core, cfg.core);
    if (!isAddressEqual(terms.hook, cfg.hook)) throw mismatch("hook", terms.hook, cfg.hook);
    if (!isAddressEqual(terms.usdc, cfg.usdc)) throw mismatch("usdc", terms.usdc, cfg.usdc);
    if (quote.revision_hash !== rev.revision_hash) throw revisionConflict(rev.revision_hash);
    if (!isAddressEqual(terms.provider, quote.provider as Address)) throw mismatch("provider", quote.provider, terms.provider);
    if (terms.budget !== quote.price_units) throw mismatch("budget", quote.price_units, terms.budget);
    if (terms.description !== "ubc26:" + job.id) throw mismatch("description", "ubc26:" + job.id, terms.description);
    for (const [field, want] of [["imageId", manifest.image_id], ["rulesHash", manifest.rules_hash], ["referenceHash", manifest.reference_hash]] as const) {
      if (lower(terms[field]) !== lower(want)) throw mismatch(field, want, terms[field]);
    }

    let receipt;
    try {
      receipt = await withRetry(() => chain.publicClient.getTransactionReceipt({ hash: txHash }));
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError || err instanceof TransactionNotFoundError) {
        throw unconfirmed("not_found");
      }
      console.error("[api] getTransactionReceipt failed", err);
      throw new ApiError("chain_unavailable", "Chain RPC request failed");
    }
    if (receipt.status !== "success") throw unconfirmed("reverted");
    if (!receipt.to || !isAddressEqual(receipt.to, cfg.core)) throw mismatch("to", cfg.core, receipt.to ?? "null");

    const rc = readChain(chain);
    if (chain.mode === "arc" && (typeof receipt.blockNumber !== "bigint" || lower(receipt.transactionHash) !== txHash)) {
      throw mismatch("receipt", "mined receipt for requested transaction");
    }
    // Only logs emitted by this deployment may establish funding, even if another contract emits the same ABI.
    const events = rc.decodeLogs(receipt.logs.filter((log) =>
      isAddressEqual(log.address, cfg.core) || isAddressEqual(log.address, cfg.hook),
    ));
    if (chain.mode === "arc" && events.some((e) => e.blockNumber !== receipt.blockNumber || lower(e.transactionHash) !== txHash)) {
      throw mismatch("events", "events from the funding receipt block and transaction");
    }
    const funded = events.filter((e) => e.contract === "core" && e.name === "JobFunded");
    const frozen = events.filter((e) => e.contract === "hook" && e.name === "TermsFrozen");
    if (funded.length !== 1 || frozen.length !== 1 || funded[0]!.args.jobId !== frozen[0]!.args.jobId) {
      throw mismatch("events", "one JobFunded and one TermsFrozen for one jobId");
    }
    const chainJobId = funded[0]!.args.jobId;
    if (typeof chainJobId !== "bigint" || chainJobId < 0n) throw mismatch("events", "uint256 jobId");
    const coreLower = lower(cfg.core);
    const linkedTo = (): string | undefined =>
      (q.linkByChainJob.get(cfg.chainId, coreLower, chainJobId.toString()) as { job_id: string } | undefined)?.job_id;
    const other = linkedTo();
    if (other !== undefined && other !== job.id) throw mismatch("jobId", "unlinked chain job", chainJobId);

    let onChain, frozenTerms;
    try {
      if (chain.mode === "arc") {
        if (!rc.getSnapshot) throw new Error("Arc reader has no snapshot support");
        const snapshot = await rc.getSnapshot(chainJobId, receipt.blockNumber);
        if (snapshot.blockNumber !== receipt.blockNumber) throw mismatch("blockNumber", receipt.blockNumber, snapshot.blockNumber);
        onChain = snapshot.job;
        frozenTerms = snapshot.terms;
      } else {
        [onChain, frozenTerms] = await Promise.all([rc.getJob(chainJobId), rc.getTerms(chainJobId)]);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      console.error("[api] getJob/getTerms failed", err);
      throw new ApiError("chain_unavailable", "Chain RPC request failed");
    }
    const budget = BigInt(terms.budget);
    const expiredAt = BigInt(terms.expiredAt);
    if (!isAddressEqual(onChain.provider, quote.provider as Address)) {
      throw mismatch("provider", quote.provider, onChain.provider);
    }
    if (!isAddressEqual(onChain.evaluator, cfg.hook)) throw mismatch("evaluator", cfg.hook, onChain.evaluator);
    if (!isAddressEqual(onChain.hook, cfg.hook)) throw mismatch("hook", cfg.hook, onChain.hook);
    if (onChain.description !== terms.description) throw mismatch("description", terms.description, onChain.description);
    if (onChain.budget !== budget) throw mismatch("budget", budget, onChain.budget);
    if (onChain.expiredAt !== expiredAt) throw mismatch("expiredAt", expiredAt, onChain.expiredAt);
    if (onChain.status !== JobStatus.Funded) {
      throw mismatch("status", "Funded", JobStatus[onChain.status] ?? onChain.status);
    }
    if (!frozenTerms) throw mismatch("imageId", manifest.image_id, "none (terms not frozen)");
    for (const [field, want, got] of [
      ["imageId", manifest.image_id, frozenTerms.imageId],
      ["rulesHash", manifest.rules_hash, frozenTerms.rulesHash],
      ["referenceHash", manifest.reference_hash, frozenTerms.referenceHash],
    ] as const) {
      if (lower(want) !== lower(got)) throw mismatch(field, want, got);
    }
    // The gate's frozen copy must agree too: it is what the proof is checked against.
    if (!isAddressEqual(frozenTerms.provider, quote.provider as Address)) {
      throw mismatch("provider", quote.provider, frozenTerms.provider);
    }
    if (frozenTerms.budget !== budget) throw mismatch("budget", budget, frozenTerms.budget);
    if (frozenTerms.expiredAt !== expiredAt) throw mismatch("expiredAt", expiredAt, frozenTerms.expiredAt);

    const link: LinkRow = {
      job_id: job.id,
      chain_id: cfg.chainId,
      core: coreLower,
      chain_job_id: chainJobId.toString(),
      funding_tx: txHash,
    };
    const at = isoAt(deps.now());
    return commit(c, 200, linkedBody(link), () => {
      // Re-checked inside the write transaction: the chain reads above awaited.
      const cur = q.job.get(job.id) as unknown as JobRow;
      if (cur.state !== "selected") throw wrongState(cur.state);
      if (cur.current_revision_id !== rev.id) throw revisionConflict(loadJob(job.id).rev.revision_hash);
      const currentSelection = q.selection.get(job.id) as SelectionRow | undefined;
      if (currentSelection?.quote_id !== selection.quote_id || currentSelection.funding_terms_json !== selection.funding_terms_json) {
        throw mismatch("selection", "unchanged selection");
      }
      if (chain.mode === "arc") requireRealArtifact(db, rev.id);
      if (linkedTo() !== undefined) throw mismatch("jobId", "unlinked chain job", chainJobId);
      q.insertLink.run(link.job_id, link.chain_id, link.core, link.chain_job_id, link.funding_tx, at);
      q.setState.run("linked", at, job.id);
    });
  };

  /** GET /v1/assignments (provider): linked jobs of the caller whose chain status is Funded. */
  const assignments: Handler<AppEnv> = async (c) => {
    const rows = q.assignments.all(c.get("caller")) as unknown as (LinkRow & {
      funding_terms_json: string;
      revision_hash: string;
      revision_json: string;
      manifest_json: string;
    })[];
    const out = [];
    for (const row of rows) {
      const { status } = await chainStatus(deps, row);
      if (status !== "Funded") continue;
      const terms = JSON.parse(row.funding_terms_json) as FundingTerms;
      const fields = JSON.parse(row.revision_json) as RevisionFields;
      out.push({
        jobId: row.job_id,
        chainJob: chainJobOf(row),
        manifest: JSON.parse(row.manifest_json) as unknown,
        expiredAt: terms.expiredAt,
        revisionHash: row.revision_hash,
        outputs: fields.outputs,
      });
    }
    return c.json({ assignments: out });
  };

  /**
   * GET /v1/jobs/:id/submission (public, T11). From indexed hook events only, so every value is chain-confirmed:
   * ProofAccepted is emitted inside the core's submit transaction (its tx is the submit tx), and KeyReleased
   * carries the released key, which is public from then on. The buyer reads the envelope from the submit
   * calldata, checks sha256(envelope) == envelopeHash and the key against keyCommitment, then decrypts.
   */
  const submission: Handler<AppEnv> = async (c) => {
    const { job } = loadJob(c.req.param("id") ?? "");
    const link = linkRow(deps, job.id);
    if (!link) throw new ApiError("not_found", `Job ${job.id} is not linked to a chain job`);
    const selection = q.selection.get(job.id) as SelectionRow | undefined;
    if (!selection) throw new Error(`job ${job.id} is linked but has no selection row`);
    const hook = lower((JSON.parse(selection.funding_terms_json) as FundingTerms).hook);
    const hookEvent = (...names: string[]) =>
      deps.db
        .prepare(
          `SELECT tx_hash, args_json FROM events WHERE chain_id = ? AND address = ? AND job_id = ? AND contract = 'hook'
             AND name IN (${names.map(() => "?").join(", ")})
           ORDER BY block DESC, log_index DESC LIMIT 1`,
        )
        .get(link.chain_id, hook, link.chain_job_id, ...names) as { tx_hash: string; args_json: string } | undefined;
    // ProofAccepted is Nick's SettlementHook; SubmissionAccepted is the SIMULATED stub's name for the same event.
    const accepted = hookEvent("ProofAccepted", "SubmissionAccepted");
    const released = hookEvent("KeyReleased");
    const a = accepted ? (JSON.parse(accepted.args_json) as Record<string, string>) : null;
    const r = released ? (JSON.parse(released.args_json) as Record<string, string>) : null;
    const { status, source } = await chainStatus(deps, link);
    return c.json({
      jobId: job.id,
      chainJob: chainJobOf(link),
      status,
      statusSource: source,
      submitTx: accepted?.tx_hash ?? null,
      envelopeHash: a?.envelopeHash ?? null,
      keyCommitment: a?.keyCommitment ?? null,
      releaseTx: released?.tx_hash ?? null,
      key: r?.key ?? null,
    });
  };

  app.get("/v1/jobs", readBody, feed);
  app.get("/v1/assignments", readBody, provider, assignments);
  app.post("/v1/jobs/:id/quotes", readBody, provider, parseJson, requireJobId, idem.middleware, postQuote);
  app.post("/v1/jobs/:id/select-quote", readBody, buyer, parseJson, requireJobId, owned, idem.middleware, selectQuote);
  app.post("/v1/jobs/:id/funding-receipt", readBody, buyer, parseJson, requireJobId, owned, idem.middleware, fundingReceipt);
  app.get("/v1/jobs/:id/submission", readBody, requireJobId, submission);
}
