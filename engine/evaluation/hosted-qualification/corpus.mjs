import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const copy = (value) => structuredClone(value);
const jsonText = (value) => JSON.stringify(value);
const int = (value) => ({op: 'literal', type: 'i64', value: String(value)});
const str = (value) => ({op: 'literal', type: 'string', value});
const bool = (value) => ({op: 'literal', type: 'bool', value});
const lit = (value) => typeof value === 'boolean' ? bool(value) : typeof value === 'string' ? str(value) : int(value);
const bin = (op, left, right) => ({op, left, right});
const rf = (field, level = 0) => ({op: 'record_field', field, ...(level ? {level} : {})});
const access = (source, file, field = 'rows') => ({source, file, field});
const count = (collection, where) => ({op: 'count', collection, ...(where ? {where} : {})});
const sum = (collection, value) => ({op: 'sum', collection, value});
const all = (collection, where) => ({op: 'all', collection, where});
const unique = (collection, field) => ({op: 'unique', collection, field});
const lookup = (collection, keyField, key, valueField) => ({op: 'lookup', collection, keyField, key, valueField});
const fieldsOf = (spec) => Object.entries(spec).map(([name, type]) => ({name, type}));
const table = (name, spec) => ({name, parser: 'json/v1', collections: [{name: 'rows', fields: fieldsOf(spec)}]});
const scalar = (name, spec) => ({name, parser: 'json/v1', fields: fieldsOf(spec)});
const textFile = (name) => ({name, parser: 'text/v1'});
const opaqueFile = (name) => ({name, parser: 'opaque/v1'});
const planOf = (deliverables, references, rules, evidence = []) => ({
  version: 1,
  deliverables,
  references,
  ...(evidence.length ? {evidence} : {}),
  rules,
});
const requirement = (id, text) => ({id, text});
const candidate = (id, deliveryFiles, status = 'pass', violations = [], extra = {}) => ({
  id,
  deliveryFiles,
  expected: {
    status,
    verdict: status === 'pass' ? 1 : status === 'fail' ? 0 : null,
    violatedRequirements: violations,
  },
  ...extra,
});
const rowsFile = (name, rows) => ({[name]: jsonText({rows})});
const mutate = (value, change) => {
  const next = copy(value);
  change(next);
  return next;
};

