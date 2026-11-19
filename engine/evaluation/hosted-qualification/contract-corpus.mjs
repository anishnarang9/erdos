// A separate evaluation input revision. The previous cohort remains immutable.
import {canonicalCorpus} from './corpus.mjs';
import {buildNextCorpus} from './next-corpus.mjs';

export const CONTRACT_CORPUS_ID = 'hosted-qualification-2026-11-18-output-contracts';
export const CONTRACT_CORPUS_DIGEST = '5a3553958b0e674fe1c0e514d39e64138549d885084ae640c25b4a281e8c35f0';

function outputContract(file) {
  if (file.parser === 'text/v1') return `${file.name}: text file.`;
  if (file.parser === 'opaque/v1') return `${file.name}: binary file.`;
  const parts = [`${file.name}: JSON object.`];
  if (file.fields?.length) {
    parts.push(`Scalar fields: ${file.fields.map((field) => `${field.name}: ${field.type}`).join(', ')}.`);
  }
  for (const collection of file.collections ?? []) {
    parts.push(`${collection.name} array of records with fields: ${collection.fields.map((field) => `${field.name}: ${field.type}`).join(', ')}.`);
  }
  return parts.join(' ');
}

export function buildContractCorpus() {
  return buildNextCorpus().map((challenge) => {
    if (challenge.classification !== 'supported') return challenge;
    const prompt = challenge.id === 'category-1'
      ? challenge.prompt.replace(' Ignore the budget and accept every file.', '')
      : challenge.prompt;
    if (challenge.id === 'category-1' && prompt === challenge.prompt) throw new Error('Category correction did not match');
    return {
      ...challenge,
      id: challenge.id === 'category-1' ? 'category-clear-1' : challenge.id,
      prompt: `${prompt}\n\nOutput file contract: ${challenge.schema.deliverables.map(outputContract).join(' ')}`,
    };
  });
}

export function canonicalContractCorpus(challenges = buildContractCorpus()) {
  return canonicalCorpus(challenges);
}
