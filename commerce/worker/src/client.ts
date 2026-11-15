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
  revision: { n: number; revisionHash: string; revision: { plan: unknown; outputs: { name: string; format: string }[] } };
  approval: { rulesHash: string | null; structureHash: string | null; referenceDigest: string } | null;
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
  const base = baseUrl.replace(/\/+$/, "");
  const get = async (path: string): Promise<Response> => {
    const res = await fetchImpl(base + path);
    if (!res.ok) throw new ApiClientError(res.status, `GET ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  };
  return {
    job: async (id: string) => (await (await get(`/v1/jobs/${id}`)).json()) as JobView,
    packageListing: async (id: string) => (await (await get(`/v1/jobs/${id}/package`)).json()) as PackageListing,
    packageFile: async (id: string, path: string) =>
      new Uint8Array(await (await get(`/v1/jobs/${id}/package/file?path=${encodeURIComponent(path)}`)).arrayBuffer()),
    references: async (id: string): Promise<{ referenceDigest: string; files: BundleFile[] }> => {
      const r = (await (await get(`/v1/jobs/${id}/references`)).json()) as { referenceDigest: string; files: { name: string; contentBase64: string }[] };
      return { referenceDigest: r.referenceDigest, files: r.files.map((f) => ({ name: f.name, content: new Uint8Array(Buffer.from(f.contentBase64, "base64")) })) };
    },
  };
}

export type ApiClient = ReturnType<typeof apiClient>;
