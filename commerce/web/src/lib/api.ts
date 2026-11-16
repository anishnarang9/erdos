// Buyer-side client for the commerce API (served same-origin through the Vite proxy).

const TOKEN_KEY = "ubc26.buyerToken";

export function getToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    // storage unavailable (private mode): the token lives for this page only
  }
  memoryToken = t;
}

let memoryToken = "";
const token = () => getToken() || memoryToken;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { ...headers };
  if (token()) h.authorization = `Bearer ${token()}`;
  if (method === "POST") {
    h["content-type"] = "application/json";
    h["idempotency-key"] ??= crypto.randomUUID();
  }
  const res = await fetch(path, { method, headers: h, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const e = (json.error ?? {}) as { code?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, e.code ?? "http_error", e.message ?? `HTTP ${res.status}`, e.details);
  }
  return json as T;
}

export type OutputFormat = "json" | "text" | "binary";
export interface Output {
  name: string;
  format: OutputFormat;
}
export interface Revision {
  plan: unknown;
  referenceDigest: string;
  outputs: Output[];
  expirySeconds: number;
  maxBudget: string;
}
export interface Example {
  name: string;
  predictedVerdict: 0 | 1;
  checkerVerdict: 0 | 1 | null;
  agrees: boolean | null;
  checkerError?: string;
}
export type DraftResponse =
  | {
      kind: "draft";
      draftId: string;
      revision: Revision;
      revisionHash: string;
      engine: { structureHash: string; rulesHash: string } | null;
      preview: { rules?: unknown[] } | null;
      examples: Example[];
      sourceQuotes: { path: string; quote: string }[];
      model: string;
      traceId: string;
    }
  | { kind: "clarification"; draftId: string; questions: string[]; round: number }
  | { kind: "unsupported"; draftId: string; reason: string; capabilityError?: { code: string; message: string; path?: string; request?: { kind: string; name: string } }; errors?: { path: string; message: string }[] };

export interface DraftRequest {
  request: string;
  outputs: Output[];
  references?: { name: string; contentBase64: string }[];
  clarifications?: { question: string; answer: string }[];
  expirySeconds: number;
  maxBudget: string;
}

export interface JobView {
  jobId: string;
  state: string;
  revision: { n: number; revisionHash: string; revision: Revision; source: string; createdAt: string; engine: { structureHash: string; rulesHash: string } | null };
  approval: { revisionHash: string; referenceDigest: string; rulesHash: string | null; structureHash: string | null; approvedAt: string } | null;
  manifest: { imageId: string; rulesHash: string; referenceHash: string; structureHash: string } | null;
  chain: { chainId: number; core: string; jobId: string; status: string; statusSource: string; fundTx: string } | null;
}

export interface Quote {
  quoteId: string;
  provider: string;
  price: string;
  validUntil: number;
  selectable: boolean;
  status: string;
}

export interface FundingTerms {
  chainId: number;
  core: string;
  hook: string;
  usdc: string;
  provider: string;
  budget: string;
  expiredAt: string;
  imageId: string;
  rulesHash: string;
  referenceHash: string;
  description: string;
}

export interface Submission {
  status: string;
  submitTx: string | null;
  envelopeHash: string | null;
  keyCommitment: string | null;
  releaseTx: string | null;
  key: string | null;
  chainJob: { chainId: number; core: string; jobId: string };
}

export const api = {
  health: () => call<{ ok: boolean }>("GET", "/healthz"),
  draft: (body: DraftRequest) => call<DraftResponse>("POST", "/v1/drafts", body),
  createJob: (revision: Revision, references: DraftRequest["references"], draftId?: string) =>
    call<{ jobId: string; revision: { revisionHash: string } }>("POST", "/v1/jobs", {
      revision,
      source: draftId ? "grok" : "import",
      ...(references && references.length > 0 ? { references } : {}),
      ...(draftId ? { draftId } : {}),
    }),
  job: (id: string) => call<JobView>("GET", `/v1/jobs/${id}`),
  approve: (id: string, revisionHash: string, referenceDigest: string, rulesHash?: string) =>
    call<{ state: string }>("POST", `/v1/jobs/${id}/approve`, { revisionHash, referenceDigest, ...(rulesHash ? { rulesHash } : {}) }, { "if-match": `"${revisionHash}"` }),
  compile: (id: string, revisionHash: string) =>
    call<{ state: string; manifest: JobView["manifest"]; packageUrl: string | null }>("POST", `/v1/jobs/${id}/compile`, { revisionHash }),
  quotes: (id: string) => call<{ quotes: Quote[] }>("GET", `/v1/jobs/${id}/quotes`),
  selectQuote: (id: string, quoteId: string, revisionHash: string) =>
    call<{ fundingTerms: FundingTerms }>("POST", `/v1/jobs/${id}/select-quote`, { quoteId, revisionHash }),
  fundingReceipt: (id: string, txHash: string) => call<{ chainJob: { jobId: string } }>("POST", `/v1/jobs/${id}/funding-receipt`, { txHash }),
  submission: (id: string) => call<Submission>("GET", `/v1/jobs/${id}/submission`),
  runEvents: (id: string, after: number) =>
    call<{ cursor: number; events: { seq: number; type: string; at: string; chainJobId: string | null; data: Record<string, unknown> }[] }>("GET", `/v1/demo/runs/${id}/events?after=${after}`),
  capabilities: () => call<{ enabled: boolean; poster?: string; maxBudgetPerJob?: string }>("GET", "/v1/demo/capabilities"),
  demoFund: (id: string) => call<{ opId: string; status: string }>("POST", `/v1/demo/jobs/${id}/fund`, {}),
  demoRefund: (id: string) => call<{ opId: string; status: string }>("POST", `/v1/demo/jobs/${id}/refund`, {}),
  op: (opId: string) => call<import("./store").OpView>("GET", `/v1/demo/ops/${opId}`),
};
