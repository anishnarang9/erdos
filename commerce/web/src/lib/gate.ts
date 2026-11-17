// Live projection: the single chain-derived Stage decides the chamber and the outcome header.
// Only "paid"/"decrypted" (release receipt confirmed) may open the gate; "submitted" shows the accepted indicator
// with payout still pending; a rejection never animates money (product-plan.md §F, §G).
import type { Flow, GateState } from "../chamber/ProofChamber";
import type { Stage } from "./store";

export interface Projection {
  gate: GateState;
  flow: Flow;
  tone: "idle" | "busy" | "pass" | "fail";
  outcome: string;
  next: string;
  status: string;
}

const P = (gate: GateState, flow: Flow, tone: Projection["tone"], outcome: string, next: string, status: string): Projection => ({ gate, flow, tone, outcome, next, status });

export function project(stage: Stage): Projection {
  switch (stage) {
    case "request": return P("idle", "rest", "idle", "Describe the deliverable", "Write the request, then draft the checks.", "No job yet");
    case "drafting": return P("idle", "rest", "busy", "Drafting the checks", "Grok drafts rules; the engine validates them.", "Drafting");
    case "clarify": return P("idle", "rest", "idle", "One detail is missing", "Answer the question to redraft.", "Waiting for the buyer");
    case "unsupported": return P("idle", "rest", "fail", "The engine can't check this yet", "Rephrase the request. No job was created.", "Not supported");
    case "rules": return P("idle", "rest", "idle", "Review the checks", "Approve the exact rules the payout depends on.", "Checks drafted");
    case "approved": return P("idle", "rest", "busy", "Compiling the checker", "The approved rules become the proving program.", "Compiling");
    case "quoting": return P("idle", "rest", "idle", "Awaiting quotes", "Select a solver's quote.", "Waiting for quotes");
    case "selected": return P("locked", "rest", "idle", "Ready to fund", "Fund the escrow on Arc.", "Quote selected");
    case "funding": return P("locked", "rest", "busy", "Funding on Arc", "Create, budget, approve, fund: confirmed one by one.", "Funding");
    case "funded": return P("locked", "rest", "idle", "Funded · escrow locked", "The solver is producing the files.", "Escrow locked");
    case "proving": return P("locked", "agitate", "busy", "Producing and proving", "The proof runs locally; no progress percentage exists.", "Proving");
    case "proved": return P("locked", "push", "busy", "Proof ready", "Submission to Arc is pending.", "Proof ready · submission pending");
    case "submitted": return P("accepted", "push", "busy", "Proof accepted · release pending", "Payout and key release in one transaction.", "Accepted · payout pending");
    case "paid": return P("open", "push", "pass", "Paid · key released", "Recovering the files from public chain data.", "Released");
    case "decrypted": return P("open", "push", "pass", "Delivery recovered", "The files match the accepted proof.", "Released · files recovered");
    case "rejected": return P("rejected", "push", "fail", "Check failed · escrow locked", "Preflight rejected, nothing sent. Refund opens after expiry.", "Failed check · escrow remains locked");
    case "refunded": return P("rejected", "rest", "fail", "Refunded to the buyer", "The deadline passed; the budget returned on chain.", "Refunded");
  }
}
