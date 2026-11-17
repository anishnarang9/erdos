import {
  bin, bool, candidate, evidenceEnvelope, finish, int, jsonText, planOf, requirement, scalar, sha, str,
  syntheticSigner, textFile,
} from './shape.mjs';

const SYNTHETIC_CHAIN = 'aa'.repeat(32);
const SYNTHETIC_ESCROW = 'bb'.repeat(20);
const SYNTHETIC_JOB = 'cc'.repeat(32);
const SYNTHETIC_PROVIDER = 'dd'.repeat(20);
// Eval requires these rules hashes in the preview context. Chain, escrow, job, and provider bytes stay synthetic.
const SEAL_RULES = '0x3d60fa90aa6ef57319df67b5b34099a9f846d1a235f1b693a4c9564692a980c0';
const CRATE_RULES = '0x5450922c1388b9ae835f60088cff26d8c9403ae887d7becbf5a714b910a77793';
const TRANSFER_RULES = '0x80e66a4b176ba5ebb9a7b87e6573c936fcaa99597e739a2921c4bcb69cd3ba00';
const DUAL_RULES = '0x2ee91e1c0316712e69933f61dd2b74598f7b10f0f2490ef70c2ec0f136d79b80';

function encodeReference(files) {
  const names = Object.keys(files).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const header = Buffer.alloc(3);
  header[0] = 1;
  header.writeUInt16BE(names.length, 1);
  const chunks = [header];
  for (const name of names) {
    const bytes = Buffer.from(files[name]);
    const filename = Buffer.from(name);
    const nameLength = Buffer.alloc(2);
    const byteLength = Buffer.alloc(4);
    nameLength.writeUInt16BE(filename.length);
    byteLength.writeUInt32BE(bytes.length);
    chunks.push(nameLength, filename, byteLength, bytes);
  }
  return Buffer.concat(chunks);
}

export function previewContext(rulesHash, referenceFiles) {
  const referenceHash = sha(Buffer.concat([Buffer.from('UBC26/reference/v1'), encodeReference(referenceFiles)]));
  return `0x01${SYNTHETIC_CHAIN}${SYNTHETIC_ESCROW}${SYNTHETIC_JOB}${SYNTHETIC_PROVIDER}${rulesHash.slice(2)}${referenceHash.slice(2)}`;
}

function illustrativeFixtures(spec, context, passFiles, failFiles, failOverrides) {
  const one = (name, predictedVerdict, files, overrides) => {
    const payload = {
      artifactHash: sha(Buffer.from(files[spec.artifactFile])),
      contextHash: sha(Buffer.from(context.slice(2), 'hex')),
      ...spec.signedFields,
      ...overrides,
    };
    if (spec.secondArtifactFile) {
      payload[spec.secondHashField] = sha(Buffer.from(files[spec.secondArtifactFile]));
    }
    return {
      name,
      predictedVerdict,
      files: Object.entries(files).map(([fileName, content]) => ({name: fileName, content, encoding: 'utf8'})),
      evidence: [{name: 'custody.json', content: evidenceEnvelope(payload), encoding: 'utf8'}],
      context,
    };
  };
  return [
    one('illustrative-pass', 1, passFiles, {}),
    one('illustrative-verdict-0', 0, failFiles, failOverrides),
  ];
}

const approvedKey = ` The approved Ed25519 public key is ${syntheticSigner}.`;

const evidenceField = (field) => ({op: 'field', source: 'evidence', file: 'custody.json', field});
const referenceField = (file, field) => ({op: 'field', source: 'reference', file, field});

function custodyPlan(deliverables, references, evidenceFields, bindings, rules) {
  return planOf(deliverables, references, rules, [{
    name: 'custody.json',
    profile: 'ed25519/v1',
    signer: syntheticSigner,
    parser: 'json/v1',
    fields: [
      {name: 'artifactHash', type: 'string'},
      {name: 'contextHash', type: 'string'},
      ...evidenceFields,
    ],
    bindings,
    contextField: 'contextHash',
  }]);
}

