import assert from 'node:assert/strict';
import test from 'node:test';
import {assessSupportedDraft} from './assess.mjs';
import {buildCorpus} from './corpus.mjs';
import {access, all, bin, bool, candidate, count, int, lookup, rf, rowsFile} from './shape.mjs';

const choose = (condition, thenBranch, elseBranch) => ({
  op: 'if', condition, then: thenBranch, else: elseBranch,
});

export function conditionalRoutePlan(plan) {
  const hops = access('deliverable', 'hops.json');
  const edges = access('reference', 'edges.json');
  const [uniqueSeq, seqDomain, origin, destination, , ...limits] = plan.rules;
  const nextEdge = lookup(hops, 'seq', bin('add', rf('seq'), int(1)), 'edgeId');
  const connected = bin('eq',
    lookup(edges, 'edgeId', rf('edgeId'), 'toStop'),
    lookup(edges, 'edgeId', nextEdge, 'fromStop'));
  // Valid sequence numbers guarantee a next hop before the last one.
  const continuity = all(hops, choose(bin('lt', rf('seq'), count(hops)), connected, bool(true)));
  const route = choose(bin('and', uniqueSeq, seqDomain), continuity, bool(false));
  return {...plan, rules: [origin, destination, route, ...limits]};
}

test('conditional next-hop lookup preserves all warehouse route oracle outcomes', async () => {
  const challenge = buildCorpus().find(({id}) => id === 'route-penalty-1');
  const plan = conditionalRoutePlan(challenge.plan);
  const result = await assessSupportedDraft(challenge, plan);
  assert.equal(result.engineValid, true, result.reason);
  assert.equal(result.candidateResults.length, 11);
  for (const row of result.candidateResults) {
    assert.equal(row.engine, row.oracle, row.id);
  }
});

test('checks a 128-hop route with the pairwise and conditional plans', async () => {
  const original = buildCorpus().find(({id}) => id === 'route-penalty-1');
  const size = 128;
  const edges = Array.from({length: size}, (_, i) => ({
    edgeId: `edge-${i}`, fromStop: `stop-${i}`, toStop: `stop-${i + 1}`, meters: '1',
  }));
  const hops = edges.map(({edgeId}, i) => ({edgeId, seq: String(i + 1)}));
  const broken = structuredClone(hops);
  [broken[64].edgeId, broken[65].edgeId] = [broken[65].edgeId, broken[64].edgeId];
  const challenge = {
    ...original,
    referenceFiles: {
      ...rowsFile('edges.json', edges),
      'limits.json': JSON.stringify({
        origin: 'stop-0', destination: `stop-${size}`, minHops: '1',
        maxHops: String(size), penalty: '1', cap: String(size * 2),
      }),
    },
    candidates: [
      candidate('continuous', rowsFile('hops.json', hops)),
      candidate('broken', rowsFile('hops.json', broken), 'fail', ['continuity']),
    ],
  };
  for (const plan of [original.plan, conditionalRoutePlan(original.plan)]) {
    const result = await assessSupportedDraft(challenge, plan);
    assert.equal(result.engineValid, true, result.reason);
    assert.deepEqual(result.candidateResults, [
      {id: 'continuous', engine: 'pass', oracle: 'pass'},
      {id: 'broken', engine: 'fail', oracle: 'fail'},
    ]);
  }
});
