import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Import inside tests so missing implementation causes an assertion failure.
const modules = () => Promise.all([import('./generate-challenges.mjs'), import('./reference-oracle.mjs')]);
const context = '0x01' + '00'.repeat(168);

test('suite has the approved 40/10/10 split and six supported families', async () => {
  let api;
  try { [api] = await modules(); } catch { assert.fail('Challenge generator and reference oracle must exist'); }
  const suite = api.buildChallenges();
  assert.equal(suite.length, 60);
  assert.equal(new Set(suite.map(c => c.id)).size, 60);
  for (const [classification, count] of [['supported',40],['ambiguous',10],['unsupported',10]]) {
    assert.equal(suite.filter(c => c.classification === classification).length, count);
  }
  assert.equal(new Set(suite.filter(c=>c.classification==='supported').map(c=>c.family)).size,6);
});

test('each supported requirement has an isolated counterexample', async () => {
  const [{buildChallenges}] = await modules();
  for (const c of buildChallenges().filter(c=>c.classification==='supported')) {
    assert.ok(c.prompt.length > 80, c.id);
    assert.ok(c.plan && c.inputTypes && c.supportedOperations && c.oracle, c.id);
    assert.ok(c.candidates.some(x=>x.expected.status==='pass'), c.id);
    for (const requirement of c.requirements) {
      assert.ok(c.candidates.some(x => x.expected.status!=='pass' && x.expected.violatedRequirements.length===1 && x.expected.violatedRequirements[0]===requirement.id), `${c.id}: ${requirement.id}`);
    }
  }
});

test('independent domain oracle matches every declared candidate', async () => {
  const [{writeChallengeSuite,writeCandidateEvidence},{evaluateCandidate}] = await modules();
  const output = await mkdtemp(join(tmpdir(),'ubc26-suite-test-'));
  try {
    const suite = await writeChallengeSuite(output);
    let count = 0;
    for (const c of suite.challenges.filter(c=>c.classification==='supported')) {
      for (const candidate of c.candidates) {
        const dir = join(output,candidate.path);
        if (c.plan.evidence?.length) await writeCandidateEvidence(c,candidate,dir,context);
        const actual = await evaluateCandidate(c,dir,{contextHex:context,referenceDirectory:join(output,c.referencePath)});
        assert.equal(actual.status,candidate.expected.status,`${c.id}/${candidate.id}: ${JSON.stringify(actual)}`);
        assert.deepEqual(actual.violatedRequirements.sort(),candidate.expected.violatedRequirements.toSorted(),`${c.id}/${candidate.id}`);
        count++;
      }
    }
    assert.ok(count>=240, `Only ${count} candidates`);
    const disk = JSON.parse(await readFile(join(output,'suite.json'),'utf8'));
    assert.equal(disk.challenges.length,60);
  } finally { await rm(output,{recursive:true,force:true}); }
});

test('oracle uses file bytes and does not trust candidate labels', async () => {
  const [{writeChallengeSuite},{evaluateCandidate}] = await modules();
  const {writeFile} = await import('node:fs/promises');
  const output = await mkdtemp(join(tmpdir(),'ubc26-oracle-test-'));
  try {
    const suite = await writeChallengeSuite(output);
    const c = suite.challenges.find(x=>x.family==='expenses-budgets');
    const candidate = c.candidates.find(x=>x.expected.status==='pass');
    const dir = join(output,candidate.path);
    const file = join(dir,'delivery','expenses.json');
    const data = JSON.parse(await readFile(file,'utf8'));
    data.rows[0].approved = false;
    await writeFile(file,JSON.stringify(data));
    const actual = await evaluateCandidate(c,dir,{referenceDirectory:join(output,c.referencePath)});
    assert.equal(actual.status,'fail');
    assert.deepEqual(actual.violatedRequirements,['approved']);
  } finally { await rm(output,{recursive:true,force:true}); }
});

test('clarifications and unsupported requests describe an explicit capability boundary', async () => {
  const [{buildChallenges}] = await modules();
  for (const c of buildChallenges()) {
    if(c.classification==='ambiguous') {
      assert.ok(c.clarificationQuestions.length>=1,c.id);
      assert.equal(c.plan,undefined,c.id);
    }
    if(c.classification==='unsupported') {
      assert.ok(c.capabilityRequests.length>=1,c.id);
      assert.ok(c.unsupportedDraft,c.id);
    }
  }
});

test('unsupported evidence requests use the engine capability kind', async () => {
  const [{buildChallenges}] = await modules();
  const c=buildChallenges().find(x=>x.id==='unsupported-10');
  assert.deepEqual(c.capabilityRequests,[{kind:'evidence',name:'x509/v1'}]);
});

test('supported candidates include checked overflow and collection bounds', async () => {
  const [{buildChallenges}] = await modules();
  for(const c of buildChallenges().filter(x=>x.classification==='supported'&&x.family==='expenses-budgets')) {
    assert.ok(c.candidates.some(x=>x.id==='sum-overflow'&&x.expected.status==='reject'));
    assert.ok(c.candidates.some(x=>x.id==='too-many-rows'&&x.expected.status==='reject'));
  }
});

test('challenge generation is deterministic', async () => {
  const [{buildChallenges}] = await modules();
  assert.deepEqual(buildChallenges(),buildChallenges());
});


test('generator CLI works through a symlink', async () => {
  const {symlink} = await import('node:fs/promises');
  const {spawnSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const output = await mkdtemp(join(tmpdir(),'ubc26-cli-test-'));
  try {
    const link=join(output,'generator.mjs');
    await symlink(fileURLToPath(new URL('./generate-challenges.mjs',import.meta.url)),link);
    const run=spawnSync(process.execPath,[link,'generate',join(output,'suite')],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    assert.ok(run.stdout.includes('supported'), 'CLI must emit its result');
    assert.equal(JSON.parse(await readFile(join(output,'suite','suite.json'),'utf8')).challenges.length,60);
  } finally {await rm(output,{recursive:true,force:true});}
});
