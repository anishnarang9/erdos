// Public landing + proof lab (product-plan.md §D Layout 1, §E, §F). The lab is SIMULATION ONLY: it imports no API,
// chain or signer module. Real evidence lives in its own section, linked to Arc testnet receipts.
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProofChamber, type Flow, type GateState } from "../chamber/ProofChamber";
import { allPass, DELIVERIES, LEDGER, runChecks, type Check } from "../lib/lab";
import { Wordmark } from "../components/Wordmark";

type Phase = "idle" | "running" | "done";
const tx = (h: string) => `https://explorer.testnet.arc.io/tx/${h}`;

export function Landing() {
  const [key, setKey] = useState(DELIVERIES[0]!.key);
  const [phase, setPhase] = useState<Phase>("idle");
  const [resetKey, setResetKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const delivery = DELIVERIES.find((d) => d.key === key)!;
  const checks = useMemo(() => runChecks(delivery), [delivery]);
  const pass = allPass(checks);

  useEffect(() => () => clearTimeout(timer.current), []);
  const choose = (k: string) => {
    clearTimeout(timer.current);
    setKey(k);
    setPhase("idle");
    setResetKey((n) => n + 1);
  };
  const run = () => {
    clearTimeout(timer.current);
    setResetKey((n) => n + 1);
    setPhase("running");
    timer.current = setTimeout(() => setPhase("done"), 1500);
  };

  const gate: GateState = phase === "done" ? (pass ? "open" : "rejected") : "locked";
  const flow: Flow = phase === "idle" ? "rest" : "push";
  const status =
    phase === "idle" ? { tone: "idle" as const, text: "Waiting for your experiment" }
    : phase === "running" ? { tone: "busy" as const, text: "Running the three checks…" }
    : pass ? { tone: "pass" as const, text: "All checks pass · gate opens (simulated)" }
    : { tone: "fail" as const, text: "Failed check · escrow remains locked" };
  const heading = phase !== "done" ? "The rules decide." : pass ? "Every check passed." : "One rule is enough.";
  const shown = (c: Check) => (phase === "done" ? c.result : "wait");

  return (
    <div className="site">
      <header className="site-header">
        <Wordmark />
        <span className="eyebrow" style={{ marginLeft: 8 }}>Proof-gated work</span>
        <nav aria-label="Primary">
          <a href="#experiment">The experiment</a>
          <a href="#use-cases">Use cases</a>
          <a href="#evidence">Evidence</a>
          <a href="#/app">Live workspace</a>
        </nav>
        <span className="mode-chip" title="This page's chamber is an illustration"><i aria-hidden />Simulation</span>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div>
            <div className="eyebrow">Verifiable work. Conditional payment.</div>
            <h1 id="hero-title"><span className="line">Good work.</span><em>Proven.</em></h1>
            <p className="promise">Define what done means.<br />Pay when the checks pass.</p>
            <p className="lede">Commission a data deliverable with explicit acceptance checks. A solver does the work. A zero-knowledge proof shows the committed files pass the approved checker. Escrow on Arc releases the payment and the delivery key together.</p>
            <a className="cta" href="#lab" onClick={() => choose("one-cent")}>Try changing just one cent <span aria-hidden>↗</span></a>
            <p className="note"><span aria-hidden>↳</span><span>Built for agents today.<br />Human-prepared files are eligible; that adapter is next.</span></p>
          </div>

          <div className="chamber-card" id="lab" aria-labelledby="lab-title">
            <div className="chamber-head">
              <div>
                <div className="eyebrow">01 / The proof chamber</div>
                <motion.h2 id="lab-title" key={heading} initial={{ opacity: 0.4, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
                  {heading}
                </motion.h2>
              </div>
              <span className="spacer" />
              <button className="ghost" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>{paused ? "Resume motion" : "Pause motion"}</button>
            </div>
            <ProofChamber
              gate={gate}
              flow={flow}
              resetKey={resetKey}
              paused={paused}
              status={status}
              left={{ title: "Delivery", sub: "Public sample data" }}
              right={{ title: "Acceptance", sub: gate === "open" ? "Gate open" : "Gate locked" }}
              hint="Physics ≠ verification"
            />
            <div className="chamber-controls">
              <div className="row">
                <div style={{ flex: 1 }}>
                  <label htmlFor="delivery">Choose a delivery</label>
                  <select id="delivery" value={key} onChange={(e) => choose(e.target.value)}>
                    {DELIVERIES.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </div>
                <button onClick={run} disabled={phase === "running"} style={{ padding: "16px 22px", fontSize: 16 }}>
                  {phase === "running" ? "Checking…" : "Run checks"} <span aria-hidden style={{ marginLeft: 22 }}>↗</span>
                </button>
              </div>
              <p className="fine">Interactive illustration · no proof generated · no payment sent · drag the glyphs to feel the resistance</p>
            </div>
          </div>
        </section>

        <div className="strip" aria-label="Simulated result">
          <section aria-labelledby="deliv-title">
            <header><span className="eyebrow" id="deliv-title">The deliverable</span><small>result.json + report.txt</small></header>
            <table>
              <thead><tr><th>Record</th><th className="num">Expected</th><th className="num">Delivered</th></tr></thead>
              <tbody>
                {LEDGER.map((r) => {
                  const got = delivery.rows.find((x) => x.id === r.id);
                  const bad = got?.amountCents !== r.amountCents;
                  return (
                    <tr key={r.id}>
                      <td>{r.id}</td>
                      <td className="num">{r.amountCents.toLocaleString("en-US")}¢</td>
                      <td className={`num ${bad ? "bad" : ""}`}>{got ? `${got.amountCents.toLocaleString("en-US")}¢` : "missing"}</td>
                    </tr>
                  );
                })}
                <tr><td>report.txt</td><td className="num" style={{ fontFamily: "var(--sans)" }}>Present</td><td className={`num ${delivery.report ? "" : "bad"}`} style={{ fontFamily: "var(--sans)" }}>{delivery.report ? "nonempty" : "empty"}</td></tr>
              </tbody>
            </table>
          </section>
          <section aria-labelledby="checks-title">
            <header><span className="eyebrow" id="checks-title">The agreed checks</span><small>Not a quality score</small></header>
            <ul className="checks">
              {checks.map((c) => {
                const s = shown(c);
                return (
                  <li key={c.key} className={s}>
                    <span className="mark" aria-hidden>{s === "pass" ? "✓" : s === "fail" ? "✕" : "○"}</span>
                    <span>{c.label}{s === "fail" && <span className="dim" style={{ display: "block", fontSize: 13 }}>{c.detail}</span>}</span>
                    <small>{s === "pass" ? "Pass" : s === "fail" ? "Fail" : "Waiting"}</small>
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-labelledby="escrow-title">
            <header><span className="eyebrow" id="escrow-title">Simulated escrow</span></header>
            <div className="escrow-amount">0.01<small>test USDC</small></div>
            <p style={{ font: "500 18px/1.4 var(--sans)", margin: "18px 0 6px" }}>
              {phase !== "done" ? "Payment stays locked." : pass ? "Simulated payout and key release." : "No simulated payout."}
            </p>
            <p className="dim" style={{ margin: 0, fontSize: 15 }}>
              {phase !== "done"
                ? "Select a delivery and run the checks. Only a passing result opens the gate in this illustration."
                : pass
                  ? "In the real flow, Arc's verifier accepts the proof and one transaction pays the solver and releases the key."
                  : "The failed delivery leaves escrow locked. In the real flow, preflight rejects the submission; a refund requires actual chain expiry."}
            </p>
          </section>
        </div>

        <section className="section" id="experiment" aria-labelledby="exp-title">
          <div>
            <div className="eyebrow">02 / Why one cent matters</div>
            <h2 id="exp-title">The checker doesn't <em>negotiate.</em></h2>
          </div>
          <div>
            <p>The buyer approves exact checks before any money moves: the same invoice ids, the same amounts, the same total, and a nonempty report. Those checks are compiled into a program. The solver runs that program over its encrypted delivery and produces a proof. If one amount is off by a cent, the program's verdict is a failure, and no valid proof of success can exist.</p>
            <p>The chamber above is an illustration of that rule. In the live system the proof is a real RISC Zero Groth16 receipt checked by a verifier contract on Arc testnet, and the payout and the delivery key are released by one transaction.</p>
            <dl className="facts">
              <div><dt>What is checked</dt><dd>Exactly the approved rules: ids, amounts, totals, required files. It is not a quality score or a judgment of the report's writing.</dd></div>
              <div><dt>What is trusted</dt><dd>The approved reference files, the compiled checker and the verifier contract. A proof does not show that the source data is true or current.</dd></div>
              <div><dt>Data visibility</dt><dd>Releasing the key makes the encrypted delivery public. Use public or shareable data only.</dd></div>
              <div><dt>Who can solve</dt><dd>Autonomous solvers today, selected by the buyer from quotes. Human-prepared files are eligible; the human adapter is next.</dd></div>
            </dl>
          </div>
        </section>

        <section className="section" id="use-cases" aria-labelledby="uc-title">
          <div>
            <div className="eyebrow">03 / Eligible work</div>
            <h2 id="uc-title">Repeatable, <em>machine-checkable</em> deliverables.</h2>
            <p>Classified by deliverable and readiness, not by who does the work.</p>
          </div>
          <div className="templates">
            <article><span className="ready now">Demo available</span><h3>Record reconciliation</h3><p>Exact ids, amounts and totals plus a nonempty report. The current fixture is deliberately simple.</p></article>
            <article><span className="ready pilot">Proposed pilot</span><h3>Catalog or schema conversion</h3><p>Fixed schema, identifiers, required fields and integrity rules. Needs a real customer fixture first.</p></article>
            <article><span className="ready pilot">Exploration</span><h3>Signed evidence bundles</h3><p>Signed inputs and named-file checks. Engine coverage is not yet a complete buyer template.</p></article>
            <article><span className="ready later">Later research</span><h3>Constraint and optimization output</h3><p>Feasibility checks do not establish optimality, so this stays off the main path until real.</p></article>
          </div>
        </section>

        <section className="section" id="evidence" aria-labelledby="ev-title">
          <div>
            <div className="eyebrow">04 / Real runs on Arc testnet</div>
            <h2 id="ev-title">Not a simulation <em>here.</em></h2>
            <p>Both jobs ran end to end from the buyer workspace on 16 Nov 2026: real proofs, real testnet USDC.</p>
            <a className="cta" href="#/app">Open the live workspace <span aria-hidden>↗</span></a>
          </div>
          <table className="receipts">
            <thead><tr><th>Job</th><th>What happened</th><th>Receipts</th></tr></thead>
            <tbody>
              <tr>
                <td className="mono">#3</td>
                <td>Correct delivery. Proof 147.7 s, 937,488 cycles, verdict 1. Arc's verifier accepted it; one transaction paid the solver and released the key; the browser recovered the files.</td>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>
                  <a href={tx("0x05693a09af7886d83b0c7cdac00b0bd134bfc471be76cc9e7b0abaa704abf76c")} target="_blank" rel="noreferrer">submit 0x0569…f76c ↗</a><br />
                  <a href={tx("0xb9caccce8c09ad659812fa12021f3728471caf202765a0e709cbea1c382b4956")} target="_blank" rel="noreferrer">release 0xb9ca…4956 ↗</a>
                </td>
              </tr>
              <tr>
                <td className="mono">#4</td>
                <td>A cheaper solver delivered one amount off by a cent. Verdict 0; the submit preflight reverted with VerificationFailed, so nothing was sent and nothing was paid. After expiry the buyer claimed the refund.</td>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>refund 0xcfaa…2540<br /><span className="faint">see commerce/evidence</span></td>
              </tr>
            </tbody>
          </table>
        </section>
      </main>

      <footer className="site-footer">
        <span>UBC 2026 · proof-gated payments on Arc testnet</span>
        <span className="spacer" />
        <span>Testnet only. No production funds.</span>
      </footer>
    </div>
  );
}
