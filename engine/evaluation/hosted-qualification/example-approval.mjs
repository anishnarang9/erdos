export const RULES_HASH_DIFFERS = 'Rules hash differs from the funded context';

export function withLiteralTrue(plan) {
  const next = structuredClone(plan);
  next.rules.push({op: 'literal', type: 'bool', value: true});
  return next;
}

export function classifyExampleEval(result) {
  if (result?.exitCode === 0 && result.value?.verdict === 1) return {outcome: 'pass', blocksApproval: false};
  if (result?.exitCode === 0 && result.value?.verdict === 0) return {outcome: 'verdict-0', blocksApproval: false};
  if (result?.exitCode === 2 && result.value?.code === 'invalid_deliverable' && result.value?.message === RULES_HASH_DIFFERS) {
    return {outcome: 'rules-hash-differs', blocksApproval: true};
  }
  if (result?.exitCode === 2) return {outcome: 'reject', blocksApproval: true};
  return {outcome: 'engine-failure', blocksApproval: true};
}

// Hidden-candidate agreement stays the semantic score.
// A failed preview example blocks approval and stays failed.
const BLOCKING_OUTCOMES = new Set(['rules-hash-differs', 'reject', 'engine-failure']);

export function separateDraftScores(semanticAgreement, exampleOutcomes) {
  const outcomes = Array.isArray(exampleOutcomes) ? exampleOutcomes : [];
  const passCount = outcomes.filter((item) => item.outcome === 'pass').length;
  const verdict0Count = outcomes.filter((item) => item.outcome === 'verdict-0').length;
  const blockers = outcomes
    .filter((item) => item.blocksApproval === true || BLOCKING_OUTCOMES.has(item.outcome))
    .map((item) => item.outcome);
  const approvalReady = semanticAgreement === true && passCount >= 1 && verdict0Count >= 1 && blockers.length === 0;
  return {
    semanticAgreement: semanticAgreement === true,
    approvalReady,
    passCount,
    verdict0Count,
    blockers,
  };
}
