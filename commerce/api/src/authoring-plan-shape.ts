import type { ExampleFixture } from "./authoring-examples.ts";
import { isPlainObject } from "./revision.ts";

function hasArray(text: string, fieldName: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) && Array.isArray(value[fieldName]);
  } catch { return false; }
}

function fixtureHasArray(fixture: ExampleFixture, fileName: string, fieldName: string): boolean {
  const file = fixture.files.find(item => item.name === fileName);
  if (!file) return false;
  try {
    const text = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    return hasArray(text, fieldName);
  } catch { return false; }
}

function referencesScalar(value: unknown, source: string, fileName: string, fieldName: string): boolean {
  if (Array.isArray(value)) return value.some(item => referencesScalar(item, source, fileName, fieldName));
  if (!isPlainObject(value)) return false;
  if (value.op === "field" && value.source === source && value.file === fileName && value.field === fieldName) return true;
  return Object.values(value).some(item => referencesScalar(item, source, fileName, fieldName));
}

/** Remove only duplicate scalars that buyer files prove are collection arrays. */
export function removeProvenDuplicateScalars(plan: unknown, fixtures: ExampleFixture[], references: { name: string; text: string }[] = []): { plan: unknown; paths: string[] } {
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
        ? fixtures.length > 0 && fixtures.every(fixture => fixtureHasArray(fixture, fileName, field.name as string))
        : references.some(reference => reference.name === fileName && hasArray(reference.text, field.name as string));
      if (!proven || referencesScalar(copy.rules, source, fileName, field.name)) return true;
      paths.push(`/${key}/${fileIndex}/fields/${index}`);
      return false;
    });
    });
  }
  return paths.length ? { plan: copy, paths } : { plan, paths };
}
