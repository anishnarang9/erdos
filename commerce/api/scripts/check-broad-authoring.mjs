// Run with pnpm exec tsx scripts/check-broad-authoring.mjs ENGINE [REPORT].
// All requests stay in process. The Grok adapter receives controlled synthetic replies.
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {hostedClient} from '@ubc26/sdk';
import {privateKeyToAccount} from 'viem/accounts';
import {assessSupportedDraft} from '../../../engine/evaluation/hosted-qualification/assess.mjs';
import {buildCorpus} from '../../../engine/evaluation/hosted-qualification/corpus.mjs';
import {scoreTrial} from '../../../engine/evaluation/hosted-qualification/score.mjs';
import {draftInput} from '../../../engine/evaluation/hosted-qualification/trials.mjs';
import {createApp, engineFromConfig, grokDraftModel} from '../src/index.ts';

const cases = [
  'pier-drawers', 'lot-range-1', 'category-1', 'badge-zone-1',
  'nights-1', 'berth-swap-1', 'route-penalty-1', 'firmware-pair-1',
];
const compileCases = new Set(['category-1', 'route-penalty-1', 'firmware-pair-1']);
const corpus = buildCorpus();
const challenges = cases.map(id => corpus.find(challenge => challenge.id === id));
const origin = 'https://broad.example.test';
const model = 'grok-4.20-0309-non-reasoning';
const fileInputs = files => Object.entries(files).map(([name, bytes]) => ({
  name, content: Buffer.from(bytes).toString('base64'), encoding: 'base64',
}));

