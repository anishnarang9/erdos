import {
  bin, candidate, finish, int, jsonText, opaqueFile, planOf, requirement, scalar, str, textFile,
} from './shape.mjs';

const hash = (source, file) => ({op: 'file_hash', source, file});
const size = (file) => ({op: 'file_size', source: 'deliverable', file});
const deliverableField = (file, field) => ({op: 'field', source: 'deliverable', file, field});
const referenceField = (file, field) => ({op: 'field', source: 'reference', file, field});
const image = Buffer.from('fw-image-v3');
const boot = Buffer.from('boot-slot-a');
const app = Buffer.from('app-slot-b');
const blob = Buffer.from([0xff, 0xfe, 0x00, 0x61]);

function firmwareImage() {
  const files = (body, appendix, build) => ({
    'image.bin': body,
    'appendix.bin': appendix,
    'meta.json': jsonText({build}),
  });
  return finish({
    id: 'firmware-1',
    family: 'firmware-file',
    spec: {kind: 'firmware-image', file: 'appendix.bin', minSize: 4, maxSize: 8},
    title: 'Firmware image and appendix',
    prompt: 'Deliver image.bin, appendix.bin, and meta.json. image.bin must have the same sha256 as the reference image.bin. appendix.bin is 4 to 8 bytes. meta.json build equals channel.json build. Another appendix length inside that window is acceptable.',
    requirements: [
      requirement('image-hash', 'Match the reference image sha256.'),
      requirement('min-size', 'Keep appendix.bin at or above 4 bytes.'),
      requirement('max-size', 'Keep appendix.bin at or below 8 bytes.'),
      requirement('build-label', 'Match the channel build string.'),
    ],
    plan: planOf(
      [opaqueFile('image.bin'), opaqueFile('appendix.bin'), scalar('meta.json', {build: 'string'})],
      [opaqueFile('image.bin'), scalar('channel.json', {build: 'string'})],
      [
        bin('eq', hash('deliverable', 'image.bin'), hash('reference', 'image.bin')),
        bin('gte', size('appendix.bin'), int(4)),
        bin('lte', size('appendix.bin'), int(8)),
        bin('eq', deliverableField('meta.json', 'build'), referenceField('channel.json', 'build')),
      ],
    ),
    referenceFiles: {'image.bin': image, 'channel.json': jsonText({build: 'stable'})},
    candidates: [
      candidate('valid-four', files(image, Buffer.alloc(4, 0x21), 'stable')),
      candidate('valid-five', files(image, Buffer.alloc(5, 0x21), 'stable')),
      candidate('wrong-image', files(Buffer.from('fw-image-v4'), Buffer.alloc(4, 0x21), 'stable'), 'fail', ['image-hash']),
      candidate('short-appendix', files(image, Buffer.alloc(3, 0x21), 'stable'), 'fail', ['min-size']),
      candidate('long-appendix', files(image, Buffer.alloc(9, 0x21), 'stable'), 'fail', ['max-size']),
      candidate('wrong-build', files(image, Buffer.alloc(4, 0x21), 'beta'), 'fail', ['build-label']),
      candidate('numeric-build', files(image, Buffer.alloc(4, 0x21), 1), 'reject', ['input-types']),
    ],
  });
}

function firmwarePair() {
  const files = (bootBytes, appBytes, slot) => ({
    'boot.bin': bootBytes,
    'app.bin': appBytes,
    'slot.json': jsonText({slot}),
  });
  return finish({
    id: 'firmware-pair-1',
    family: 'firmware-file',
    spec: {kind: 'firmware-pair', minSlot: 1, maxSlot: 2},
    title: 'Paired boot and app images',
    prompt: 'Deliver boot.bin, app.bin, and slot.json. boot.bin must have the same sha256 as the reference boot.bin. app.bin must have the same sha256 as the reference app.bin. slot is an integer decimal string from 1 through 2. Another slot inside that range is acceptable.',
    requirements: [
      requirement('boot-hash', 'Match the reference boot sha256.'),
      requirement('app-hash', 'Match the reference app sha256.'),
      requirement('slot-domain', 'Use slot 1 or slot 2.'),
    ],
    plan: planOf(
      [opaqueFile('boot.bin'), opaqueFile('app.bin'), scalar('slot.json', {slot: 'i64'})],
      [opaqueFile('boot.bin'), opaqueFile('app.bin')],
      [
        bin('eq', hash('deliverable', 'boot.bin'), hash('reference', 'boot.bin')),
        bin('eq', hash('deliverable', 'app.bin'), hash('reference', 'app.bin')),
        bin('and', bin('gte', deliverableField('slot.json', 'slot'), int(1)), bin('lte', deliverableField('slot.json', 'slot'), int(2))),
      ],
    ),
    referenceFiles: {'boot.bin': boot, 'app.bin': app},
    candidates: [
      candidate('valid-one', files(boot, app, '1')),
      candidate('valid-two', files(boot, app, '2')),
      candidate('wrong-boot', files(Buffer.from('boot-slot-z'), app, '1'), 'fail', ['boot-hash']),
      candidate('wrong-app', files(boot, Buffer.from('app-slot-z'), '1'), 'fail', ['app-hash']),
      candidate('slot-zero', files(boot, app, '0'), 'fail', ['slot-domain']),
      candidate('numeric-slot', files(boot, app, 1), 'reject', ['input-types']),
    ],
  });
}

