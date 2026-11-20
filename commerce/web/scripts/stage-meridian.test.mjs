import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

test("the deployed Meridian kit includes the accepted revision and valid review inputs", () => {
  const output = mkdtempSync(join(tmpdir(), "erdos-meridian-"));
  try {
    execFileSync(process.execPath, [
      fileURLToPath(new URL("stage-meridian.mjs", import.meta.url)), output,
    ]);
    const revision = JSON.parse(readFileSync(join(output, "revision.json"), "utf8"));
    const review = JSON.parse(readFileSync(join(output, "review.json"), "utf8"));
    assert.equal(revision.referenceDigest, "0x9c652686c37d6fd375c8b7f930eff54bdc7b67c1c23666f4eb3542f75bc30812");
    assert.equal(revision.plan.rules.length, 19);
    assert.equal(revision.maxBudget, "10000");
    assert.equal(review.request.split("\n").length, 13);
    assert.deepEqual(review.examples.map(example => example.predictedVerdict), [1, 0]);

    const packet = {
      version: 1, request: review.request, plan: revision.plan,
      revisionHash: revision.referenceDigest, referenceDigest: revision.referenceDigest,
      catalogDigest: revision.referenceDigest,
      exampleChecks: review.examples.map(({ name, predictedVerdict }) => ({ name, verdict: predictedVerdict })),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 16384);
    for (const example of review.examples) {
      const directory = mkdtempSync(join(tmpdir(), "erdos-schedule-"));
      try {
        writeFileSync(join(directory, "schedule.json"), example.files[0].content);
        const result = spawnSync("python3", [join(output, "oracle.py"), directory], { encoding: "utf8" });
        assert.equal(result.status, example.predictedVerdict === 1 ? 0 : 1, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout).errors, example.predictedVerdict === 1 ? [] : ["KILN"]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