async function main() {
  assert.ok(process.argv[2], 'Supply the native engine path');
  const enginePath = resolve(process.argv[2]);
  const root = await mkdtemp(join(tmpdir(), 'ubc26-broad-authoring-'));
  const {engine} = engineFromConfig({
    mode: 'native', distro: 'Ubuntu', enginePath,
    workDir: join(root, 'work'), tmpDir: join(root, 'tmp'), cacheDir: join(root, 'cache'),
  }, {pin: 'public'});
  let replies = 0;
  const prepared = new Map();
  const app = createApp({
    dbPath: join(root, 'api.db'),
    buyerToken: 'broad-synthetic-local-token',
    packagesDir: join(root, 'packages'),
    deployment: {mode: 'public', serviceOrigin: origin},
    budget: {
      requestCeilingMicroUsd: 5_000_000, dailyCeilingMicroUsd: 50_000_000,
      inputMicroUsdPerMillion: 2_500_000, outputMicroUsdPerMillion: 5_000_000,
    },
    authoringRepairs: false,
    engine,
    draftModel: grokDraftModel({
      apiKey: 'synthetic-key', model,
      fetch: async (_url, options) => {
        const payload = JSON.parse(options.body);
        const request = JSON.parse(payload.messages.at(-1).content).request;
        const result = prepared.get(request);
        assert.ok(result, 'Unexpected buyer request');
        replies++;
        return Response.json({
          id: `broad-fixture-${replies}`, model,
          usage: {prompt_tokens: 100, completion_tokens: 100, cost_in_usd_ticks: 10001},
          choices: [{finish_reason: 'stop', message: {content: JSON.stringify(result)}}],
        });
      },
    }),
  });
  const report = {externalProviderCalls: 0, controlledReplies: 0, cases: [], localOnly: true};
  try {
    const transport = (url, options) => app.app.request(String(url), options);
    const account = privateKeyToAccount(`0x${'34'.repeat(32)}`);
    const anon = hostedClient({baseUrl: origin, fetch: transport});
    const key = await anon.authenticate(account.address, message => account.signMessage({message}), 'broad-auth');
    const client = hostedClient({baseUrl: origin, apiKey: key.key, fetch: transport});
    for (const challenge of challenges) {
      const {id, prompt, plan, candidates} = challenge;
      const witness = status => candidates.find(candidate => candidate.expected.status === status);
      const example = (candidate, verdict) => ({
        name: candidate.id, predictedVerdict: verdict, files: fileInputs(candidate.deliveryFiles),
        evidence: [], context: null,
      });
      prepared.set(prompt, {
        kind: 'draft', plan,
        examples: [example(witness('pass'), 1), example(witness('fail'), 0)],
        sourceQuotes: [{path: '/request', quote: prompt}],
        coverage: {
          requirements: [{id: 'brief', text: prompt, ruleIndices: plan.rules.map((_, i) => i), quoteIndices: [0]}],
          assumptions: [], unresolved: [],
        },
      });
      const input = draftInput(challenge);
      const queued = await client.draft(input, `draft-${id}`);
      await app.pumpTasks();
      const draft = await client.task(queued.id);
      assert.equal(draft.state, 'succeeded', `${id}: ${JSON.stringify(draft.error)}`);
      const result = draft.result;
      assert.equal(result.kind, 'draft', id);
      const oracle = await assessSupportedDraft(challenge, result.revision.plan, {UBC26_ENGINE: enginePath});
      assert.equal(oracle.engineValid, true, id);
      for (const candidate of oracle.candidateResults) assert.equal(candidate.engine, candidate.oracle, `${id}/${candidate.id}`);
      assert.equal(result.coverage.ruleCoverageComplete, true, id);
      assert.equal(result.exampleApprovalReady, true, id);
      assert.deepEqual(result.examples.map(row => row.checkerVerdict), [1, 0], id);
      const job = await client.createJob({
        source: 'grok', draftId: result.draftId, revision: result.revision, references: input.references,
      }, `job-${id}`);
      const approval = {
        revisionHash: result.revisionHash,
        referenceDigest: result.revision.referenceDigest,
        coverageDigest: result.coverage.coverageDigest,
      };
      await assert.rejects(client.approve(job.jobId, {...approval, coverageDigest: '0'.repeat(64)}, `wrong-approval-${id}`),
        {status: 409, code: 'approval_required'});
      const invalid = witness('reject');
      if (invalid) {
        const {context, ...bad} = example(invalid, 0);
        const checked = await client.checkExamples(result.draftId, {revisionHash: result.revisionHash, examples: [bad]}, `bad-example-${id}`);
        assert.equal(checked.exampleApprovalReady, false, id);
        await assert.rejects(client.approve(job.jobId, {...approval, exampleCheckId: checked.exampleCheckId}, `bad-check-${id}`),
          {status: 409, code: 'approval_required'});
      }
      assert.equal((await client.approve(job.jobId, approval, `approve-${id}`)).state, 'approved', id);
      const row = {id, nativeComparisons: oracle.candidateResults.length, approved: true, malformedExampleChecked: !!invalid, compiled: false};
      report.cases.push(row);
      if (compileCases.has(id)) {
        const task = await client.compile(job.jobId, result.revisionHash, `compile-${id}`);
        await app.pumpTasks();
        const done = await client.task(task.id);
        assert.equal(done.state, 'succeeded', `${id}: ${JSON.stringify(done.error)}`);
        assert.equal(done.result.manifest.rulesHash, result.engine.rulesHash, id);
        assert.equal(done.result.manifest.referenceHash, result.revision.referenceDigest, id);
        const listing = await client.packageListing(job.jobId);
        assert.deepEqual(listing.manifest, done.result.manifest, id);
        const guest = listing.files.find(file => file.path === 'guest.elf');
        assert.equal(guest?.sha256, listing.manifest.guestSha256, id);
        const byName = (left, right) => left.name.localeCompare(right.name);
        assert.deepEqual((await client.references(job.jobId)).files.sort(byName), [...input.references].sort(byName), id);
        row.compiled = true;
      }
    }
    const unsupported = corpus.find(challenge => challenge.id === 'hq-unsupported-2');
    prepared.set(unsupported.prompt, {
      kind: 'draft', plan: unsupported.unsupportedDraft, examples: [],
      sourceQuotes: [{path: '/request', quote: unsupported.prompt}],
      coverage: {
        requirements: [{id: 'missing-capability', text: unsupported.prompt, ruleIndices: [0], quoteIndices: [0]}],
        assumptions: [], unresolved: [],
      },
    });
    const task = await client.draft(draftInput(unsupported), 'draft-unsupported-div');
    await app.pumpTasks();
    const terminal = await client.task(task.id);
    assert.equal(terminal.state, 'succeeded', JSON.stringify(terminal.error));
    const score = scoreTrial({challenge: unsupported, response: terminal.result});
    assert.equal(score.unsupportedExplanation, true);
    assert.equal(score.weakerPayableJob, false);
    report.unsupportedCapability = terminal.result.capabilityError.request;
    report.controlledReplies = replies;
    assert.equal(replies, cases.length + 1);
    if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify(report));
  } finally {
    await app.drainTasks();
    app.close();
    await rm(root, {recursive: true, force: true});
  }
}

await main();
