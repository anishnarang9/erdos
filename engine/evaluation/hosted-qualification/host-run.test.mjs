import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {buildCorpus} from './corpus.mjs';
import {resolveEngine, runHost, selectChallenges} from './host-run.mjs';

function runCli(args, env = {}) {
  return spawnSync(process.execPath, ['engine/evaluation/hosted-qualification/host-run.mjs', ...args], {
    encoding: 'utf8',
    env: {...process.env, UBC26_ENGINE: '', ...env},
  });
}

test('host runner source has no personal engine default', async () => {
  const source = await readFile(new URL('./host-run.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('/Users/'), false);
  assert.equal(source.includes('anishnarang'), false);
});

test('engine resolution requires an explicit executable or the repo binary', () => {
  const missing = resolveEngine({UBC26_ENGINE: ''}, () => false);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-engine');
  assert.equal(missing.message.includes('/Users/'), false);
  const named = resolveEngine({UBC26_ENGINE: 'build/engine'}, (path) => path.endsWith('build/engine'));
  assert.equal(named.ok, true);
  const repo = resolveEngine({}, (path) => path.endsWith('engine/target/debug/engine'));
  assert.equal(repo.ok, true);
});

test('help, unknown selectors, and ambiguous ids are not an empty qualification', async () => {
  const challenges = buildCorpus();
  const help = selectChallenges(challenges, ['--help']);
  assert.equal(help.ok, false);
  assert.equal(help.reason, 'help');
  const unknown = await runHost(['not-a-challenge']);
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.report.reason, 'unknown-selector');
  assert.equal(Object.hasOwn(unknown.report, 'compared'), false);
  const ambiguous = await runHost(['hq-ambiguous-1']);
  assert.equal(ambiguous.exitCode, 2);
  assert.equal(ambiguous.report.reason, 'no-comparisons');
  assert.equal(Object.hasOwn(ambiguous.report, 'compared'), false);

  for (const args of [['--help'], ['not-a-challenge'], ['hq-ambiguous-1']]) {
    const result = runCli(args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout.includes('"compared"'), false, result.stdout);
    assert.equal(result.stdout.includes('/Users/'), false, result.stdout);
    assert.equal(result.stderr.includes('/Users/'), false);
  }
});

test('a missing explicit engine does not report compared zero', () => {
  const result = runCli(['pier-drawers'], {UBC26_ENGINE: '/tmp/ubc26-engine-missing'});
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'missing-engine');
  assert.equal(Object.hasOwn(report, 'compared'), false);
  assert.equal(result.stdout.includes('/Users/'), false);
  assert.equal(result.stdout.includes('/tmp/ubc26-engine-missing'), false);
});
