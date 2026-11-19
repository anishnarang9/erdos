import { normalizeExplicitKeyRejection } from "../../src/authoring-plan-shape.ts";

import { describe, expect, it } from "vitest";
import { removeProvenDuplicateScalars, removeFixtureContradictedOutputScalars, removeRedundantNumericLookupGuard, correctNumericReferenceFields } from "../../src/authoring-plan-shape.ts";

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
  it("uses an explicit buyer output contract when no fixture exists", () => {
    const original = plan();
    const contract = "Check output.\n\nOutput file contract: out.json: JSON object. rows array of records with fields: id: string.";
    const result = removeProvenDuplicateScalars(original, [], [], contract);
    expect(result.paths).toEqual(["/deliverables/0/fields/0"]);
    expect((result.plan as typeof original).deliverables[0]!.fields).toEqual([]);
  });
  it("does not infer an array from another file or an incomplete contract", () => {
    const original = plan();
    const other = "Output file contract: other.json: JSON object. rows array of records with fields: id: string. out.json: JSON object.";
    const scalar = "Output file contract: out.json: JSON object. Scalar fields: rows: string.";
    expect(removeProvenDuplicateScalars(original, [], [], other).paths).toEqual([]);
    expect(removeProvenDuplicateScalars(original, [], [], scalar).paths).toEqual([]);
    expect(removeProvenDuplicateScalars(original, [], [], "rows array of records").paths).toEqual([]);
  });
  it("does not let contract prose override a conflicting buyer fixture or a rule read", () => {
    const contract = "Output file contract: out.json: JSON object. rows array of records with fields: id: string.";
    expect(removeProvenDuplicateScalars(plan(), fixture({ rows: "x" }), [], contract).paths).toEqual([]);
    const used = plan([{ op: "field", source: "deliverable", file: "out.json", field: "rows" }]);
    expect(removeProvenDuplicateScalars(used, [], [], contract).paths).toEqual([]);
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

describe("redundant numeric lookup guard", () => {
  const lookup = { op: "lookup", collection: { source: "reference", file: "lots.json", field: "rows" },
    keyField: "lotId", key: { op: "record_field", field: "lotId", level: 0 }, valueField: "maxDay" };
  const compare = { op: "lte", left: { op: "record_field", field: "expiryDay", level: 0 }, right: lookup };
  const withRule = (rule: unknown, type = "i64") => ({ ...plan([rule]), references: [{ name: "lots.json", parser: "json/v1",
    fields: [], collections: [{ name: "rows", fields: [{ name: "lotId", type: "string" }, { name: "maxDay", type }] }] }] });

  it("removes only the duplicate numeric lookup while retaining the typed comparison", () => {
    const original = withRule({ op: "all", collection: { source: "deliverable", file: "out.json", field: "rows" },
      where: { op: "and", left: lookup, right: compare } });
    const result = removeRedundantNumericLookupGuard(original);
    expect(result.paths).toEqual(["/rules/0/where"]);
    expect((result.plan as typeof original).rules[0]).toMatchObject({ where: compare });
    expect((original.rules[0] as any).where.op).toBe("and");
  });

  it("keeps a guard if the comparison does not read the same lookup", () => {
    const different = { ...lookup, valueField: "otherDay" };
    expect(removeRedundantNumericLookupGuard(withRule({ op: "and", left: lookup,
      right: { ...compare, right: different } })).paths).toEqual([]);
  });

  it("types a nested numeric guard without discarding the surrounding checks", () => {
    const minimum = { op: "gte", left: compare.left, right: { op: "literal", type: "i64", value: "0" } };
    const bounds = { op: "and", left: minimum, right: compare };
    const original = withRule({ op: "and", left: bounds, right: lookup });
    const result = removeRedundantNumericLookupGuard(original);
    expect(result.paths).toEqual(["/rules/0/right"]);
    expect(result.plan).toMatchObject({rules: [
      { op: "and", left: bounds, right: { op: "eq", left: lookup, right: lookup } },
    ]});
  });

  it("types a reference key guard beside a comparison that reads the same row", () => {
    const guard = { ...lookup, valueField: lookup.keyField };
    const original = withRule({ op: "and", left: guard, right: compare });
    const result = removeRedundantNumericLookupGuard(original);
    expect(result.paths).toEqual(["/rules/0/left"]);
    expect(result.plan).toMatchObject({ rules: [{
      op: "and", left: { op: "eq", left: guard, right: guard.key }, right: compare,
    }] });
  });

  it("does not change a reference key guard that looks up a different row", () => {
    const guard = { ...lookup, valueField: lookup.keyField, key: { ...lookup.key, level: 1 } };
    expect(removeRedundantNumericLookupGuard(withRule({ op: "and", left: guard, right: compare })).paths).toEqual([]);
  });

  it("keeps a Boolean lookup and a comparison behind short-circuit logic", () => {
    expect(removeRedundantNumericLookupGuard(withRule({ op: "and", left: lookup, right: compare }, "bool")).paths).toEqual([]);
    expect(removeRedundantNumericLookupGuard(withRule({ op: "and", left: lookup,
      right: { op: "or", left: compare, right: { op: "literal", type: "bool", value: true } } })).paths).toEqual([]);
  });

  it("makes the standalone numeric guard Boolean without dropping any sibling rule or changing its index", () => {
    const collection = { source: "deliverable", file: "out.json", field: "rows" };
    const guard = { op: "all", collection, where: lookup };
    const comparison = { op: "all", collection, where: compare };
    const cap = { op: "literal", type: "bool", value: true };
    const original = { ...withRule(guard), rules: [guard, comparison, cap] };
    const result = removeRedundantNumericLookupGuard(original);
    expect(result.paths).toEqual(["/rules/0/where"]);
    expect(result.plan).toMatchObject({rules: [
      { ...guard, where: { op: "eq", left: lookup, right: lookup } }, comparison, cap,
    ]});
    expect(original.rules[0]).toEqual(guard);
  });

  it("types the saved receipt guard when a sibling all rule retains the same bound", () => {
    const collection = { source: "deliverable", file: "out.json", field: "rows" };
    const lowerBound = { op: "gte", left: { op: "record_field", field: "received", level: 0 },
      right: { op: "literal", type: "i64", value: "0" } };
    const rule = { op: "all", collection, where: { op: "and", left: lowerBound, right: lookup } };
    const bound = { op: "all", collection, where: compare };
    const result = removeRedundantNumericLookupGuard({ ...withRule(rule), rules: [rule, bound] });
    expect(result.paths).toEqual(["/rules/0/where/right"]);
    expect(result.plan).toMatchObject({ rules: [{ ...rule, where: {
      ...rule.where, right: { op: "eq", left: lookup, right: lookup },
    } }, bound] });

    const otherRows = { ...bound, collection: { ...collection, field: "otherRows" } };
    expect(removeRedundantNumericLookupGuard({ ...withRule(rule), rules: [rule, otherRows] }).paths).toEqual([]);
  });

  it("keeps a standalone guard when a comparison runs over another collection", () => {
    const collection = { source: "deliverable", file: "out.json", field: "rows" };
    const guard = { op: "all", collection, where: lookup };
    const comparison = { op: "all", collection: { ...collection, field: "otherRows" }, where: compare };
    expect(removeRedundantNumericLookupGuard({ ...withRule(guard), rules: [guard, comparison] }).paths).toEqual([]);
  });
});

describe("reference-backed numeric fields", () => {
  const lookup = { op: "lookup", collection: { source: "reference", file: "posts.json", field: "rows" },
    keyField: "postId", key: { op: "record_field", field: "postId", level: 0 }, valueField: "required" };
  const original = () => ({ ...plan([{ op: "all", collection: { source: "deliverable", file: "out.json", field: "rows" },
    where: { op: "gte", left: { op: "record_field", field: "level", level: 0 }, right: lookup } }]),
    references: [{ name: "posts.json", parser: "json/v1", fields: [],
      collections: [{ name: "rows", fields: [{ name: "postId", type: "string" }, { name: "required", type: "string" }] }] }] });
  const supplied = (text: string) => [{ name: "posts.json", text }];

  it("corrects a numeric comparison only when every supplied reference value is an i64", () => {
    const input = original();
    const result = correctNumericReferenceFields(input, supplied('{"rows":[{"postId":"a","required":"2"},{"postId":"b","required":"4"}]}'));
    expect(result.paths).toEqual(["/references/0/collections/0/fields/1/type"]);
    expect((result.plan as typeof input).references[0]!.collections[0]!.fields[1]!.type).toBe("i64");
    expect(input.references[0]!.collections[0]!.fields[1]!.type).toBe("string");
  });

  it("keeps the declared type for mixed or out-of-range reference values", () => {
    expect(correctNumericReferenceFields(original(), supplied('{"rows":[{"postId":"a","required":"2"},{"postId":"b","required":"n/a"}]}')).paths).toEqual([]);
    expect(correctNumericReferenceFields(original(), supplied('{"rows":[{"postId":"a","required":"9223372036854775808"}]}')).paths).toEqual([]);
  });

  it("does not infer numeric meaning without a typed comparison", () => {
    const input = original();
    (input.rules[0] as { where: { op: string } }).where.op = "eq";
    expect(correctNumericReferenceFields(input, supplied('{"rows":[{"postId":"a","required":"2"}]}')).paths).toEqual([]);
  });
});

describe("buyer-positive output shape", () => {
  const withCapacity = (rules: unknown[] = []) => ({ version: 1, deliverables: [{ name: "out.json", parser: "json/v1",
    fields: [{ name: "capacity", type: "i64" }], collections: [{ name: "rows", fields: [{ name: "id", type: "string" }] }] }],
    references: [], rules });
  it("removes an unused required scalar omitted by every accepted fixture", () => {
    const original = withCapacity();
    const result = removeFixtureContradictedOutputScalars(original, fixture({ rows: [] }));
    expect(result.paths).toEqual(["/deliverables/0/fields/0"]);
    expect((result.plan as typeof original).deliverables[0]!.fields).toEqual([]);
    expect(original.deliverables[0]!.fields).toHaveLength(1);
  });
  it("keeps fields present in a positive fixture or read by a rule", () => {
    expect(removeFixtureContradictedOutputScalars(withCapacity(), fixture({ rows: [], capacity: "9" })).paths).toEqual([]);
    const used = withCapacity([{ op: "field", source: "deliverable", file: "out.json", field: "capacity" }]);
    expect(removeFixtureContradictedOutputScalars(used, fixture({ rows: [] })).paths).toEqual([]);
  });
  it("requires a complete positive fixture and ignores negative-only evidence", () => {
    const negative = fixture({ rows: [] }).map(item => ({ ...item, predictedVerdict: 0 as const }));
    expect(removeFixtureContradictedOutputScalars(withCapacity(), negative).paths).toEqual([]);
    expect(removeFixtureContradictedOutputScalars(withCapacity(), []).paths).toEqual([]);
  });
});

describe("explicit unknown key rejection", () => {
  const output = { source: "deliverable", file: "out.json", field: "rows" };
  const reference = { source: "reference", file: "ref.json", field: "rows" };
  const field = (level: number) => ({ op: "record_field", field: "id", level });
  const predicate = { op: "eq", left: field(0), right: field(1) };
  const rule = { op: "all", collection: output, where: { op: "any", collection: reference, where: predicate } };
  const source = {
    deliverables: [{name: output.file, collections: [{name: "rows", fields: [{name: "id", type: "string"}]}]}],
    references: [{name: reference.file, collections: [{name: "rows", fields: [{name: "id", type: "string"}]}]}],
    rules: [rule],
  };
  const brief = "Check the rows. Reject the input if a row in out.json uses a id missing from ref.json.";
  const refs = [{name: reference.file, text: '{"rows":[{"id":"known"}]}'}];

  it("normalizes only the membership predicate and preserves its rule index", () => {
    const repaired = normalizeExplicitKeyRejection(source, brief, refs);
    expect(repaired.paths).toEqual(["/rules/0/where"]);
    expect(repaired.plan).toMatchObject({rules: [{...rule, where: {op: "eq", left: field(0), right: {
      op: "lookup", collection: reference, keyField: "id", valueField: "id", key: field(0),
    }}}]});
    expect(source.rules[0]?.where.op).toBe("any");
  });

  it("leaves other briefs, nonunique reference keys, and extended predicates alone", () => {
    expect(normalizeExplicitKeyRejection(source, "Return verdict 0 for an unknown ID.", refs).paths).toEqual([]);
    expect(normalizeExplicitKeyRejection(source, brief, [{...refs[0]!, text: '{"rows":[{"id":"x"},{"id":"x"}]}'}]).paths).toEqual([]);
    const extended = {...source, rules: [{...rule, where: {...rule.where, where: {...predicate, op: "and"}}}]};
    expect(normalizeExplicitKeyRejection(extended, brief, refs).paths).toEqual([]);
  });
});
