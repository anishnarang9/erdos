// T5 §3 recordingDraftModel / replayDraftModel — black-box.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordingDraftModel, replayDraftModel } from "../../src/index.ts";
import { OUTPUTS, clarReply, draftReply, fakeModel, hex, jcs, sha256Bytes } from "./helpers-t56.ts";
import type { DraftInput, SpecDraftModel } from "./helpers-t56.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ubc26-t5-rec-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const recording = (inner: SpecDraftModel, dir: string) =>
  recordingDraftModel(inner as never, dir) as unknown as SpecDraftModel;
const replay = (dir: string) => replayDraftModel(dir) as unknown as SpecDraftModel;

function input(request = "Count the words"): DraftInput {
  return { request, outputs: OUTPUTS, referenceNames: [], clarifications: [], schema: { type: "object" } };
}
/** record key = sha256(JCS(input)); the hex may or may not carry 0x (contract leaves it open). */
function keyHex(i: DraftInput): string {
  return hex(sha256Bytes(jcs(i))).slice(2);
}
function jsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

describe("recordingDraftModel", () => {
  it("passes the inner result through and writes one file named <sha256(JCS(input))>.json holding {input,result,model,traceId}", async () => {
    const dir = tmp();
    const inner = fakeModel(draftReply());
    const i = input();
    const out = await recording(inner, dir).draft(i);
    expect(out).toEqual(draftReply());
    expect(inner.calls).toEqual([i]);
    const files = jsonFiles(dir);
    expect(files.length).toBe(1);
    const k = keyHex(i);
    expect([`${k}.json`, `0x${k}.json`]).toContain(files[0]);
    const rec = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as Record<string, unknown>;
    expect(rec.input).toEqual(i);
    expect(rec.result).toEqual(draftReply().result);
    expect(rec.model).toBe(draftReply().model);
    expect(rec.traceId).toBe(draftReply().traceId);
  });

  it("key is over JCS, so key order in the input does not change the file name", async () => {
    const dir = tmp();
    const i = input();
    const reordered = {
      schema: i.schema,
      clarifications: i.clarifications,
      referenceNames: i.referenceNames,
      outputs: i.outputs,
      request: i.request,
    } as DraftInput;
    const rec = recording(fakeModel(draftReply()), dir);
    await rec.draft(i);
    await rec.draft(reordered);
    expect(jsonFiles(dir).length).toBe(1);
  });

  it("one file per distinct input", async () => {
    const dir = tmp();
    const rec = recording(fakeModel(draftReply()), dir);
    await rec.draft(input("one"));
    await rec.draft(input("two"));
    const names = jsonFiles(dir).map((f) => f.replace(/^0x/, ""));
    expect(names.sort()).toEqual([`${keyHex(input("one"))}.json`, `${keyHex(input("two"))}.json`].sort());
  });

  it("inner failure propagates and writes no recording", async () => {
    const dir = tmp();
    const inner = fakeModel(() => {
      throw new Error("boom");
    });
    await expect(recording(inner, dir).draft(input())).rejects.toThrow();
    expect(jsonFiles(dir).length).toBe(0);
  });
});

describe("replayDraftModel", () => {
  it("replays a recording exactly without any inner model", async () => {
    const dir = tmp();
    const i = input("replay me");
    await recording(fakeModel(clarReply(["x?"])), dir).draft(i);
    const out = await replay(dir).draft(structuredClone(i));
    expect(out).toEqual(clarReply(["x?"]));
  });

  it("no recording -> throws ModelError('no_recording')", async () => {
    const dir = tmp();
    let err: unknown;
    try {
      await replay(dir).draft(input("never recorded"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as Error & { code?: string };
    expect(e.code === "no_recording" || e.message.includes("no_recording"), `${e.message} / code=${e.code}`).toBe(true);
  });

  it("a recording for a different input is not used", async () => {
    const dir = tmp();
    await recording(fakeModel(draftReply()), dir).draft(input("A"));
    await expect(replay(dir).draft(input("B"))).rejects.toThrow();
  });
});
