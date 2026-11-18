// Routes: the public landing is the static site in public/site (globe, solver robot, system layers, escrow coin).
// #/app is the live workspace; #/job/<id> opens a linked job. Replay is entered from the workspace and always labelled.
import { useEffect, useState } from "react";
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
    const on = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    if (route.page === "landing") location.replace("/site/index.html");
  }, [route]);
  if (route.page === "landing") return null;
  return <Workspace key={route.jobId ?? "new"} jobId={route.jobId} />;
}