function sealTask() {
  const alpha = 'Pier label alpha.\n';
  const beta = 'Pier label beta.\n';
  const file = (body) => ({'label.txt': body});
  const spec = {
    kind: 'custody-seal',
    artifactFile: 'label.txt',
    artifactBytes: 'other-label\n',
    minSealDay: '200',
    approvedCustodian: 'pier-clerk',
    signedFields: {sealDay: '214', custodian: 'pier-clerk', released: true},
  };
  return finish({
    id: 'seal-1',
    family: 'custody-signature',
    spec,
    title: 'Pier label custody seal',
    prompt: `Deliver label.txt for a released pier item. custody.json is an ed25519 envelope. Its payload binds sha256(label.txt) as artifactHash and sha256 of the job context as contextHash. sealDay is an integer decimal string and is at least 200. custodian is pier-clerk. released is true. Another label with a valid seal is acceptable.${approvedKey}`,
    exampleFixtures: illustrativeFixtures(
      spec,
      previewContext(SEAL_RULES, {}),
      {'label.txt': 'Public pier label pass.\n'},
      {'label.txt': 'Public pier label low.\n'},
      {sealDay: '199'},
    ),
    requirements: [
      requirement('seal-day', 'Keep sealDay at or above 200.'),
      requirement('custodian', 'Name the custodian pier-clerk.'),
      requirement('released', 'Mark the item released.'),
      requirement('artifact-binding', 'Bind artifactHash to label.txt.'),
      requirement('context-binding', 'Bind contextHash to this job context.'),
      requirement('signature', 'Authenticate the payload with the approved key.'),
    ],
    plan: custodyPlan(
      [textFile('label.txt')],
      [],
      [{name: 'sealDay', type: 'i64'}, {name: 'custodian', type: 'string'}, {name: 'released', type: 'bool'}],
      [{field: 'artifactHash', file: 'label.txt'}],
      [
        bin('gte', evidenceField('sealDay'), int(200)),
        bin('eq', evidenceField('custodian'), str('pier-clerk')),
        bin('eq', evidenceField('released'), bool(true)),
      ],
    ),
    referenceFiles: {},
    candidates: [
      candidate('valid', file(alpha)),
      candidate('valid-beta', file(beta)),
      candidate('at-threshold', file(alpha), 'pass', [], {evidenceVariant: 'at-threshold'}),
      candidate('low-seal', file(alpha), 'fail', ['seal-day'], {evidenceVariant: 'low-seal'}),
      candidate('wrong-custodian', file(alpha), 'fail', ['custodian'], {evidenceVariant: 'wrong-custodian'}),
      candidate('not-released', file(alpha), 'fail', ['released'], {evidenceVariant: 'not-released'}),
      candidate('swapped-artifact', file(alpha), 'reject', ['artifact-binding'], {evidenceVariant: 'swapped-artifact'}),
      candidate('replayed-context', file(alpha), 'reject', ['context-binding'], {evidenceVariant: 'replayed-context'}),
      candidate('invalid-signature', file(alpha), 'reject', ['signature'], {evidenceVariant: 'invalid-signature'}),
      candidate('wrong-signer', file(alpha), 'reject', ['signature'], {evidenceVariant: 'wrong-signer'}),
    ],
  });
}

function crateTask() {
  const alpha = 'Crate card alpha.\n';
  const beta = 'Crate card beta.\n';
  const file = (body) => ({'card.txt': body});
  const spec = {
    kind: 'custody-crate',
    artifactFile: 'card.txt',
    artifactBytes: 'other-card\n',
    minSealDay: '180',
    approvedCustodian: 'yard-warden',
    signedFields: {sealDay: '190', custodian: 'yard-warden', crateId: 'crate-14'},
  };
  const referenceFiles = {'release.json': jsonText({crateId: 'crate-14', minSealDay: '180'})};
  return finish({
    id: 'crate-1',
    family: 'custody-signature',
    spec,
    title: 'Yard crate custody card',
    prompt: `Deliver card.txt for crate release. custody.json is an ed25519 envelope. Its payload binds sha256(card.txt) as artifactHash and sha256 of the job context as contextHash. sealDay is an integer decimal string and is at least release.json minSealDay. custodian is yard-warden. crateId equals release.json crateId. Another card with a valid seal is acceptable.${approvedKey}`,
    exampleFixtures: illustrativeFixtures(
      spec,
      previewContext(CRATE_RULES, referenceFiles),
      {'card.txt': 'Public crate card pass.\n'},
      {'card.txt': 'Public crate card low.\n'},
      {sealDay: '179'},
    ),
    requirements: [
      requirement('seal-day', 'Keep sealDay at or above minSealDay.'),
      requirement('custodian', 'Name the custodian yard-warden.'),
      requirement('crate-id', 'Use the released crateId.'),
      requirement('artifact-binding', 'Bind artifactHash to card.txt.'),
      requirement('context-binding', 'Bind contextHash to this job context.'),
      requirement('signature', 'Authenticate the payload with the approved key.'),
    ],
    plan: custodyPlan(
      [textFile('card.txt')],
      [scalar('release.json', {crateId: 'string', minSealDay: 'i64'})],
      [{name: 'sealDay', type: 'i64'}, {name: 'custodian', type: 'string'}, {name: 'crateId', type: 'string'}],
      [{field: 'artifactHash', file: 'card.txt'}],
      [
        bin('gte', evidenceField('sealDay'), referenceField('release.json', 'minSealDay')),
        bin('eq', evidenceField('custodian'), str('yard-warden')),
        bin('eq', evidenceField('crateId'), referenceField('release.json', 'crateId')),
      ],
    ),
    referenceFiles,
    candidates: [
      candidate('valid', file(alpha)),
      candidate('valid-beta', file(beta)),
      candidate('at-threshold', file(alpha), 'pass', [], {evidenceVariant: 'at-threshold'}),
      candidate('low-seal', file(alpha), 'fail', ['seal-day'], {evidenceVariant: 'low-seal'}),
      candidate('wrong-custodian', file(alpha), 'fail', ['custodian'], {evidenceVariant: 'wrong-custodian'}),
      candidate('wrong-crate', file(alpha), 'fail', ['crate-id'], {evidenceVariant: 'wrong-crate'}),
      candidate('swapped-artifact', file(alpha), 'reject', ['artifact-binding'], {evidenceVariant: 'swapped-artifact'}),
      candidate('replayed-context', file(alpha), 'reject', ['context-binding'], {evidenceVariant: 'replayed-context'}),
      candidate('invalid-signature', file(alpha), 'reject', ['signature'], {evidenceVariant: 'invalid-signature'}),
      candidate('wrong-signer', file(alpha), 'reject', ['signature'], {evidenceVariant: 'wrong-signer'}),
    ],
  });
}

