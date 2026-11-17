import {writeCandidateEvidence, writeChallenge} from './shape.mjs';
import {buildChallenges} from './families.mjs';

export {writeCandidateEvidence, writeChallenge};
export const CORPUS_ID = 'hosted-qualification-2026-11-16';
export const SOURCE_BASE = 'c21ec6e';
export const REVIEWED_MAIN = '6ed9d2d';

export function buildCorpus() {
  return buildChallenges();
}

export function canonicalCorpus(challenges = buildCorpus()) {
  const pack = (files) => Object.fromEntries(Object.entries(files ?? {}).map(([name, bytes]) => [
    name,
    Buffer.from(bytes).toString('base64'),
  ]));
  return challenges.map((challenge) => ({
    id: challenge.id,
    family: challenge.family,
    classification: challenge.classification,
    prompt: challenge.prompt,
    requirements: challenge.requirements ?? [],
    spec: challenge.spec ?? null,
    plan: challenge.plan ?? null,
    unsupportedDraft: challenge.unsupportedDraft ?? null,
    clarificationQuestions: challenge.clarificationQuestions ?? [],
    capabilityRequests: challenge.capabilityRequests ?? [],
    referenceFiles: pack(challenge.referenceFiles),
    candidates: (challenge.candidates ?? []).map((item) => ({
      id: item.id,
      expected: item.expected,
      evidenceVariant: item.evidenceVariant ?? null,
      deliveryFiles: pack(item.deliveryFiles),
    })),
  }));
}
