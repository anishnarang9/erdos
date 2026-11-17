import {writeCandidateEvidence, writeChallenge} from './shape.mjs';
import {buildChallenges} from './families.mjs';

export {writeCandidateEvidence, writeChallenge};
export const CORPUS_ID = 'hosted-qualification-2026-11-16';
export const SOURCE_BASE = 'c21ec6e';
export const REVIEWED_MAIN = '6ed9d2d';
export const PREVIOUS_CORPUS_DIGEST = 'ab560ef0ab5fe955823c86c4ea3a0a1c7998cf58d3b60f4564cdf42faeac4cc6';
export const CORPUS_DIGEST = '2d4399d2d9b6a15e3c02d243ecd2f2c31e28ec49bd710f673a0700c43c219470';

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
    facets: challenge.facets ?? [],
    capabilityRequests: challenge.capabilityRequests ?? [],
    boundary: challenge.boundary ?? null,
    outputs: (challenge.outputs ?? []).map((item) => ({name: item.name, format: item.format})),
    exampleFixtures: (challenge.exampleFixtures ?? []).map((fixture) => ({
      name: fixture.name,
      predictedVerdict: fixture.predictedVerdict,
      files: fixture.files.map((file) => ({name: file.name, content: file.content, encoding: file.encoding ?? 'utf8'})),
      evidence: (fixture.evidence ?? []).map((file) => ({name: file.name, content: file.content, encoding: file.encoding ?? 'utf8'})),
      context: fixture.context ?? null,
    })),
    clarifications: challenge.clarifications ?? [],
    referenceFiles: pack(challenge.referenceFiles),
    candidates: (challenge.candidates ?? []).map((item) => ({
      id: item.id,
      expected: item.expected,
      evidenceVariant: item.evidenceVariant ?? null,
      deliveryFiles: pack(item.deliveryFiles),
    })),
  }));
}