function transferTask() {
  const alpha = 'Transfer slip alpha.\n';
  const beta = 'Transfer slip beta.\n';
  const file = (body) => ({'slip.txt': body});
  const spec = {
    kind: 'custody-transfer',
    artifactFile: 'slip.txt',
    artifactBytes: 'other-slip\n',
    minSealDay: '210',
    approvedCustodian: 'bay-runner',
    signedFields: {sealDay: '240', custodian: 'bay-runner', released: true, quantity: '4'},
  };
  return finish({
    id: 'transfer-1',
    family: 'custody-signature',
    spec,
    title: 'Bay transfer custody slip',
    prompt: `Deliver slip.txt for a released transfer. custody.json is an ed25519 envelope. Its payload binds sha256(slip.txt) as artifactHash and sha256 of the job context as contextHash. sealDay is an integer decimal string and is at least 210. custodian is bay-runner. released is true. quantity is an integer decimal string and is at least 1. Another slip with a valid seal is acceptable.${approvedKey}`,
    exampleFixtures: illustrativeFixtures(
      spec,
      previewContext(TRANSFER_RULES, {}),
      {'slip.txt': 'Public transfer slip pass.\n'},
      {'slip.txt': 'Public transfer slip low.\n'},
      {quantity: '0'},
    ),
    requirements: [
      requirement('seal-day', 'Keep sealDay at or above 210.'),
      requirement('custodian', 'Name the custodian bay-runner.'),
      requirement('released', 'Mark the transfer released.'),
      requirement('quantity', 'Keep quantity at or above 1.'),
      requirement('artifact-binding', 'Bind artifactHash to slip.txt.'),
      requirement('context-binding', 'Bind contextHash to this job context.'),
      requirement('signature', 'Authenticate the payload with the approved key.'),
    ],
    plan: custodyPlan(
      [textFile('slip.txt')],
      [],
      [
        {name: 'sealDay', type: 'i64'},
        {name: 'custodian', type: 'string'},
        {name: 'released', type: 'bool'},
        {name: 'quantity', type: 'i64'},
      ],
      [{field: 'artifactHash', file: 'slip.txt'}],
      [
        bin('gte', evidenceField('sealDay'), int(210)),
        bin('eq', evidenceField('custodian'), str('bay-runner')),
        bin('eq', evidenceField('released'), bool(true)),
        bin('gte', evidenceField('quantity'), int(1)),
      ],
    ),
    referenceFiles: {},
    candidates: [
      candidate('valid', file(alpha)),
      candidate('valid-beta', file(beta)),
      candidate('at-threshold', file(alpha), 'pass', [], {evidenceVariant: 'at-threshold'}),
      candidate('low-seal', file(alpha), 'fail', ['seal-day'], {evidenceVariant: 'low-seal'}),
      candidate('wrong-custodian', file(alpha), 'fail', ['custodian'], {evidenceVariant: 'wrong-custodian'}),
      candidate('not-released', file(alpha), 'fail', ['released'], {evidenceVariant: 'not-released'}),
      candidate('low-quantity', file(alpha), 'fail', ['quantity'], {evidenceVariant: 'low-quantity'}),
      candidate('swapped-artifact', file(alpha), 'reject', ['artifact-binding'], {evidenceVariant: 'swapped-artifact'}),
      candidate('replayed-context', file(alpha), 'reject', ['context-binding'], {evidenceVariant: 'replayed-context'}),
      candidate('invalid-signature', file(alpha), 'reject', ['signature'], {evidenceVariant: 'invalid-signature'}),
      candidate('wrong-signer', file(alpha), 'reject', ['signature'], {evidenceVariant: 'wrong-signer'}),
    ],
  });
}

