import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeBundle } from "../../sdk/src/codec/bundle.ts";
import { referenceHash } from "../../sdk/src/codec/crypto.ts";

const source = new URL("../../../docs/fresh-exchange-input/", import.meta.url);
const output = process.argv[2];
const read = (name) => readFileSync(new URL(name, source));
const writeJson = (name, value) => writeFileSync(join(output, name), JSON.stringify(value) + "\n");

mkdirSync(join(output, "reference"), { recursive: true });
for (const name of ["request.md", "outputs.json", "reference/dataset.json", "oracle.py"]) {
  copyFileSync(new URL(name, source), join(output, name));
}

const plan = JSON.parse(read("plan.json"));
const referenceDigest = referenceHash(encodeBundle([
  { name: "dataset.json", content: read("reference/dataset.json") },
]));
writeJson("revision.json", {
  plan, referenceDigest, outputs: [{ name: "schedule.json", format: "json" }],
  expirySeconds: 43200, maxBudget: "10000",
});

const passing = JSON.parse(read("candidates/valid/schedule.json"));
const failing = structuredClone(passing);
failing.charges.find(({ release_id }) => release_id === "R-NORTH").kiln_id = "K-05";
const examples = [
  { name: "pass", predictedVerdict: 1, schedule: passing },
  { name: "kiln-over-capacity", predictedVerdict: 0, schedule: failing },
].map(({ name, predictedVerdict, schedule }) => ({
  name, predictedVerdict, files: [{ name: "schedule.json", content: JSON.stringify(schedule) }],
}));

const request = read("request.md").toString("utf8").split("\n")
  .filter((line) => /^\d+\. /.test(line)).join("\n");
writeJson("review.json", { request, examples });
