import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeSubmit } from './measure-submit-calldata.mjs';

const [sdkDirectory, ...extra] = process.argv.slice(2);
assert.ok(sdkDirectory && !extra.length,
  'Usage: node --experimental-transform-types check-commerce-sdk.mjs COMMERCE_SDK_DIR');
const sdk = await import(pathToFileURL(join(resolve(sdkDirectory), 'src/index.ts')));
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const json = file => JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
const hex = bytes => '0x' + Buffer.from(bytes).toString('hex');
const bytes = value => Buffer.from(value.slice(2), 'hex');
const hash = value => hex(createHash('sha256').update(value).digest());

const vector = json('wire-v1.json');
const plaintext = sdk.decryptEnvelope(bytes(vector.envelope), bytes(vector.key), bytes(vector.context));
assert.equal(hex(plaintext), vector.bundle);
assert.equal(sdk.keyCommitment(bytes(vector.context), bytes(vector.key)), vector.keyCommitment);
assert.deepEqual(sdk.decodeBundle(plaintext).map(file => ({
  name: file.name,
  contents: hex(file.content),
})), vector.files);
const changedContext = bytes(vector.context);
changedContext[84] ^= 1;
assert.throws(() => sdk.decryptEnvelope(bytes(vector.envelope), bytes(vector.key), changedContext));

const cases = [
  { file: 'scalar-proof-pass-v1.json', verdict: 1 },
  { file: 'scalar-proof-fail-v1.json', verdict: 0 },
  { file: 'reconciliation/proof-pass-v1.json', verdict: 1,
    job: 'reconciliation/job.json', arc: 'reconciliation-state-override.json' },
  { file: 'reconciliation/proof-fail-v1.json', verdict: 0,
    job: 'reconciliation/job.json', arc: 'reconciliation-fail-state-override.json' },
  { file: 'signed-text/proof-pass-v1.json', verdict: 1,
    job: 'signed-text/job.json', arc: 'signed-text-state-override.json' },
  { file: 'limits/proof-pass-v1.json', verdict: 1,
    job: 'limits/job.json', arc: 'limits-state-override.json' },
];
const results = [];
for (const fixture of cases) {
  const proof = json(fixture.file);
  const parsed = sdk.parseProofJson(proof);
  const context = parsed.context;
  const journal = sdk.decodeJournal(parsed.journal);
  assert.equal(parsed.verdict, fixture.verdict);
  assert.equal(hex(sdk.encodeContext(context)), proof.context);
  assert.equal(journal.verdict, fixture.verdict);
  assert.deepEqual(journal.context, context);
  assert.equal(hex(sdk.encodeJournal(journal)), proof.journal);
  assert.equal(parsed.envelopeHash, hash(parsed.envelope));
  assert.equal(parsed.journalDigest, hash(parsed.journal));
  if (fixture.job) {
    assert.deepEqual(json(fixture.job), { context: proof.context, imageId: proof.imageId });
  }
  if (fixture.arc) {
    assert.equal(parsed.journalDigest, json('arc-rpc/' + fixture.arc).journalDigest);
  }
  const changedEnvelope = bytes(proof.envelope);
  changedEnvelope[12] ^= 1;
  assert.throws(() => sdk.parseProofJson({ ...proof, envelope: hex(changedEnvelope) }));
  const changedJournal = bytes(proof.journal);
  changedJournal[84] ^= 1;
  assert.throws(() => sdk.parseProofJson({ ...proof, journal: hex(changedJournal) }));

  // Capture the SDK's encoded call without contacting a chain or verifying a seal.
  let capturedCall;
  const client = {
    readContract: async ({ args }) => {
      assert.deepEqual(args, [context.jobId]);
      return { evaluator: context.escrow, hook: context.escrow, provider: context.provider };
    },
    call: async call => { capturedCall = call; },
  };
  const chain = sdk.createCommerceChain({
    chainId: Number(context.chainId),
    core: context.escrow,
    hook: context.escrow,
    usdc: context.escrow,
  }, { public: client });
  assert.deepEqual(await chain.preflightSubmit({
    jobId: context.jobId,
    envelope: parsed.envelope,
    seal: parsed.seal,
    keyCommitment: parsed.keyCommitment,
  }), { ok: true });
  const expected = encodeSubmit(proof, fixture.verdict);
  assert.equal(capturedCall.data, expected.data);
  assert.equal(capturedCall.to, context.escrow);
  assert.equal(capturedCall.account, context.provider);
  results.push({
    fixture: fixture.file,
    verdict: fixture.verdict,
    contextBytes: parsed.contextBytes.length,
    journalBytes: parsed.journal.length,
    envelopeBytes: parsed.envelope.length,
    sealBytes: bytes(parsed.seal).length,
    calldataBytes: bytes(capturedCall.data).length,
  });
}

console.log(JSON.stringify({ mode: 'offline_sdk_codec_and_call_capture', results }, null, 2));
