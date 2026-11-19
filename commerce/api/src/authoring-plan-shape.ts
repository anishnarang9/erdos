import type { ExampleFixture } from "./authoring-examples.ts";
import { isPlainObject } from "./revision.ts";
import canonicalize from "canonicalize";

function hasArray(text: string, fieldName: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) && Array.isArray(value[fieldName]);
  } catch { return false; }
}

function fixtureObject(fixture: ExampleFixture, fileName: string): Record<string, unknown> | null {
  const file = fixture.files.find(item => item.name === fileName);
  if (!file) return null;
  try {
    const text = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch { return null; }
}

function fixtureHasArray(fixture: ExampleFixture, fileName: string, fieldName: string): boolean {
  const file = fixture.files.find(item => item.name === fileName);
  if (!file) return false;
  try {
    const text = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    return hasArray(text, fieldName);
  } catch { return false; }
}

function contractHasArray(request: string, fileName: string, fieldName: string): boolean {
  const marker = "Output file contract: ";
  const start = request.indexOf(marker);
  if (start < 0 || (start > 0 && request.slice(start - 2, start) !== "\n\n") ||
    request.indexOf(marker, start + marker.length) >= 0) return false;
  const contract = request.slice(start + marker.length);
  if (contract.includes("\n")) return false;
  const declarations = [...contract.matchAll(/(?:^| )([A-Za-z0-9_.-]+): (JSON object|text file|binary file)\./g)];
  const at = declarations.findIndex(item => item[1] === fileName);
  if (at < 0 || declarations[at]![2] !== "JSON object") return false;
  const declaration = declarations[at]!;
  const section = contract.slice(declaration.index! + declaration[0].length,
    at + 1 < declarations.length ? declarations[at + 1]!.index : undefined);
  const scalar = section.match(/Scalar fields: ([^.]+)\./)?.[1] ?? "";
  if (scalar.split(",").some(item => item.trim().startsWith(`${fieldName}:`))) return false;
  return section.includes(`${fieldName} array of records with fields:`);
}

function referencesScalar(value: unknown, source: string, fileName: string, fieldName: string): boolean {
  if (Array.isArray(value)) return value.some(item => referencesScalar(item, source, fileName, fieldName));
  if (!isPlainObject(value)) return false;
  if (value.op === "field" && value.source === source && value.file === fileName && value.field === fieldName) return true;
  return Object.values(value).some(item => referencesScalar(item, source, fileName, fieldName));
}

/** Remove only duplicate scalars that buyer files prove are collection arrays. */
export function removeProvenDuplicateScalars(plan: unknown, fixtures: ExampleFixture[], references: { name: string; text: string }[] = [], buyerRequest = ""): { plan: unknown; paths: string[] } {
  if (!isPlainObject(plan)) return { plan, paths: [] };
  const copy = structuredClone(plan);
  const paths: string[] = [];
  for (const source of ["deliverable", "reference"] as const) {
    const key = source === "deliverable" ? "deliverables" : "references";
    const files = copy[key];
    if (!Array.isArray(files)) continue;
    files.forEach((file: unknown, fileIndex: number) => {
    if (!isPlainObject(file) || file.parser !== "json/v1" || typeof file.name !== "string" ||
      !Array.isArray(file.fields) || !Array.isArray(file.collections)) return;
    const fileName = file.name;
    const collectionNames = new Set(file.collections.filter((item): item is Record<string, unknown> =>
      isPlainObject(item) && typeof item.name === "string" && Array.isArray(item.fields) && item.fields.length > 0).map(item => item.name));
    file.fields = file.fields.filter((field: unknown, index: number) => {
      if (!isPlainObject(field) || typeof field.name !== "string" || !collectionNames.has(field.name)) return true;
      const proven = source === "deliverable"
        ? fixtures.length > 0
          ? fixtures.every(fixture => fixtureHasArray(fixture, fileName, field.name as string))
          : contractHasArray(buyerRequest, fileName, field.name)
        : references.some(reference => reference.name === fileName && hasArray(reference.text, field.name as string));
      if (!proven || referencesScalar(copy.rules, source, fileName, field.name)) return true;
      paths.push(`/${key}/${fileIndex}/fields/${index}`);
      return false;
    });
    });
  }
  return paths.length ? { plan: copy, paths } : { plan, paths };
}

/** A required output scalar conflicts with an accepted buyer fixture that omits it. */
export function removeFixtureContradictedOutputScalars(plan: unknown, fixtures: ExampleFixture[]): { plan: unknown; paths: string[] } {
  const positive = fixtures.filter(item => item.predictedVerdict === 1);
  if (!isPlainObject(plan) || !Array.isArray(plan.deliverables) || positive.length === 0) return { plan, paths: [] };
  const copy = structuredClone(plan);
  const paths: string[] = [];
  (copy.deliverables as unknown[]).forEach((file: unknown, fileIndex: number) => {
    if (!isPlainObject(file) || file.parser !== "json/v1" || typeof file.name !== "string" || !Array.isArray(file.fields)) return;
    const fileName = file.name;
    const examples = positive.map(fixture => fixtureObject(fixture, fileName));
    if (examples.some(value => value === null)) return;
    file.fields = file.fields.filter((field: unknown, fieldIndex: number) => {
      if (!isPlainObject(field) || typeof field.name !== "string") return true;
      if (examples.some(value => Object.hasOwn(value!, field.name as string))) return true;
      if (referencesScalar(copy.rules, "deliverable", fileName, field.name)) return true;
      paths.push(`/deliverables/${fileIndex}/fields/${fieldIndex}`);
      return false;
    });
  });
  return paths.length ? { plan: copy, paths } : { plan, paths };
}

/** Repair a non-Boolean existence guard when another comparison reads the same reference row. */
export function removeRedundantNumericLookupGuard(plan: unknown): { plan: unknown; paths: string[] } {
  if (!isPlainObject(plan) || !Array.isArray(plan.rules) || !Array.isArray(plan.references)) return { plan, paths: [] };
  const copy = structuredClone(plan);
  const paths: string[] = [];
  const referenceLookupType = (value: unknown): unknown => {
    if (!isPlainObject(value) || value.op !== "lookup" || !isPlainObject(value.collection)) return undefined;
    const source = value.collection;
    if (source.source !== "reference" || typeof source.file !== "string" ||
      typeof source.field !== "string" || typeof value.valueField !== "string") return undefined;
    const file = (copy.references as unknown[]).find(item => isPlainObject(item) &&
      item.name === source.file && item.parser === "json/v1");
    if (!isPlainObject(file) || !Array.isArray(file.collections)) return undefined;
    const collection = file.collections.find((item: unknown) => isPlainObject(item) && item.name === source.field);
    if (!isPlainObject(collection) || !Array.isArray(collection.fields)) return undefined;
    const field = collection.fields.find((item: unknown) => isPlainObject(item) && item.name === value.valueField);
    return isPlainObject(field) ? field.type : undefined;
  };
  const numericReferenceLookup = (value: unknown) => referenceLookupType(value) === "i64";
  const sameExpression = (left: unknown, right: unknown): boolean =>
    canonicalize(left) !== undefined && canonicalize(left) === canonicalize(right);
  const comparisonOperands = (comparison: unknown): unknown[] =>
    isPlainObject(comparison) && ["eq", "lt", "lte", "gt", "gte"].includes(String(comparison.op))
      ? [comparison.left, comparison.right] : [];
  const replacement = (node: Record<string, unknown>): unknown => {
    if (node.op !== "and" || Object.keys(node).sort().join() !== "left,op,right") return null;
    for (const [guard, comparison] of [[node.left, node.right], [node.right, node.left]]) {
      if (numericReferenceLookup(guard) && comparisonOperands(comparison).some(operand => sameExpression(guard, operand))) return comparison;
    }
    return null;
  };
  const conjunctionCompares = (value: unknown, lookup: unknown): boolean => {
    if (!isPlainObject(value)) return false;
    if (value.op === "and" && Object.keys(value).sort().join() === "left,op,right") {
      return conjunctionCompares(value.left, lookup) || conjunctionCompares(value.right, lookup);
    }
    return comparisonOperands(value).some(operand => sameExpression(lookup, operand));
  };
  const fixNestedNumericGuard = (node: Record<string, unknown>, path: string): void => {
    if (node.op !== "and" || Object.keys(node).sort().join() !== "left,op,right") return;
    for (const [side, other] of [["left", "right"], ["right", "left"]] as const) {
      const guard = node[side];
      const comparison = node[other];
      if (!numericReferenceLookup(guard) || !isPlainObject(comparison) || comparison.op !== "and" ||
        !conjunctionCompares(comparison, guard)) continue;
      node[side] = { op: "eq", left: guard, right: guard };
      paths.push(`${path}/${side}`);
    }
  };
  const fixStringKeyGuard = (node: Record<string, unknown>, path: string): void => {
    if (node.op !== "and" || Object.keys(node).sort().join() !== "left,op,right") return;
    for (const [side, other] of [["left", "right"], ["right", "left"]] as const) {
      const guard = node[side];
      if (!isPlainObject(guard) || guard.valueField !== guard.keyField || !isPlainObject(guard.key) ||
        guard.key.op !== "record_field" || referenceLookupType(guard) !== "string") continue;
      const matches = comparisonOperands(node[other]).some(operand =>
        isPlainObject(operand) && operand.op === "lookup" &&
        sameExpression({ ...guard, valueField: operand.valueField }, operand));
      if (!matches) continue;
      node[side] = { op: "eq", left: guard, right: guard.key };
      paths.push(`${path}/${side}`);
    }
  };
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}/${index}`));
    if (!isPlainObject(value)) return value;
    const substitute = replacement(value);
    if (substitute) { paths.push(path); return visit(substitute, path); }
    fixNestedNumericGuard(value, path);
    fixStringKeyGuard(value, path);
    for (const [key, child] of Object.entries(value)) value[key] = visit(child, `${path}/${key}`);
    return value;
  };
  const rules = visit(copy.rules, "/rules") as unknown[];
  const comparisonLookups = new Set<string>();
  for (const rule of rules) {
    if (!isPlainObject(rule) || rule.op !== "all" || !isPlainObject(rule.collection)) continue;
    for (const operand of comparisonOperands(rule.where)) {
      if (numericReferenceLookup(operand)) comparisonLookups.add(canonicalize([rule.collection, operand])!);
    }
  }
  copy.rules = rules.map((rule, index) => {
    if (!isPlainObject(rule) || rule.op !== "all" || !isPlainObject(rule.collection) ||
      Object.keys(rule).sort().join() !== "collection,op,where") return rule;
    const collection = rule.collection;
    const typeGuard = (node: unknown, path: string): unknown => {
      if (numericReferenceLookup(node) && comparisonLookups.has(canonicalize([collection, node])!)) {
        // Keep the lookup's missing-key behavior and leave the sibling bound in place.
        paths.push(path);
        return { op: "eq", left: node, right: node };
      }
      if (!isPlainObject(node) || node.op !== "and" ||
        Object.keys(node).sort().join() !== "left,op,right") return node;
      return { ...node, left: typeGuard(node.left, `${path}/left`), right: typeGuard(node.right, `${path}/right`) };
    };
    return { ...rule, where: typeGuard(rule.where, `/rules/${index}/where`) };
  });
  return paths.length ? { plan: copy, paths } : { plan, paths };
}

/** Correct a reference field used numerically only when supplied bytes prove its i64 shape. */
export function correctNumericReferenceFields(plan: unknown, references: { name: string; text: string }[]): { plan: unknown; paths: string[] } {
  if (!isPlainObject(plan) || !Array.isArray(plan.references) || !Array.isArray(plan.rules)) return { plan, paths: [] };
  const copy = structuredClone(plan);
  const paths: string[] = [];
  const uses = (fileName: string, collectionName: string, fieldName: string): { numeric: number; other: number } => {
    const count = { numeric: 0, other: 0 };
    const visit = (value: unknown, parent: Record<string, unknown> | null): void => {
      if (Array.isArray(value)) { value.forEach(item => visit(item, parent)); return; }
      if (!isPlainObject(value)) return;
      if (value.op === "lookup" && isPlainObject(value.collection) && value.collection.source === "reference" &&
        value.collection.file === fileName && value.collection.field === collectionName && value.valueField === fieldName) {
        if (parent && ["lt", "lte", "gt", "gte"].includes(String(parent.op)) &&
          (parent.left === value || parent.right === value)) count.numeric++;
        else count.other++;
      }
      for (const child of Object.values(value)) visit(child, value);
    };
    visit(copy.rules, null);
    return count;
  };
  (copy.references as unknown[]).forEach((file, fileIndex) => {
    if (!isPlainObject(file) || file.parser !== "json/v1" || typeof file.name !== "string" ||
      !Array.isArray(file.collections) || references.filter(item => item.name === file.name).length !== 1) return;
    let contents: unknown;
    try { contents = JSON.parse(references.find(item => item.name === file.name)!.text); } catch { return; }
    if (!isPlainObject(contents)) return;
    file.collections.forEach((collection: unknown, collectionIndex: number) => {
      if (!isPlainObject(collection) || typeof collection.name !== "string" || !Array.isArray(collection.fields)) return;
      const rows = contents[collection.name];
      if (!Array.isArray(rows) || rows.length === 0) return;
      const fields = collection.fields;
      fields.forEach((field: unknown, fieldIndex: number) => {
        if (!isPlainObject(field) || field.type !== "string" || typeof field.name !== "string") return;
        if (fields.filter((item: unknown) => isPlainObject(item) && item.name === field.name).length !== 1) return;
        const count = uses(file.name as string, collection.name as string, field.name);
        if (count.numeric === 0 || count.other > 0) return;
        if (!rows.every(row => {
          if (!isPlainObject(row) || typeof row[field.name as string] !== "string") return false;
          const text = row[field.name as string] as string;
          if (!/^-?(0|[1-9][0-9]*)$/.test(text)) return false;
          const number = BigInt(text);
          return number >= -(1n << 63n) && number < (1n << 63n);
        })) return;
        field.type = "i64";
        paths.push(`/references/${fileIndex}/collections/${collectionIndex}/fields/${fieldIndex}/type`);
      });
    });
  });
  return paths.length ? { plan: copy, paths } : { plan, paths };
}

/** Honor an explicit reject clause for a plain per-row reference membership predicate. */
export function normalizeExplicitKeyRejection(
  plan: unknown, request: string, references: {name: string; text: string}[],
): {plan: unknown; paths: string[]} {
  if (!isPlainObject(plan) || !Array.isArray(plan.rules) ||
    !Array.isArray(plan.deliverables) || !Array.isArray(plan.references)) return {plan, paths: []};

  const clauses = [...request.matchAll(/(?:^|[.!?]\s+)Reject the input if a row in ([\w.-]+) uses an? (\w+) missing from ([\w.-]+)\.(?=\s|$)/g)];
  if (clauses.length === 0) return {plan, paths: []};

  const exact = (value: unknown, keys: string): value is Record<string, unknown> =>
    isPlainObject(value) && Object.keys(value).sort().join() === keys;
  const rowsOf = (files: unknown[], name: unknown, collectionName: unknown, key: unknown) => {
    const file = files.find(item => isPlainObject(item) && item.name === name);
    if (!isPlainObject(file) || !Array.isArray(file.collections) || file.collections.length !== 1) return false;
    const [collection] = file.collections;
    return isPlainObject(collection) && collection.name === collectionName && Array.isArray(collection.fields) &&
      collection.fields.some(item => isPlainObject(item) && item.name === key && item.type === "string");
  };
  const uniqueRows = (name: string, collection: string, key: string): boolean => {
    const file = references.find(item => item.name === name);
    if (!file) return false;
    try {
      const data: unknown = JSON.parse(file.text);
      if (!isPlainObject(data) || !Array.isArray(data[collection])) return false;
      const rows: unknown[] = data[collection];
      const keys = new Set<string>();
      for (const row of rows) {
        if (!isPlainObject(row) || typeof row[key] !== "string" || keys.has(row[key])) return false;
        keys.add(row[key]);
      }
      return true;
    } catch { return false; }
  };

  const paths: string[] = [];
  const deliverables: unknown[] = plan.deliverables;
  const referenceFiles: unknown[] = plan.references;
  const rules = plan.rules.map((rule, index) => {
    if (!exact(rule, "collection,op,where") || rule.op !== "all" || !exact(rule.collection, "field,file,source") ||
      rule.collection.source !== "deliverable" || !exact(rule.where, "collection,op,where") ||
      rule.where.op !== "any" || !exact(rule.where.collection, "field,file,source") ||
      rule.where.collection.source !== "reference" || !exact(rule.where.where, "left,op,right") ||
      rule.where.where.op !== "eq") return rule;

    const output = rule.collection, reference = rule.where.collection;
    const {left, right} = rule.where.where;
    if (!exact(left, "field,level,op") || !exact(right, "field,level,op") ||
      left.op !== "record_field" || right.op !== "record_field" ||
      left.field !== right.field || typeof left.field !== "string" ||
      !((left.level === 0 && right.level === 1) || (left.level === 1 && right.level === 0))) return rule;

    const key = left.field;
    if (typeof reference.file !== "string" || typeof reference.field !== "string" ||
      !clauses.some(([, file, field, ref]) => file === output.file && field === key && ref === reference.file) ||
      !rowsOf(deliverables, output.file, output.field, key) ||
      !rowsOf(referenceFiles, reference.file, reference.field, key) ||
      !uniqueRows(reference.file, reference.field, key)) return rule;

    const outputKey = {op: "record_field", field: key, level: 0};
    paths.push(`/rules/${index}/where`);
    return {...rule, where: {op: "eq", left: outputKey, right: {
      op: "lookup", collection: reference, keyField: key, valueField: key, key: outputKey,
    }}};
  });
  return paths.length ? {plan: {...plan, rules}, paths} : {plan, paths};
}
