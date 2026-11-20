import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildCorpus, writeCandidateEvidence, writeChallenge} from './corpus.mjs';
import {evaluateCandidate} from './oracle.mjs';
import {classifyEvaluation, encodeDirectory, runEngine, sha256, syntheticJob} from '../run-challenges.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repoEnginePath = join(here, '../../target/debug/engine');

export function resolveEngine(env = process.env, pathExists = existsSync) {
  const explicit = env.UBC26_ENGINE;
  if (typeof explicit === 'string' && explicit !== '') {
    const engine = resolve(explicit);
    if (!pathExists(engine)) {
      return {ok: false, reason: 'missing-engine', message: 'UBC26_ENGINE does not name an executable file.'};
    }
    return {ok: true, engine};
  }
  if (pathExists(repoEnginePath)) return {ok: true, engine: repoEnginePath};
  return {
    ok: false,
    reason: 'missing-engine',
    message: 'Set UBC26_ENGINE to the engine executable, or build engine/target/debug/engine.',
  };
}

export function selectChallenges(challenges, selectors) {
  if (selectors.includes('--help') || selectors.includes('-h')) {
    return {
      ok: false,
      reason: 'help',
      message: 'Usage: node engine/evaluation/hosted-qualification/host-run.mjs [challenge-id]',
    };
  }
  const unknown = selectors.filter((id) => !challenges.some((item) => item.id === id));
  if (unknown.length > 0) {
    return {ok: false, reason: 'unknown-selector', message: `Unknown challenge id: ${unknown.join(', ')}`};
  }
  const selected = selectors.length === 0 ? challenges : challenges.filter((item) => selectors.includes(item.id));
  return {ok: true, challenges: selected};
}

export async function runHost(selectors, env = process.env) {
  const selected = selectChallenges(buildCorpus(), selectors);
  if (!selected.ok) return {exitCode: 2, report: {ok: false, reason: selected.reason, message: selected.message}};
  const comparable = selected.challenges.filter((challenge) => challenge.classification === 'supported' || challenge.classification === 'unsupported');
  if (comparable.length === 0) {
    return {
      exitCode: 2,
      report: {ok: false, reason: 'no-comparisons', message: 'The selection has no supported candidate or unsupported capability to compare.'},
    };
  }
  const resolved = resolveEngine(env);
  if (!resolved.ok) return {exitCode: 2, report: {ok: false, reason: resolved.reason, message: resolved.message}};
  const directory = await mkdtemp(join(tmpdir(), 'ubc26-host-'));
  const failures = [];
  let compared = 0;
  try {
    const challenges = comparable.filter((challenge) => challenge.classification === 'supported');
    let jobId = 4000;
    for (const challenge of challenges) {
      const written = await writeChallenge(challenge, directory);
      const planPath = join(directory, written.planPath);
      const reference = join(directory, written.referencePath);
      const validation = runEngine(resolved.engine, ['validate', '--plan', planPath]);
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
        const actual = runEngine(resolved.engine, args);
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
    for (const challenge of comparable.filter((item) => item.classification === 'unsupported')) {
      await writeChallenge(challenge, directory);
      const planPath = join(directory, challenge.classification, challenge.id, 'unsupported-plan.json');
      const validation = runEngine(resolved.engine, ['validate', '--plan', planPath]);
      const request = validation.value?.request;
      const expected = challenge.capabilityRequests[0];
      compared += 1;
      if (validation.exitCode !== 2 || validation.value?.code !== 'unsupported_capability'
        || request?.kind !== expected.kind || request?.name !== expected.name) {
        failures.push({
          id: challenge.id,
          kind: 'unsupported_capability',
          exitCode: validation.exitCode,
          actual: validation.value ?? validation.stderr,
        });
      }
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
  if (compared === 0 && failures.length === 0) {
    return {
      exitCode: 2,
      report: {ok: false, reason: 'no-comparisons', message: 'The selection has no supported candidate or unsupported capability to compare.'},
    };
  }
  return {
    exitCode: failures.length ? 1 : 0,
    report: {engine: resolved.engine, compared, failures: failures.length, rows: failures},
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await runHost(process.argv.slice(2));
  console.log(JSON.stringify(result.report));
  process.exitCode = result.exitCode;
}
