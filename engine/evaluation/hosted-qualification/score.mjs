import {TextDecoder} from 'node:util';

const decoder = new TextDecoder('utf-8', {fatal: true});

function referenceText(challenge) {
  const parts = [challenge.prompt ?? ''];
  for (const value of Object.values(challenge.referenceFiles ?? {})) {
    try {
      parts.push(typeof value === 'string' ? value : decoder.decode(value));
    } catch {
      // Opaque bytes are not quote text.
    }
  }
  return parts.join('\n');
}

function blank(base) {
  return {
    ...base,
    clarificationFacets: 0,
    facetCount: 0,
    inventedConditions: 0,
    semanticAgreement: false,
    falseAccepts: 0,
    missingRequirements: 0,
    validInputFalseRejects: 0,
    malformedAccepts: 0,
    weakerPayableJob: false,
    unsupportedExplanation: false,
  };
}

export function scoreTrial({challenge, response, candidateResults = [], repairCount = null, cost = null, latencyMs = null, live = false}) {
  const text = referenceText(challenge);
  const quotes = response?.sourceQuotes ?? [];
  const quoteFidelity = quotes.every((item) => typeof item.quote === 'string' && item.quote.length > 0 && text.includes(item.quote));
  const base = {live, repairCount, cost, latencyMs, quoteFidelity};
  if (challenge.classification === 'ambiguous') {
    const questions = response?.kind === 'clarification' ? response.questions ?? [] : [];
    const facets = challenge.facets ?? [];
    const matched = facets.filter((facet) => questions.some((question) => question.toLowerCase().includes(facet.toLowerCase())));
    return {
      ...blank(base),
      clarificationFacets: matched.length,
      facetCount: facets.length,
      inventedConditions: response?.kind === 'draft' ? 1 : 0,
    };
  }
  if (challenge.classification === 'unsupported') {
    const expected = challenge.capabilityRequests?.[0];
    const native = response?.capabilityError;
    const unsupportedExplanation = !!expected?.name && response?.kind === 'unsupported'
      && (response.reason === 'capability_unsupported'
        ? native?.code === 'unsupported_capability' && native.request?.kind === expected.kind
          && native.request?.name === expected.name
        : typeof response.reason === 'string' && response.reason.includes(expected.name));
    return {
      ...blank(base),
      weakerPayableJob: response?.kind === 'draft',
      unsupportedExplanation,
    };
  }
  const falseAccepts = candidateResults.filter((item) => item.engine === 'pass' && item.oracle !== 'pass').length;
  const missingRequirements = candidateResults.filter((item) => item.oracle === 'fail' && item.engine === 'pass').length;
  const malformedAccepts = candidateResults.filter((item) => item.oracle === 'reject' && item.engine === 'pass').length;
  const validInputFalseRejects = candidateResults.filter((item) => item.oracle === 'pass' && item.engine !== 'pass').length;
  const inventedConditions = validInputFalseRejects;
  const semanticAgreement = candidateResults.length > 0 && falseAccepts === 0 && missingRequirements === 0 && inventedConditions === 0
    && malformedAccepts === 0 && candidateResults.every((item) => item.engine === item.oracle);
  return {
    ...blank(base),
    inventedConditions,
    semanticAgreement,
    falseAccepts,
    missingRequirements,
    validInputFalseRejects,
    malformedAccepts,
  };
}
