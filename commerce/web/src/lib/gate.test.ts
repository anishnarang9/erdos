import { describe, expect, it } from "vitest";
import { project } from "./gate";
import { initialState, stageOf, type DemoState, type Stage } from "./store";

const ALL: Stage[] = ["request", "drafting", "clarify", "unsupported", "rules", "approved", "quoting", "selected", "funding", "funded", "proving", "proved", "rejected", "submitted", "paid", "decrypted", "refunded"];

describe("live gate projection", () => {
  it("opens the gate only after the release receipt", () => {
    for (const s of ALL) expect(project(s).gate === "open", s).toBe(s === "paid" || s === "decrypted");
  });
  it("an accepted proof alone does not open the gate", () => {
    expect(project("submitted")).toMatchObject({ gate: "accepted", tone: "busy" });
  });
  it("a rejection keeps the gate shut and never reads as paid", () => {
    expect(project("rejected")).toMatchObject({ gate: "rejected", tone: "fail" });
    expect(project("rejected").next).toContain("nothing sent");
  });
  it("proof events without chain data never reach a money stage", () => {
    const s: DemoState = { ...initialState, events: [
      { seq: 1, type: "proof.started", at: "", chainJobId: "3", data: {} },
      { seq: 2, type: "proof.finished", at: "", chainJobId: "3", data: { verdict: 1 } },
    ] };
    expect(stageOf(s)).toBe("proved");
    expect(project(stageOf(s)).gate).toBe("locked");
  });
});
