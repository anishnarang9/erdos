import { describe, expect, it } from "vitest";
import { allPass, DELIVERIES, runChecks } from "./lab";

const by = (key: string) => DELIVERIES.find((d) => d.key === key)!;

describe("lab simulation checks", () => {
  it("passes the correct delivery", () => {
    expect(allPass(runChecks(by("correct")))).toBe(true);
  });
  it("fails exactly the amount rule when one cent changes", () => {
    const r = runChecks(by("one-cent"));
    expect(r.map((c) => c.result)).toEqual(["pass", "fail", "pass"]);
    expect(r[1]!.detail).toContain("invoice-b");
  });
  it("fails ids (and therefore amounts) when an invoice is missing", () => {
    expect(runChecks(by("missing")).map((c) => c.result)).toEqual(["fail", "fail", "pass"]);
  });
  it("fails only the report rule for an empty report", () => {
    expect(runChecks(by("empty-report")).map((c) => c.result)).toEqual(["pass", "pass", "fail"]);
  });
  it("rejects duplicate ids", () => {
    const d = { key: "dup", label: "dup", rows: [{ id: "invoice-a", amountCents: 1000 }, { id: "invoice-a", amountCents: 2000 }], report: "x" };
    expect(runChecks(d)[0]!.result).toBe("fail");
  });
});
