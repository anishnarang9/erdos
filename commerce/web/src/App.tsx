// Routes (hash-based, no server config): #/ landing + simulated lab; #/app live workspace; #/job/<id> a linked job.
// Replay is entered from the workspace with the presenter keys and is always labelled.
import { useEffect, useState } from "react";
import { Landing } from "./pages/Landing";
import { Workspace } from "./pages/Workspace";

type Route = { page: "landing" } | { page: "app"; jobId: string | null };

function parse(hash: string): Route {
  const job = /^#\/job\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(hash);
  if (job) return { page: "app", jobId: job[1]! };
  if (hash.startsWith("#/app")) return { page: "app", jobId: null };
  return { page: "landing" };
}

export default function App() {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      const next = parse(location.hash);
      // In-page anchors (#experiment) keep the landing page.
      setRoute((cur) => (next.page === "landing" && cur.page === "landing" ? cur : next));
      if (next.page !== "landing" || location.hash === "" || location.hash === "#/") window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route.page === "app" ? <Workspace key={route.jobId ?? "new"} jobId={route.jobId} /> : <Landing />;
}
