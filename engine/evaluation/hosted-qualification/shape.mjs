import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const copy = (value) => structuredClone(value);
export const jsonText = (value) => JSON.stringify(value);
export const int = (value) => ({op: 'literal', type: 'i64', value: String(value)});
export const str = (value) => ({op: 'literal', type: 'string', value});
export const bool = (value) => ({op: 'literal', type: 'bool', value});
export const lit = (value) => typeof value === 'boolean' ? bool(value) : typeof value === 'string' ? str(value) : int(value);
export const bin = (op, left, right) => ({op, left, right});
export const rf = (field, level = 0) => ({op: 'record_field', field, ...(level ? {level} : {})});
export const access = (source, file, field = 'rows') => ({source, file, field});
export const count = (collection, where) => ({op: 'count', collection, ...(where ? {where} : {})});
export const sum = (collection, value) => ({op: 'sum', collection, value});
export const all = (collection, where) => ({op: 'all', collection, where});
export const unique = (collection, field) => ({op: 'unique', collection, field});
export const lookup = (collection, keyField, key, valueField) => ({op: 'lookup', collection, keyField, key, valueField});
const fieldsOf = (spec) => Object.entries(spec).map(([name, type]) => ({name, type}));
export const table = (name, spec) => ({name, parser: 'json/v1', collections: [{name: 'rows', fields: fieldsOf(spec)}]});
export const scalar = (name, spec) => ({name, parser: 'json/v1', fields: fieldsOf(spec)});
export const textFile = (name) => ({name, parser: 'text/v1'});
export const opaqueFile = (name) => ({name, parser: 'opaque/v1'});
export const planOf = (deliverables, references, rules, evidence = []) => ({
  version: 1,
  deliverables,
  references,
  ...(evidence.length ? {evidence} : {}),
  rules,
});
export const requirement = (id, text) => ({id, text});
export const candidate = (id, deliveryFiles, status = 'pass', violations = [], extra = {}) => ({
  id,
  deliveryFiles,
  expected: {
    status,
    verdict: status === 'pass' ? 1 : status === 'fail' ? 0 : null,
    violatedRequirements: violations,
  },
  ...extra,
});
export const rowsFile = (name, rows) => ({[name]: jsonText({rows})});
export const mutate = (value, change) => {
  const next = copy(value);
  change(next);
  return next;
};
export const outputsFor = (declarations) => declarations.map((file) => ({
  name: file.name,
  format: file.parser === 'text/v1' ? 'text' : file.parser === 'opaque/v1' ? 'binary' : 'json',
}));

export function signingKey(other = false) {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, other ? 0x32 : 0x31),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

export const syntheticSigner = `0x${createPublicKey(signingKey()).export({type: 'spki', format: 'der'}).subarray(-32).toString('hex')}`;
export const sha = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;

export function finish(challenge) {
  return {
    ...challenge,
    classification: 'supported',
    outputs: challenge.outputs ?? outputsFor(challenge.plan.deliverables),
    schema: {
      deliverables: challenge.plan.deliverables,
      references: challenge.plan.references,
      evidence: challenge.plan.evidence ?? [],
    },
  };
}

export async function writeChallenge(challenge, directory) {
  const path = join(challenge.classification, challenge.id);
  const referencePath = join(path, 'reference');
  await mkdir(join(directory, referencePath), {recursive: true});
  await mkdir(join(directory, path), {recursive: true});
  await writeFile(join(directory, path, 'challenge.txt'), `${challenge.prompt}\n`);
  if (challenge.plan) {
    await writeFile(join(directory, path, 'plan.json'), `${JSON.stringify(challenge.plan)}\n`);
  }
  if (challenge.unsupportedDraft) {
    await writeFile(join(directory, path, 'unsupported-plan.json'), `${JSON.stringify(challenge.unsupportedDraft)}\n`);
  }
  for (const [name, bytes] of Object.entries(challenge.referenceFiles ?? {})) {
    await writeFile(join(directory, referencePath, name), bytes);
  }
  const candidates = [];
  for (const item of challenge.candidates ?? []) {
    const candidatePath = join(path, 'candidates', item.id);
    await mkdir(join(directory, candidatePath, 'delivery'), {recursive: true});
    await mkdir(join(directory, candidatePath, 'evidence'), {recursive: true});
    for (const [name, bytes] of Object.entries(item.deliveryFiles)) {
      await writeFile(join(directory, candidatePath, 'delivery', name), bytes);
    }
    candidates.push({...item, path: candidatePath});
  }
  return {...challenge, referencePath, planPath: challenge.plan ? join(path, 'plan.json') : undefined, candidates};
}

export async function writeCandidateEvidence(challenge, candidate, candidateDirectory, contextHex) {
  if (!challenge.plan?.evidence?.length) return;
  if (!/^0x01[0-9a-fA-F]{336}$/.test(contextHex ?? '')) throw Error('Expected a 169-byte version-1 context');
  const variant = candidate.evidenceVariant;
  const artifactName = challenge.spec.artifactFile;
  const sourceBytes = variant === 'swapped-artifact' ? challenge.spec.artifactBytes : candidate.deliveryFiles[artifactName];
  const payload = {
    artifactHash: sha(Buffer.from(sourceBytes)),
    contextHash: sha(Buffer.from(contextHex.slice(2), 'hex')),
    ...challenge.spec.signedFields,
  };
  if (variant === 'replayed-context') payload.contextHash = `0x${'cd'.repeat(32)}`;
  if (variant === 'low-seal') payload.sealDay = String(BigInt(challenge.spec.minSealDay) - 1n);
  if (variant === 'at-threshold') payload.sealDay = String(challenge.spec.minSealDay);
  if (variant === 'wrong-custodian') payload.custodian = 'unapproved-custodian';
  if (variant === 'not-released') payload.released = false;
  if (variant === 'low-quantity') payload.quantity = '0';
  if (challenge.spec.secondArtifactFile) {
    const secondName = challenge.spec.secondArtifactFile;
    const secondBytes = variant === 'swapped-second' ? Buffer.from('other-tag') : candidate.deliveryFiles[secondName];
    payload[challenge.spec.secondHashField] = sha(Buffer.from(secondBytes));
  }
  const bytes = Buffer.from(JSON.stringify(payload, Object.keys(payload).sort()));
  const signature = sign(null, Buffer.concat([Buffer.from('UBC26/evidence/v1'), bytes]), signingKey(variant === 'wrong-signer'));
  if (variant === 'invalid-signature') signature[0] ^= 1;
  await mkdir(join(candidateDirectory, 'evidence'), {recursive: true});
  await writeFile(
    join(candidateDirectory, 'evidence', challenge.plan.evidence[0].name),
    JSON.stringify({payload: `0x${bytes.toString('hex')}`, signature: `0x${signature.toString('hex')}`}),
  );
}
