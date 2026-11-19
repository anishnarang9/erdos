// A separate, unqualified corpus revision. The third paid diagnostic used corpus.mjs unchanged.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {buildCorpus, canonicalCorpus, CORPUS_ID, CORPUS_DIGEST} from './corpus.mjs';

export const NEXT_CORPUS_ID = 'hosted-qualification-2026-11-18-public-examples';
export const PUBLIC_EXAMPLES_SHA256 = 'fd34b575cf3b2d2a7ad783ba2d8c848320fa6f736a39efa67fba041c43ec81d0';
export const NEXT_CORPUS_DIGEST = '8acf192a48f3c72a200a53ed628246a2fbdcbe339bcc4743253a7789d85f2cd7';

const bytes = readFileSync(new URL('./pilot-public-examples.json', import.meta.url));
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== PUBLIC_EXAMPLES_SHA256) throw new Error('Public example file changed');
const source = JSON.parse(bytes.toString('utf8'));
if (source.version !== 1 || source.corpusId !== CORPUS_ID || source.corpusDigest !== CORPUS_DIGEST ||
    !source.cases || typeof source.cases !== 'object' || Array.isArray(source.cases)) {
  throw new Error('Public examples do not match the base corpus');
}

export function buildNextCorpus() {
  const challenges = buildCorpus();
  const ids = new Set(challenges.map((item) => item.id));
  for (const id of Object.keys(source.cases)) if (!ids.has(id)) throw new Error(`Unknown public example case ${id}`);
  return challenges.map((challenge) => {
    const examples = source.cases[challenge.id];
    if (!examples) return challenge;
    if (challenge.classification !== 'supported' || challenge.exampleFixtures) {
      throw new Error(`Public examples conflict with ${challenge.id}`);
    }
    return {...challenge, exampleFixtures: structuredClone(examples)};
  });
}

export function canonicalNextCorpus(challenges = buildNextCorpus()) {
  return canonicalCorpus(challenges);
}
