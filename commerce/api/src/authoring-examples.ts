import type { BundleFile } from "@ubc26/sdk";
import { ApiError } from "./errors.ts";
import { checkHashable, isPlainObject } from "./revision.ts";
export interface ExampleFile { name: string; content: string; encoding?: "utf8" | "base64" }
export interface ExampleFixture {
  name: string; predictedVerdict: 0 | 1; files: ExampleFile[]; evidence?: ExampleFile[]; context?: string;
}
export type ModelExample = ExampleFixture | { name: string; predictedVerdict: 0 | 1; fixtureName: string };
export const MAX_EXAMPLES = 8;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const EXAMPLE_CONTEXT = /^0x01[0-9a-fA-F]{336}$/;
function invalid(path: string, message: string): never {
  throw new ApiError("validation_failed", "Request validation failed", { errors: [{ path, message }] });
}
/** Decode a complete protocol bundle before writing any example files. */
export function exampleFiles(input: unknown, maximum: number, path: string): BundleFile[] {
  if (!Array.isArray(input) || input.length > 16) invalid(path, "must contain at most 16 files");
  const files: BundleFile[] = [], seen = new Set<string>();
  let size = 3;
  for (const [i, raw] of input.entries()) {
    const at = `${path}/${i}`;
    if (!isPlainObject(raw)) invalid(at, "must be an example file");
    if (Object.keys(raw).some(key => !["name", "content", "encoding"].includes(key))) invalid(at, "unknown file field");
    if (typeof raw.name !== "string" || !NAME.test(raw.name) || raw.name === "." || raw.name === ".." || seen.has(raw.name.toLowerCase())) invalid(`${at}/name`, "unsafe or duplicate file name");
    seen.add(raw.name.toLowerCase());
    if (typeof raw.content !== "string" || raw.content.length > maximum * 2) invalid(`${at}/content`, "invalid or oversized example content");
    if (raw.encoding !== undefined && raw.encoding !== "utf8" && raw.encoding !== "base64") invalid(`${at}/encoding`, "must be utf8 or base64");
    if (checkHashable(raw.content, `${at}/content`).length) invalid(`${at}/content`, "invalid Unicode content");
    let content: Uint8Array;
    if (raw.encoding === "base64") {
      if (!BASE64.test(raw.content)) invalid(`${at}/content`, "must be standard padded base64");
      const bytes = Buffer.from(raw.content, "base64");
      if (bytes.toString("base64") !== raw.content) invalid(`${at}/content`, "base64 must be canonical");
      content = new Uint8Array(bytes);
    } else content = new TextEncoder().encode(raw.content);
    size += 6 + raw.name.length + content.byteLength;
    if (size > maximum) invalid(path, `encoded bundle exceeds ${maximum} bytes`);
    files.push({ name: raw.name, content });
  }
  return files;
}
/** Buyer fixtures stay immutable request data. Each bundle uses existing protocol limits. */
export function parseExampleFixtures(input: unknown, path = "/exampleFixtures"): ExampleFixture[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_EXAMPLES) invalid(path, `must contain at most ${MAX_EXAMPLES} examples`);
  const names = new Set<string>();
  return input.map((raw, i) => {
    const at = `${path}/${i}`;
    if (!isPlainObject(raw)) invalid(at, "must be an example fixture");
    if (Object.keys(raw).some(key => !["name", "predictedVerdict", "files", "evidence", "context"].includes(key))) invalid(at, "unknown example field");
    if (typeof raw.name !== "string" || !NAME.test(raw.name) || names.has(raw.name)) invalid(`${at}/name`, "invalid or duplicate example name");
    names.add(raw.name);
    if (raw.predictedVerdict !== 0 && raw.predictedVerdict !== 1) invalid(`${at}/predictedVerdict`, "must be 0 or 1");
    exampleFiles(raw.files, 16_384, `${at}/files`);
    if (raw.evidence !== undefined) exampleFiles(raw.evidence, 32_768, `${at}/evidence`);
    if (raw.context !== undefined && (typeof raw.context !== "string" || !EXAMPLE_CONTEXT.test(raw.context))) invalid(`${at}/context`, "must be exact version-1 context hex");
    return structuredClone(raw) as unknown as ExampleFixture;
  });
}
export function resolveExample(example: ModelExample, fixtures: ExampleFixture[]): ExampleFixture {
  if (!("fixtureName" in example)) return parseExampleFixtures([example], "/examples")[0]!;
  if (!NAME.test(example.name) || !NAME.test(example.fixtureName)) invalid("/examples", "invalid example or fixture name");
  const found = fixtures.find(item => item.name === example.fixtureName);
  if (!found) invalid("/examples/fixtureName", "unknown request fixture");
  if (found.predictedVerdict !== example.predictedVerdict) invalid("/examples/predictedVerdict", "label differs from the selected request fixture");
  return { ...structuredClone(found), name: example.name };
}
export interface ExampleLabel extends Record<string, unknown> {
  name: string; predictedVerdict: 0 | 1; checkerVerdict: 0 | 1 | null; agrees: boolean | null;
}
export function usableExamples(examples: ExampleLabel[]) {
  return {
    positive: examples.filter(item => item.checkerVerdict === 1 && item.agrees === true).length,
    negative: examples.filter(item => item.checkerVerdict === 0 && item.agrees === true).length,
    blocked: examples.some(item => item.checkerVerdict === null || item.agrees !== true),
  };
}