function dualTask() {
  const files = (manifest, tag) => ({'manifest.txt': manifest, 'tag.txt': tag});
  const spec = {
    kind: 'custody-dual',
    artifactFile: 'manifest.txt',
    artifactBytes: 'other-manifest\n',
    secondArtifactFile: 'tag.txt',
    secondHashField: 'tagHash',
    minSealDay: '190',
    approvedCustodian: 'vault-scribe',
    signedFields: {sealDay: '205', custodian: 'vault-scribe', released: true},
  };
  return finish({
    id: 'dual-seal-1',
    family: 'custody-signature',
    spec,
    title: 'Vault manifest and tag seal',
    prompt: `Deliver manifest.txt and tag.txt for a released vault item. custody.json is an ed25519 envelope. Its payload binds sha256(manifest.txt) as artifactHash, sha256(tag.txt) as tagHash, and sha256 of the job context as contextHash. sealDay is an integer decimal string and is at least 190. custodian is vault-scribe. released is true. Another pair of files with a valid seal is acceptable.${approvedKey}`,
    exampleFixtures: illustrativeFixtures(
      spec,
      previewContext(DUAL_RULES, {}),
      {'manifest.txt': 'Public vault manifest pass.\n', 'tag.txt': 'Public vault tag pass.\n'},
      {'manifest.txt': 'Public vault manifest low.\n', 'tag.txt': 'Public vault tag low.\n'},
      {sealDay: '189'},
    ),
    requirements: [
      requirement('seal-day', 'Keep sealDay at or above 190.'),
      requirement('custodian', 'Name the custodian vault-scribe.'),
      requirement('released', 'Mark the item released.'),
      requirement('artifact-binding', 'Bind artifactHash to manifest.txt.'),
      requirement('second-binding', 'Bind tagHash to tag.txt.'),
      requirement('context-binding', 'Bind contextHash to this job context.'),
      requirement('signature', 'Authenticate the payload with the approved key.'),
    ],
    plan: custodyPlan(
      [textFile('manifest.txt'), textFile('tag.txt')],
      [],
      [
        {name: 'tagHash', type: 'string'},
        {name: 'sealDay', type: 'i64'},
        {name: 'custodian', type: 'string'},
        {name: 'released', type: 'bool'},
      ],
      [{field: 'artifactHash', file: 'manifest.txt'}, {field: 'tagHash', file: 'tag.txt'}],
      [
        bin('gte', evidenceField('sealDay'), int(190)),
        bin('eq', evidenceField('custodian'), str('vault-scribe')),
        bin('eq', evidenceField('released'), bool(true)),
      ],
    ),
    referenceFiles: {},
    candidates: [
      candidate('valid', files('Vault manifest alpha.\n', 'Vault tag alpha.\n')),
      candidate('valid-beta', files('Vault manifest beta.\n', 'Vault tag beta.\n')),
      candidate('at-threshold', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'pass', [], {evidenceVariant: 'at-threshold'}),
      candidate('low-seal', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'fail', ['seal-day'], {evidenceVariant: 'low-seal'}),
      candidate('wrong-custodian', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'fail', ['custodian'], {evidenceVariant: 'wrong-custodian'}),
      candidate('not-released', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'fail', ['released'], {evidenceVariant: 'not-released'}),
      candidate('swapped-artifact', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'reject', ['artifact-binding'], {evidenceVariant: 'swapped-artifact'}),
      candidate('swapped-second', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'reject', ['second-binding'], {evidenceVariant: 'swapped-second'}),
      candidate('replayed-context', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'reject', ['context-binding'], {evidenceVariant: 'replayed-context'}),
      candidate('invalid-signature', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'reject', ['signature'], {evidenceVariant: 'invalid-signature'}),
      candidate('wrong-signer', files('Vault manifest alpha.\n', 'Vault tag alpha.\n'), 'reject', ['signature'], {evidenceVariant: 'wrong-signer'}),
    ],
  });
}

export function custodyChallenges() {
  return [sealTask(), crateTask(), transferTask(), dualTask()];
}