function signingKey(other = false) {
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
const sha = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;

function finish(challenge) {
  return {
    ...challenge,
    classification: 'supported',
    schema: {
      deliverables: challenge.plan.deliverables,
      references: challenge.plan.references,
      evidence: challenge.plan.evidence ?? [],
    },
  };
}

function pierDrawers() {
  const rows = [
    {drawerId: 'drawer-a', countedCents: '400'},
    {drawerId: 'drawer-b', countedCents: '250'},
    {drawerId: 'drawer-c', countedCents: '125'},
  ];
  const text = 'Pier Saturday closed.\n';
  const delivery = access('deliverable', 'drawers.json');
  const reference = access('reference', 'floats.json');
  const requirements = [
    requirement('unique-drawer', 'Use each drawerId once.'),
    requirement('drawer-count', 'Include every drawer in floats.json.'),
    requirement('exact-count', 'Match each countedCents value to that drawer expectedCents value.'),
    requirement('closeout-text', 'Set closeout.txt to exactly "Pier Saturday closed.\\n".'),
  ];
  const rules = [
    unique(delivery, 'drawerId'),
    bin('eq', count(delivery), count(reference)),
    all(delivery, bin('eq', rf('countedCents'), lookup(reference, 'drawerId', rf('drawerId'), 'expectedCents'))),
    bin('eq', {op: 'field', source: 'deliverable', file: 'closeout.txt'}, str(text)),
  ];
  const files = (next = rows, label = text) => ({...rowsFile('drawers.json', next), 'closeout.txt': label});
  return finish({
    id: 'pier-drawers',
    family: 'pier-reconciliation',
    spec: {kind: 'drawer-exact', text},
    title: 'Reconcile Saturday pier drawers',
    prompt: 'Reconcile the Saturday pier drawers against floats.json. Amounts are integer cents as decimal strings. Use each drawerId once. Include every drawer in floats.json. Match each countedCents value to that drawer expectedCents value. Set closeout.txt to exactly "Pier Saturday closed.\\n". A second row order is acceptable. Do not treat one file hash as the only accepted answer.',
    requirements,
    plan: planOf(
      [table('drawers.json', {drawerId: 'string', countedCents: 'i64'}), textFile('closeout.txt')],
      [table('floats.json', {drawerId: 'string', expectedCents: 'i64'})],
      rules,
    ),
    referenceFiles: rowsFile('floats.json', rows.map((row) => ({drawerId: row.drawerId, expectedCents: row.countedCents}))),
    candidates: [
      candidate('valid', files()),
      candidate('valid-reordered', files([...rows].reverse())),
      candidate('duplicate-drawer', files(mutate(rows, (value) => {
        value[1].drawerId = value[0].drawerId;
        value[1].countedCents = value[0].countedCents;
      })), 'fail', ['unique-drawer']),
      candidate('missing-drawer', files(rows.slice(0, 2)), 'fail', ['drawer-count']),
      candidate('wrong-count', files(mutate(rows, (value) => {
        value[0].countedCents = '1';
      })), 'fail', ['exact-count']),
      candidate('wrong-closeout', files(rows, 'Pier Saturday closed.'), 'fail', ['closeout-text']),
      candidate('unknown-drawer', files(mutate(rows, (value) => {
        value[0].drawerId = 'drawer-z';
      })), 'reject', ['reference-membership']),
      candidate('numeric-amount', files(mutate(rows, (value) => {
        value[0].countedCents = 400;
      })), 'reject', ['input-types']),
    ],
  });
}

export function buildCorpus() {
  return [pierDrawers()];
}

export async function writeChallenge(challenge, directory) {
  const path = join(challenge.classification, challenge.id);
  const referencePath = join(path, 'reference');
  await mkdir(join(directory, referencePath), {recursive: true});
  for (const [name, bytes] of Object.entries(challenge.referenceFiles ?? {})) {
    await writeFile(join(directory, referencePath, name), bytes);
  }
  const candidates = [];
  for (const {deliveryFiles, ...item} of challenge.candidates ?? []) {
    const candidatePath = join(path, 'candidates', item.id);
    await mkdir(join(directory, candidatePath, 'delivery'), {recursive: true});
    await mkdir(join(directory, candidatePath, 'evidence'), {recursive: true});
    for (const [name, bytes] of Object.entries(deliveryFiles)) {
      await writeFile(join(directory, candidatePath, 'delivery', name), bytes);
    }
    candidates.push({...item, path: candidatePath});
  }
  return {...challenge, referencePath, candidates};
}

export async function writeCandidateEvidence(challenge, candidate, candidateDirectory, contextHex) {
  if (!challenge.plan?.evidence?.length) return;
  if (!/^0x01[0-9a-fA-F]{336}$/.test(contextHex ?? '')) throw Error('Expected a 169-byte version-1 context');
  const variant = candidate.evidenceVariant;
  const artifactName = challenge.spec.artifactFile;
  const artifactBytes = candidate.deliveryFiles[artifactName];
  const payload = {
    artifactHash: sha(Buffer.from(artifactBytes)),
    contextHash: sha(Buffer.from(contextHex.slice(2), 'hex')),
    ...challenge.spec.signedFields,
  };
  if (variant === 'replayed-context') payload.contextHash = `0x${'ab'.repeat(32)}`;
  if (variant === 'low-seal') payload.sealDay = String(BigInt(challenge.spec.minSealDay) - 1n);
  if (variant === 'at-threshold') payload.sealDay = String(challenge.spec.minSealDay);
  if (variant === 'wrong-custodian') payload.custodian = 'unapproved-custodian';
  if (variant === 'not-released') payload.released = false;
  if (variant === 'low-quantity') payload.quantity = '0';
  if (challenge.spec.secondArtifactFile) {
    const second = candidate.deliveryFiles[challenge.spec.secondArtifactFile];
    payload[challenge.spec.secondHashField] = sha(Buffer.from(second));
    if (variant === 'swapped-second') payload[challenge.spec.secondHashField] = sha(Buffer.from('other'));
  }
  const bytes = Buffer.from(JSON.stringify(payload, Object.keys(payload).sort()));
  const signature = sign(null, Buffer.concat([Buffer.from('UBC26/evidence/v1'), bytes]), signingKey(variant === 'wrong-signer'));
  if (variant === 'invalid-signature') signature[0] ^= 1;
  await mkdir(join(candidateDirectory, 'evidence'), {recursive: true});
  await writeFile(
    join(candidateDirectory, 'evidence', challenge.plan.evidence[0].name),
    `${JSON.stringify({payload: `0x${bytes.toString('hex')}`, signature: `0x${signature.toString('hex')}`})}\n`,
  );
}
