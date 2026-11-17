import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCorpus, writeCandidateEvidence, writeChallenge} from './corpus.mjs';
import {evaluateCandidate} from './oracle.mjs';
import {classifyEvaluation, encodeDirectory, runEngine, sha256, syntheticJob} from '../run-challenges.mjs';

const engine = process.env.UBC26_ENGINE ?? '/Users/anishnarang/UBC-26/engine/target/debug/engine';
const wanted = new Set(process.argv.slice(2));
const directory = await mkdtemp(join(tmpdir(), 'ubc26-host-'));
const failures = [];
let compared = 0;
try {
  const challenges = buildCorpus().filter((challenge) => challenge.classification === 'supported'
    && (wanted.size === 0 || wanted.has(challenge.id)));
  let jobId = 4000;
  for (const challenge of challenges) {
    const written = await writeChallenge(challenge, directory);
    const planPath = join(directory, written.planPath);
    const reference = join(directory, written.referencePath);
    const validation = runEngine(engine, ['validate', '--plan', planPath]);
    if (validation.exitCode !== 0) {
      failures.push({id: challenge.id, kind: 'plan_validation', actual: validation.value ?? validation.stderr});
      continue;
    }
    const referenceHash = sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'), await encodeDirectory(reference)]));
    const job = syntheticJob({rulesHash: validation.value.rulesHash, referenceHash}, jobId);
    jobId += 1;
    const jobPath = join(directory, written.planPath.replace(/plan\.json$/, 'job.json'));
    await writeFile(jobPath, JSON.stringify(job));
    for (const candidate of written.candidates) {
      const candidateDirectory = join(directory, candidate.path);
      await writeCandidateEvidence(challenge, candidate, candidateDirectory, job.context);
      const expected = await evaluateCandidate(challenge, candidateDirectory, {
        referenceDirectory: reference,
        contextHex: job.context,
      });
      const args = ['eval', '--plan', planPath, '--deliverables', join(candidateDirectory, 'delivery'), '--reference', reference, '--job', jobPath];
      if (challenge.plan.evidence?.length) args.push('--evidence', join(candidateDirectory, 'evidence'));
      const actual = runEngine(engine, args);
      const actualStatus = classifyEvaluation(actual);
      compared += 1;
      if (expected.status !== candidate.expected.status || actualStatus !== expected.status) {
        failures.push({
          id: challenge.id,
          candidate: candidate.id,
          label: candidate.expected.status,
          oracle: expected.status,
          engine: actualStatus,
          detail: actual.value ?? actual.stderr,
        });
      }
    }
  }
} finally {
  await rm(directory, {recursive: true, force: true});
}

console.log(JSON.stringify({engine, compared, failures: failures.length, rows: failures}));
if (failures.length) process.exitCode = 1;
