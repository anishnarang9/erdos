import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toFunctionSelector, type AbiFunction, type Hex } from "viem";
import { buildContext, buildJournal, journalDigest, keyCommitment } from "./encode.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("open-claim exported ABI matches the published function signatures", () => {
  const abi = read("../abi/OpenClaimAdapter.json");
  const signatures = [
    "register(uint256,bytes32,bytes32,bytes32,uint256,uint64)",
    "claim(uint256,bytes,bytes,bytes32)",
    "release(uint256,bytes32)",
    "contextOf(uint256,address)",
    "expectedJournal(uint256,address,bytes32,bytes32)",
  ];
  for (const signature of signatures) {
    const name = signature.slice(0, signature.indexOf("("));
    const entry = abi.find((item: AbiFunction) => item.type === "function" && item.name === name);
    assert.ok(entry, signature);
    assert.equal(toFunctionSelector(entry), toFunctionSelector(signature));
  }
  const terms = abi.find((item: AbiFunction) => item.type === "function" && item.name === "terms");
  assert.deepEqual(terms.outputs.map((item: { type: string }) => item.type),
    ["address", "bytes32", "bytes32", "bytes32", "uint256", "uint64", "bool"]);
  const submissions = abi.find((item: AbiFunction) => item.type === "function" && item.name === "submissions");
  assert.deepEqual(submissions.outputs.map((item: { type: string }) => item.type),
    ["address", "bytes32", "bytes32", "bool"]);
});

test("open-claim manifest preserves frozen core pins and records no invented deployment", () => {
  const manifest = read("../deployments/open-claim-arc-testnet.template.json");
  const selected = read("../deployments/arc-testnet.json");
  assert.equal(manifest.status, "proposed-not-deployed");
  assert.equal(manifest.core.address, selected.contracts.core.address);
  assert.equal(manifest.core.implementation, selected.contracts.core.implementation);
  assert.equal(manifest.core.runtimeCodeHash, selected.contracts.core.runtimeCodeHash);
  assert.equal(manifest.verifier.runtimeCodeHash, selected.contracts.verifier.runtimeCodeHash);
  assert.equal(manifest.usdc.address, "0x3600000000000000000000000000000000000000");
  assert.equal(manifest.chainId, 5042002);
  assert.equal(manifest.policy.platformFeeBP, 0);
  assert.equal(manifest.policy.evaluatorFeeBP, 0);
  for (const field of ["address", "runtimeCodeHash", "deployTx", "deployBlock"]) {
    assert.equal(manifest.adapter[field], null);
  }
});

test("open-claim synthetic adapter-domain fixture reproduces key commitment and journal digest", () => {
  const vector = read("../../engine/fixtures/wire-v1.json");
  const context = buildContext(vector.contextFields);
  assert.equal(context, vector.context);
  assert.equal(keyCommitment(context, vector.key), vector.keyCommitment);
  assert.equal(journalDigest(buildJournal(context, 1, vector.envelopeHash, vector.keyCommitment)), vector.journalDigest);
  const otherSolver = buildContext({ ...vector.contextFields, provider: `0x${"23".repeat(20)}` as Hex });
  assert.notEqual(keyCommitment(otherSolver, vector.key), vector.keyCommitment);
});
