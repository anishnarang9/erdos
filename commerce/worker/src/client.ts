// Minimal client for the public API routes the worker needs.
import type { BundleFile } from "@ubc26/sdk";

export interface PackageListing {
  jobId: string;
  manifest: Record<string, unknown> & { imageId: string; rulesHash: string; referenceHash: string; structureHash: string };
  files: { path: string; size: number; sha256: string }[];
}

export interface JobView {
  jobId: string;
  state: string;
  /** Funded identity returned by the API; the worker cross-checks it against the chain. */
  chain?: { chainId: number; core: string; jobId: string } | null;
  revision: { n: number; revisionHash: string; revision: { plan: unknown; outputs: { name: string; format: string }[] } };
  approval: { revisionHash?: string; rulesHash: string | null; structureHash: string | null; referenceDigest: string } | null;
  manifest: PackageListing["manifest"] | null;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function apiClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") throw new Error("API base must be an HTTPS origin or local HTTP origin");
  const base = url.origin;
  const get = async (path: string): Promise<Response> => {
    const res = await fetchImpl(base + path, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { await res.body?.cancel(); throw new ApiClientError(res.status, `API request returned ${res.status}`); }
    return res;
  };
  const read = async (res: Response, maximum: number) => {
    const declared = res.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
      await res.body?.cancel(); throw new Error("API response exceeds byte limit");
    }
    const reader = res.body?.getReader(); if (!reader) throw new Error("API response body is missing");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) { await reader.cancel(); throw new Error("API response exceeds byte limit"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  };
  const json = async (path: string): Promise<unknown> => {
    const bytes = await read(await get(path), 4_194_304);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("API returned invalid JSON"); }
  };
  return {
    job: async (id: string) => (await json(`/v1/jobs/${encodeURIComponent(id)}`)) as JobView,
    packageListing: async (id: string) => (await json(`/v1/jobs/${encodeURIComponent(id)}/package`)) as PackageListing,
    packageFile: async (id: string, path: string) =>
      read(await get(`/v1/jobs/${encodeURIComponent(id)}/package/file?path=${encodeURIComponent(path)}`), 33_554_432),
    references: async (id: string): Promise<{ referenceDigest: string; files: BundleFile[] }> => {
      const r = (await json(`/v1/jobs/${encodeURIComponent(id)}/references`)) as { referenceDigest: string; files: { name: string; contentBase64: string }[] };
      return { referenceDigest: r.referenceDigest, files: r.files.map((f) => ({ name: f.name, content: new Uint8Array(Buffer.from(f.contentBase64, "base64")) })) };
    },
  };
}

export type ApiClient = ReturnType<typeof apiClient>;
