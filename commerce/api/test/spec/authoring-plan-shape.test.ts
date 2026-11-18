import { describe, expect, it } from "vitest";
import { removeProvenDuplicateScalars } from "../../src/authoring-plan-shape.ts";

const fixture = (value: unknown) => [{ name: "positive", predictedVerdict: 1 as const,
  files: [{ name: "out.json", content: JSON.stringify(value), encoding: "utf8" as const }] }];
const plan = (rules: unknown[] = []) => ({ version: 1, deliverables: [{ name: "out.json", parser: "json/v1",
  fields: [{ name: "rows", type: "string" }], collections: [{ name: "rows", fields: [{ name: "id", type: "string" }] }] }],
  references: [], rules });

describe("fixture-proven duplicate scalar", () => {
  it("removes a scalar rows field when the buyer fixture shows an array", () => {
    const original = plan();
    const result = removeProvenDuplicateScalars(original, fixture({ rows: [{ id: "x" }] }));
    expect(result.paths).toEqual(["/deliverables/0/fields/0"]);
    expect((result.plan as typeof original).deliverables[0]!.fields).toEqual([]);
    expect(original.deliverables[0]!.fields).toHaveLength(1);
  });
  it("does not choose a shape without an array in the buyer fixture", () => {
    const original = plan();
    expect(removeProvenDuplicateScalars(original, fixture({ rows: "x" })).paths).toEqual([]);
    expect(removeProvenDuplicateScalars(original, []).paths).toEqual([]);
  });
  it("does not remove a scalar used by a rule", () => {
    const original = plan([{ op: "eq", left: { op: "field", source: "deliverable", file: "out.json", field: "rows" }, right: { op: "literal", type: "string", value: "x" } }]);
    expect(removeProvenDuplicateScalars(original, fixture({ rows: [] })).paths).toEqual([]);
  });
  it("removes a reference duplicate only when the supplied reference has an array", () => {
    const original = { ...plan(), references: [{ name: "ref.json", parser: "json/v1",
      fields: [{ name: "rows", type: "string" }], collections: [{ name: "rows", fields: [{ name: "id", type: "string" }] }] }] };
    const result = removeProvenDuplicateScalars(original, fixture({ rows: [] }), [{ name: "ref.json", text: '{"rows":[]}' }]);
    expect(result.paths).toEqual(["/deliverables/0/fields/0", "/references/0/fields/0"]);
    expect((result.plan as typeof original).references[0]!.fields).toEqual([]);
    expect(removeProvenDuplicateScalars(original, fixture({ rows: [] }), [{ name: "ref.json", text: '{"rows":"x"}' }]).paths)
      .toEqual(["/deliverables/0/fields/0"]);
  });
});
