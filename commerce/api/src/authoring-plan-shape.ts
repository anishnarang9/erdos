import type { ExampleFixture } from "./authoring-examples.ts";
import { isPlainObject } from "./revision.ts";

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