function firmwareNote() {
  const text = 'Firmware note café\n';
  const files = (body, pad) => ({'notice.txt': body, 'pad.bin': pad});
  return finish({
    id: 'firmware-note-1',
    family: 'firmware-file',
    spec: {kind: 'firmware-note', text, file: 'pad.bin', minSize: 2, maxSize: 6},
    title: 'Firmware notice text',
    prompt: 'Deliver notice.txt and pad.bin. notice.txt is exactly "Firmware note café\\n". pad.bin is 2 to 6 bytes. Another pad length inside that window is acceptable.',
    requirements: [
      requirement('note-text', 'Set notice.txt to exactly "Firmware note café\\n".'),
      requirement('min-size', 'Keep pad.bin at or above 2 bytes.'),
      requirement('max-size', 'Keep pad.bin at or below 6 bytes.'),
    ],
    plan: planOf(
      [textFile('notice.txt'), opaqueFile('pad.bin')],
      [],
      [
        bin('eq', {op: 'field', source: 'deliverable', file: 'notice.txt'}, str(text)),
        bin('gte', size('pad.bin'), int(2)),
        bin('lte', size('pad.bin'), int(6)),
      ],
    ),
    referenceFiles: {},
    candidates: [
      candidate('valid-two', files(text, Buffer.alloc(2, 0x31))),
      candidate('valid-three', files(text, Buffer.alloc(3, 0x31))),
      candidate('missing-newline', files('Firmware note café', Buffer.alloc(2, 0x31)), 'fail', ['note-text']),
      candidate('short-pad', files(text, Buffer.alloc(1, 0x31)), 'fail', ['min-size']),
      candidate('long-pad', files(text, Buffer.alloc(7, 0x31)), 'fail', ['max-size']),
      candidate('invalid-text', files(Buffer.from([0xff, 0xfe]), Buffer.alloc(2, 0x31)), 'reject', ['input-types']),
    ],
  });
}

function firmwareOpaque() {
  const files = (body, pad, build) => ({
    'blob.bin': body,
    'pad.bin': pad,
    'meta.json': jsonText({build}),
  });
  return finish({
    id: 'firmware-opaque-1',
    family: 'firmware-file',
    spec: {kind: 'firmware-opaque', file: 'pad.bin', minSize: 1, maxSize: 3},
    title: 'Opaque firmware blob',
    prompt: 'Deliver blob.bin, pad.bin, and meta.json. blob.bin must have the same sha256 as the reference blob.bin. pad.bin is 1 to 3 bytes. meta.json build equals channel.json build. Another pad length inside that window is acceptable.',
    requirements: [
      requirement('image-hash', 'Match the reference blob sha256.'),
      requirement('min-size', 'Keep pad.bin at or above 1 byte.'),
      requirement('max-size', 'Keep pad.bin at or below 3 bytes.'),
      requirement('build-label', 'Match the channel build string.'),
    ],
    plan: planOf(
      [opaqueFile('blob.bin'), opaqueFile('pad.bin'), scalar('meta.json', {build: 'string'})],
      [opaqueFile('blob.bin'), scalar('channel.json', {build: 'string'})],
      [
        bin('eq', hash('deliverable', 'blob.bin'), hash('reference', 'blob.bin')),
        bin('gte', size('pad.bin'), int(1)),
        bin('lte', size('pad.bin'), int(3)),
        bin('eq', deliverableField('meta.json', 'build'), referenceField('channel.json', 'build')),
      ],
    ),
    referenceFiles: {'blob.bin': blob, 'channel.json': jsonText({build: 'locked'})},
    candidates: [
      candidate('valid-one', files(blob, Buffer.alloc(1, 0x41), 'locked')),
      candidate('valid-two', files(blob, Buffer.alloc(2, 0x41), 'locked')),
      candidate('wrong-blob', files(Buffer.from([0xff, 0xfe, 0x00, 0x62]), Buffer.alloc(1, 0x41), 'locked'), 'fail', ['image-hash']),
      candidate('empty-pad', files(blob, Buffer.alloc(0), 'locked'), 'fail', ['min-size']),
      candidate('long-pad', files(blob, Buffer.alloc(4, 0x41), 'locked'), 'fail', ['max-size']),
      candidate('wrong-build', files(blob, Buffer.alloc(1, 0x41), 'beta'), 'fail', ['build-label']),
      candidate('numeric-build', files(blob, Buffer.alloc(1, 0x41), 1), 'reject', ['input-types']),
    ],
  });
}

export function firmwareChallenges() {
  return [firmwareImage(), firmwarePair(), firmwareNote(), firmwareOpaque()];
}
