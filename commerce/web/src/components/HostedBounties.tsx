import { useEffect, useState } from "react";
import { deployment, formatUsdc, publicClient } from "../lib/chain";

const completedExample = "01M7PT3BWKW58X4GT2N9EWZNGD";

interface OpenBounty {
  jobId: string;
  chainJobId: string;
  status: string;
  budget: string;
  evidenceMode: string;
}

interface BountyPage {
  jobs: OpenBounty[];
  nextCursor: string | null;
}

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export function HostedBounties({ jobId }: { jobId: string | null }) {
  const [page, setPage] = useState<BountyPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [arcReady, setArcReady] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    readJson<{ ok: boolean }>("/healthz", controller.signal).then(
      (result) => setApiReady(result.ok),
      () => { if (!controller.signal.aborted) setApiReady(false); },
    );
    publicClient.getChainId().then(
      (id) => { if (!controller.signal.aborted) setArcReady(id === deployment.chainId); },
      () => { if (!controller.signal.aborted) setArcReady(false); },
    );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: "10" });
    if (cursor) query.set("cursor", cursor);
    const result = jobId
      ? readJson<OpenBounty>(`/v1/open-jobs/${jobId}`, controller.signal).then((job) => ({ jobs: [job], nextCursor: null }))
      : readJson<BountyPage>(`/v1/open-jobs?${query}`, controller.signal);
    result.then(setPage, (err: Error) => {
      if (controller.signal.aborted) return;
      setError(err.message === "404" ? "This open bounty was not found." : "Open bounties are unavailable.");
    });
    return () => controller.abort();
  }, [cursor, jobId]);

  return (
    <section className="card" aria-labelledby="open-bounties">
      <h2 id="open-bounties">{jobId ? "Open bounty details" : "Open bounties"}</h2>
      <p className="dim" aria-live="polite">
        API {apiReady === null ? "checking" : apiReady ? "online" : "unavailable"} · Arc RPC {arcReady === null ? "checking" : arcReady ? "online" : "unavailable"}
      </p>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p role="status">Loading bounties…</p>}
      {page?.jobs.length === 0 && <p>No open bounties on this page.</p>}
      {page?.jobs.map((job) => (
        <p key={job.jobId}>
          {jobId ? <>Arc job #{job.chainJobId}</> : <a href={`/#/job/${job.jobId}`}>Arc job #{job.chainJobId}</a>}
          {" · "}{job.status}{" · "}{formatUsdc(job.budget)}
          {job.evidenceMode !== "arc" && " · Simulated evidence"}
        </p>
      ))}
      {page?.nextCursor && (
        <button className="ghost" onClick={() => { setCursor(page.nextCursor); setPage(null); }}>
          Next page
        </button>
      )}
      {jobId ? <a href="/#/app">All open bounties</a> : <a href={`/#/job/${completedExample}`}>View a completed Arc bounty</a>}
    </section>
  );
}
