import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeCandidateEvidence, writeChallenge} from './shape.mjs';
import {evaluateCandidate} from './oracle.mjs';
import {classifyEvaluation, encodeDirectory, runEngine, sha256, syntheticJob} from '../run-challenges.mjs';
import {resolveEngine} from './host-run.mjs';

export async function assessSupportedDraft(challenge, plan, env = process.env) {
  if (challenge?.classification !== 'supported') return {engineValid: null, candidateResults: [], reason: 'not-supported'};
  const resolved = resolveEngine(env);
  if (!resolved.ok) return {engineValid: null, candidateResults: [], reason: resolved.reason};
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return {engineValid: false, candidateResults: [], reason: 'missing-plan'};
  }
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-assess-'));
  try {
    const written = await writeChallenge(challenge, directory);
    const planPath = join(directory, written.planPath);
    await writeFile(planPath, `${JSON.stringify(plan)}\n`);
    const validation = runEngine(resolved.engine, ['validate', '--plan', planPath]);
    if (validation.exitCode !== 0) return {engineValid: false, candidateResults: [], reason: 'plan-invalid'};
    const reference = join(directory, written.referencePath);
    const referenceHash = sha256(Buffer.concat([Buffer.from('UBC26/reference/v1'), await encodeDirectory(reference)]));
    const job = syntheticJob({rulesHash: validation.value.rulesHash, referenceHash}, 7000);
    const jobPath = join(directory, 'returned-job.json');
    await writeFile(jobPath, JSON.stringify(job));
    const candidateResults = [];
    for (const candidate of written.candidates) {
      const candidateDirectory = join(directory, candidate.path);
      await writeCandidateEvidence(challenge, candidate, candidateDirectory, job.context);
      const expected = await evaluateCandidate(challenge, candidateDirectory, {
        referenceDirectory: reference,
        contextHex: job.context,
      });
      const args = ['eval', '--plan', planPath, '--deliverables', join(candidateDirectory, 'delivery'), '--reference', reference, '--job', jobPath];
      if (plan.evidence?.length) args.push('--evidence', join(candidateDirectory, 'evidence'));
      const actualStatus = classifyEvaluation(runEngine(resolved.engine, args));
      candidateResults.push({id: candidate.id, engine: actualStatus, oracle: expected.status});
    }
    return {engineValid: true, candidateResults, reason: null};
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
