import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(file) {
  const raw = readFileSync(file);
  return { value: JSON.parse(raw), size: raw.length };
}

function isHex(value, bytes) {
  return typeof value === 'string'
    && value.length === 2 + 2 * bytes && /^0x[0-9a-f]+$/.test(value);
}

function nonnegativeInteger(value, name) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `Invalid ${name}`);
  return value;
}

function readBuild(directory, file, cacheHit) {
  const { value } = readJson(join(directory, file));
  assert.equal(value.version, 1, 'Unsupported compile report version');
  for (const field of ['imageId', 'rulesHash', 'referenceHash']) {
    assert.ok(isHex(value[field], 32), `Invalid compile report ${field}`);
  }
  assert.ok(
    typeof value.buildFingerprint === 'string'
      && value.buildFingerprint.length === 64 && /^[0-9a-f]+$/.test(value.buildFingerprint),
    'Invalid build fingerprint',
  );
  assert.equal(value.cacheHit, cacheHit, 'Unexpected cache status');
  return {
    value,
    timing: { compileMillis: nonnegativeInteger(value.compileMillis, 'compile time'), cacheHit },
  };
}

function readProof(directory, job, name, verdict) {
  const { value: run } = readJson(join(directory, `${name}.run.json`));
  const { value: proof, size: proofBytes } = readJson(join(directory, name, 'proof.json'));
  assert.equal(run.proofFile, 'proof.json', 'Unexpected proof filename');
  assert.equal(run.verdict, verdict, 'Run verdict differs from expected verdict');
  assert.equal(proof.verdict, verdict, 'Proof verdict differs from expected verdict');
  assert.equal(proof.version, 1, 'Unsupported proof version');
  assert.equal(proof.imageId, job.imageId, 'Proof image differs from job');
  assert.equal(proof.context, job.context, 'Proof context differs from job');
  assert.ok(isHex(proof.seal, 260) && proof.seal.startsWith('0xe71e6620'), 'Invalid seal format');
  const envelopeBytes = typeof proof.envelope === 'string' ? (proof.envelope.length - 2) / 2 : 0;
  assert.ok(Number.isInteger(envelopeBytes) && envelopeBytes >= 31
    && envelopeBytes <= 16_384 + 28 && isHex(proof.envelope, envelopeBytes), 'Invalid envelope');
  assert.ok(isHex(proof.keyCommitment, 32), 'Invalid key commitment');
  const envelopeHash = createHash('sha256').update(Buffer.from(proof.envelope.slice(2), 'hex')).digest('hex');
  const expectedJournal = proof.context + `0${verdict}` + envelopeHash + proof.keyCommitment.slice(2);
  assert.ok(proof.journal === expectedJournal, 'Journal does not match proof fields');
  return {
    verdict,
    proveMillis: nonnegativeInteger(run.proveMillis, 'proof time'),
    userCycles: nonnegativeInteger(run.userCycles, 'user cycles'),
    proofBytes,
    envelopeBytes,
    sealBytes: (proof.seal.length - 2) / 2,
  };
}

function reportFixture(directory, name) {
  const cold = readBuild(directory, 'manifest.json', false);
  const warm = readBuild(directory, 'warm.json', true);
  for (const field of ['imageId', 'buildFingerprint', 'rulesHash', 'referenceHash']) {
    assert.equal(cold.value[field], warm.value[field], `Cold and warm ${field} differ`);
  }
  const { value: job } = readJson(join(directory, 'job.json'));
  assert.equal(job.imageId, cold.value.imageId, 'Job image differs from compile report');
  assert.ok(isHex(job.context, 169) && job.context.startsWith('0x01'), 'Invalid job context');
  assert.equal(job.context.slice(212, 276), cold.value.rulesHash.slice(2), 'Rules commitment mismatch');
  assert.equal(job.context.slice(276), cold.value.referenceHash.slice(2), 'Reference commitment mismatch');
  const proofs = { pass: readProof(directory, job, 'pass', 1) };
  if (name === 'records') {
    proofs.fail = readProof(directory, job, 'fail', 0);
  }
  if (name === 'limits') {
    assert.equal(proofs.pass.envelopeBytes, 16_384 + 28, 'Delivery does not fill the encoded limit');
  }
  return {
    imageId: cold.value.imageId,
    buildFingerprint: cold.value.buildFingerprint,
    cold: cold.timing,
    warm: warm.timing,
    proofs,
  };
}

try {
  const [root, ...extra] = process.argv.slice(2);
  if (!root || extra.length) throw new Error('Usage: node report-release.mjs SCRATCH_RUN_ROOT');
  const fixtures = {};
  for (const name of ['records', 'signed', 'limits']) {
    try {
      fixtures[name] = reportFixture(join(root, name), name);
    } catch (error) {
      // Assertion errors can hold raw values. Print only our fixed error messages.
      throw new Error(`${name}: ${error instanceof assert.AssertionError ? error.message : 'could not read a JSON report'}`);
    }
  }
  process.stdout.write(JSON.stringify({ version: 1, fixtures }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 2;
}
