import {
  access, all, any, bin, bool, candidate, count, finish, int, jsonText, lookup, mutate, planOf,
  requirement, rf, rowsFile, scalar, sum, table, unique,
} from './shape.mjs';

const refField = (file, field) => ({op: 'field', source: 'reference', file, field});

function badgeZone() {
  const badges = [{badgeId: 'badge-a', zone: 'dock'}, {badgeId: 'badge-b', zone: 'gate'}];
  const rows = [
    {badgeId: 'badge-a', zone: 'dock', minute: '10'},
    {badgeId: 'badge-b', zone: 'gate', minute: '0'},
  ];
  const scans = access('deliverable', 'scans.json');
  const reference = access('reference', 'badges.json');
  const files = (next) => rowsFile('scans.json', next);
  return finish({
    id: 'badge-zone-1',
    family: 'badge-policy',
    spec: {kind: 'badge-zone'},
    title: 'Check badge zones and entry minutes',
    prompt: 'Check badge scans against badges.json. Minutes are integer decimal strings. Use each badgeId once. Each zone equals that badge zone. Each minute is from window.json minMinute through maxMinute. Another in-window minute is acceptable.',
    requirements: [
      requirement('unique-badge', 'Use each badgeId once.'),
      requirement('zone-match', 'Match each zone to that badge.'),
      requirement('entry-window', 'Keep each minute inside the entry window.'),
    ],
    plan: planOf(
      [table('scans.json', {badgeId: 'string', zone: 'string', minute: 'i64'})],
      [table('badges.json', {badgeId: 'string', zone: 'string'}), scalar('window.json', {minMinute: 'i64', maxMinute: 'i64'})],
      [
        unique(scans, 'badgeId'),
        all(scans, bin('eq', rf('zone'), lookup(reference, 'badgeId', rf('badgeId'), 'zone'))),
        all(scans, bin('gte', rf('minute'), refField('window.json', 'minMinute'))),
        all(scans, bin('lte', rf('minute'), refField('window.json', 'maxMinute'))),
      ],
    ),
    referenceFiles: {...rowsFile('badges.json', badges), 'window.json': jsonText({minMinute: '0', maxMinute: '30'})},
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-later', files([
        {badgeId: 'badge-a', zone: 'dock', minute: '30'},
        {badgeId: 'badge-b', zone: 'gate', minute: '15'},
      ])),
      candidate('duplicate-badge', files([
        {badgeId: 'badge-a', zone: 'dock', minute: '10'},
        {badgeId: 'badge-a', zone: 'dock', minute: '10'},
      ]), 'fail', ['unique-badge']),
      candidate('wrong-zone', files(mutate(rows, (value) => {
        value[0].zone = 'pier';
      })), 'fail', ['zone-match']),
      candidate('late-minute', files(mutate(rows, (value) => {
        value[0].minute = '31';
      })), 'fail', ['entry-window']),
      candidate('unknown-badge', files(mutate(rows, (value) => {
        value[0].badgeId = 'badge-z';
      })), 'reject', ['reference-membership']),
      candidate('numeric-minute', files(mutate(rows, (value) => {
        value[0].minute = 10;
      })), 'reject', ['input-types']),
    ],
  });
}

function clearanceLevel() {
  const posts = [{postId: 'post-a', required: '2'}, {postId: 'post-b', required: '4'}];
  const rows = [{postId: 'post-a', level: '2'}, {postId: 'post-b', level: '4'}];
  const grants = access('deliverable', 'grants.json');
  const reference = access('reference', 'posts.json');
  const files = (next) => rowsFile('grants.json', next);
  return finish({
    id: 'clearance-1',
    family: 'badge-policy',
    spec: {kind: 'clearance-level'},
    title: 'Check post clearance levels',
    prompt: 'Check clearance grants against posts.json. Levels are integer decimal strings. Use each postId once. Include every post. Each level is at least that post required level. A higher level is acceptable.',
    requirements: [
      requirement('unique-post', 'Use each postId once.'),
      requirement('post-count', 'Include every post.'),
      requirement('clearance', 'Keep each level at or above the required level.'),
    ],
    plan: planOf(
      [table('grants.json', {postId: 'string', level: 'i64'})],
      [table('posts.json', {postId: 'string', required: 'i64'})],
      [
        unique(grants, 'postId'),
        bin('eq', count(grants), count(reference)),
        all(grants, bin('gte', rf('level'), lookup(reference, 'postId', rf('postId'), 'required'))),
      ],
    ),
    referenceFiles: rowsFile('posts.json', posts),
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-higher', files([{postId: 'post-a', level: '5'}, {postId: 'post-b', level: '7'}])),
      candidate('duplicate-post', files([{postId: 'post-a', level: '2'}, {postId: 'post-a', level: '2'}]), 'fail', ['unique-post']),
      candidate('missing-post', files(rows.slice(0, 1)), 'fail', ['post-count']),
      candidate('low-clearance', files(mutate(rows, (value) => {
        value[0].level = '1';
      })), 'fail', ['clearance']),
      candidate('unknown-post', files(mutate(rows, (value) => {
        value[0].postId = 'post-z';
      })), 'reject', ['reference-membership']),
      candidate('numeric-level', files(mutate(rows, (value) => {
        value[0].level = 2;
      })), 'reject', ['input-types']),
    ],
  });
}

function queueCap() {
  const desks = [
    {deskId: 'desk-n', open: true},
    {deskId: 'desk-s', open: true},
    {deskId: 'desk-z', open: false},
  ];
  const tickets = access('deliverable', 'tickets.json');
  const reference = access('reference', 'desks.json');
  const files = (next) => rowsFile('tickets.json', next);
  const openPair = [
    {ticketId: 'ticket-1', deskId: 'desk-n'},
    {ticketId: 'ticket-2', deskId: 'desk-s'},
  ];
  return finish({
    id: 'queue-1',
    family: 'badge-policy',
    spec: {kind: 'queue-cap'},
    title: 'Check the badge desk queue',
    prompt: 'Check the badge desk queue. Use each ticketId once. The number of tickets is at most queue.json cap. Each deskId is an open desk in desks.json. A closed desk is a policy failure, not a missing desk. A second open queue inside the cap is acceptable.',
    requirements: [
      requirement('unique-ticket', 'Use each ticketId once.'),
      requirement('queue-cap', 'Keep the ticket count at or below cap.'),
      requirement('desk-open', 'Use only desks whose open flag is true.'),
    ],
    plan: planOf(
      [table('tickets.json', {ticketId: 'string', deskId: 'string'})],
      [table('desks.json', {deskId: 'string', open: 'bool'}), scalar('queue.json', {cap: 'i64'})],
      [
        unique(tickets, 'ticketId'),
        bin('lte', count(tickets), refField('queue.json', 'cap')),
        all(tickets, bin('eq', lookup(reference, 'deskId', rf('deskId'), 'open'), bool(true))),
      ],
    ),
    referenceFiles: {...rowsFile('desks.json', desks), 'queue.json': jsonText({cap: '3'})},
    candidates: [
      candidate('valid', files(openPair)),
      candidate('valid-three', files([...openPair, {ticketId: 'ticket-3', deskId: 'desk-n'}])),
      candidate('duplicate-ticket', files([
        {ticketId: 'ticket-1', deskId: 'desk-n'},
        {ticketId: 'ticket-1', deskId: 'desk-n'},
      ]), 'fail', ['unique-ticket']),
      candidate('over-cap', files([
        ...openPair,
        {ticketId: 'ticket-3', deskId: 'desk-n'},
        {ticketId: 'ticket-4', deskId: 'desk-s'},
      ]), 'fail', ['queue-cap']),
      candidate('closed-desk', files([
        {ticketId: 'ticket-1', deskId: 'desk-n'},
        {ticketId: 'ticket-2', deskId: 'desk-z'},
      ]), 'fail', ['desk-open']),
      candidate('unknown-desk', files(mutate(openPair, (value) => {
        value[0].deskId = 'desk-missing';
      })), 'reject', ['reference-membership']),
      candidate('numeric-cap-field', files([{ticketId: 1, deskId: 'desk-n'}]), 'reject', ['input-types']),
    ],
  });
}

function purposeAllow() {
  const purposes = [
    {purpose: 'tour', allowed: true},
    {purpose: 'audit', allowed: true},
    {purpose: 'photo', allowed: false},
  ];
  const visits = access('deliverable', 'visits.json');
  const reference = access('reference', 'purposes.json');
  const files = (next) => rowsFile('visits.json', next);
  const rows = [{visitId: 'visit-1', purpose: 'tour'}, {visitId: 'visit-2', purpose: 'audit'}];
  return finish({
    id: 'purpose-1',
    family: 'badge-policy',
    spec: {kind: 'purpose-allow'},
    title: 'Check allowed visit purposes',
    prompt: 'Check visit purposes against purposes.json. Use each visitId once. Each purpose has allowed true. A purpose listed as allowed false is a policy failure. A missing purpose is not a weaker allowed purpose. Another pair of allowed purposes is acceptable.',
    requirements: [
      requirement('unique-visit', 'Use each visitId once.'),
      requirement('purpose-allowed', 'Use only purposes whose allowed flag is true.'),
    ],
    plan: planOf(
      [table('visits.json', {visitId: 'string', purpose: 'string'})],
      [table('purposes.json', {purpose: 'string', allowed: 'bool'})],
      [
        unique(visits, 'visitId'),
        all(visits, bin('eq', lookup(reference, 'purpose', rf('purpose'), 'allowed'), bool(true))),
      ],
    ),
    referenceFiles: rowsFile('purposes.json', purposes),
    candidates: [
      candidate('valid', files(rows)),
      candidate('valid-repeat-tour', files([
        {visitId: 'visit-1', purpose: 'tour'},
        {visitId: 'visit-3', purpose: 'tour'},
      ])),
      candidate('duplicate-visit', files([
        {visitId: 'visit-1', purpose: 'tour'},
        {visitId: 'visit-1', purpose: 'audit'},
      ]), 'fail', ['unique-visit']),
      candidate('denied-purpose', files(mutate(rows, (value) => {
        value[1].purpose = 'photo';
      })), 'fail', ['purpose-allowed']),
      candidate('unknown-purpose', files(mutate(rows, (value) => {
        value[0].purpose = 'film';
      })), 'reject', ['reference-membership']),
      candidate('numeric-visit', files([{visitId: 1, purpose: 'tour'}]), 'reject', ['input-types']),
    ],
  });
}

const nightDomain = (blocks) => all(blocks, bin('and', bin('gte', rf('night'), int(1)), bin('lte', rf('night'), int(2))));
const coverNights = (blocks) => [
  any(blocks, bin('eq', rf('night'), int(1))),
  any(blocks, bin('eq', rf('night'), int(2))),
];

function nightCover() {
  const programs = [{programId: 'alpha'}, {programId: 'beta'}, {programId: 'gamma'}];
  const blocks = access('deliverable', 'blocks.json');
  const reference = access('reference', 'programs.json');
  const files = (next) => rowsFile('blocks.json', next);
  const first = [
    {programId: 'alpha', night: '1'},
    {programId: 'beta', night: '2'},
    {programId: 'gamma', night: '1'},
  ];
  return finish({
    id: 'nights-1',
    family: 'telescope-scheduling',
    spec: {kind: 'night-cover'},
    title: 'Cover telescope nights 1 and 2',
    prompt: 'Schedule telescope programs onto nights. Nights are integer decimal strings. Use each programId once. Include every program in programs.json. Each night is 1 or 2. At least one block uses night 1 and at least one block uses night 2. Another feasible assignment is acceptable. Do not optimize the schedule.',
    requirements: [
      requirement('unique-program', 'Use each programId once.'),
      requirement('program-count', 'Include every program.'),
      requirement('night-domain', 'Use only night 1 or night 2.'),
      requirement('cover-night-1', 'Assign at least one block to night 1.'),
      requirement('cover-night-2', 'Assign at least one block to night 2.'),
    ],
    plan: planOf(
      [table('blocks.json', {programId: 'string', night: 'i64'})],
      [table('programs.json', {programId: 'string'})],
      [
        unique(blocks, 'programId'),
        bin('eq', count(blocks), count(reference)),
        all(blocks, bin('eq', rf('programId'), lookup(reference, 'programId', rf('programId'), 'programId'))),
        nightDomain(blocks),
        ...coverNights(blocks),
      ],
    ),
    referenceFiles: rowsFile('programs.json', programs),
    candidates: [
      candidate('valid', files(first)),
      candidate('valid-swapped', files([
        {programId: 'alpha', night: '2'},
        {programId: 'beta', night: '1'},
        {programId: 'gamma', night: '2'},
      ])),
      candidate('duplicate-program', files([
        {programId: 'alpha', night: '1'},
        {programId: 'alpha', night: '2'},
        {programId: 'beta', night: '1'},
      ]), 'fail', ['unique-program']),
      candidate('missing-program', files(first.slice(0, 2)), 'fail', ['program-count']),
      candidate('night-zero', files(mutate(first, (value) => {
        value[2].night = '0';
      })), 'fail', ['night-domain']),
      candidate('no-night-1', files(first.map((row) => ({...row, night: '2'}))), 'fail', ['cover-night-1']),
      candidate('no-night-2', files(first.map((row) => ({...row, night: '1'}))), 'fail', ['cover-night-2']),
      candidate('unknown-program', files(mutate(first, (value) => {
        value[0].programId = 'delta';
      })), 'reject', ['reference-membership']),
      candidate('numeric-night', files(mutate(first, (value) => {
        value[0].night = 1;
      })), 'reject', ['input-types']),
    ],
  });
}

function instrumentMatch() {
  const programs = [
    {programId: 'alpha', instrument: 'camera'},
    {programId: 'beta', instrument: 'spectrograph'},
  ];
  const blocks = access('deliverable', 'blocks.json');
  const reference = access('reference', 'programs.json');
  const files = (next) => rowsFile('blocks.json', next);
  const first = [
    {programId: 'alpha', night: '1', instrument: 'camera'},
    {programId: 'beta', night: '2', instrument: 'spectrograph'},
  ];
  return finish({
    id: 'instrument-1',
    family: 'telescope-scheduling',
    spec: {kind: 'instrument-match'},
    title: 'Match telescope instruments',
    prompt: 'Match each telescope block to its program instrument. Nights are integer decimal strings and are 1 or 2. Use each programId once. Include every program. Each instrument equals that program instrument. Swapping nights while keeping the instruments is acceptable.',
    requirements: [
      requirement('unique-program', 'Use each programId once.'),
      requirement('program-count', 'Include every program.'),
      requirement('night-domain', 'Use only night 1 or night 2.'),
      requirement('instrument', 'Match each instrument to the program.'),
    ],
    plan: planOf(
      [table('blocks.json', {programId: 'string', night: 'i64', instrument: 'string'})],
      [table('programs.json', {programId: 'string', instrument: 'string'})],
      [
        unique(blocks, 'programId'),
        bin('eq', count(blocks), count(reference)),
        nightDomain(blocks),
        all(blocks, bin('eq', rf('instrument'), lookup(reference, 'programId', rf('programId'), 'instrument'))),
      ],
    ),
    referenceFiles: rowsFile('programs.json', programs),
    candidates: [
      candidate('valid', files(first)),
      candidate('valid-swapped', files([
        {programId: 'alpha', night: '2', instrument: 'camera'},
        {programId: 'beta', night: '1', instrument: 'spectrograph'},
      ])),
      candidate('duplicate-program', files([
        {programId: 'alpha', night: '1', instrument: 'camera'},
        {programId: 'alpha', night: '2', instrument: 'camera'},
      ]), 'fail', ['unique-program']),
      candidate('missing-program', files(first.slice(0, 1)), 'fail', ['program-count']),
      candidate('night-zero', files(mutate(first, (value) => {
        value[0].night = '0';
      })), 'fail', ['night-domain']),
      candidate('wrong-instrument', files(mutate(first, (value) => {
        value[0].instrument = 'wide';
      })), 'fail', ['instrument']),
      candidate('unknown-program', files(mutate(first, (value) => {
        value[0].programId = 'delta';
      })), 'reject', ['reference-membership']),
      candidate('numeric-night', files(mutate(first, (value) => {
        value[0].night = 1;
      })), 'reject', ['input-types']),
    ],
  });
}

function usableNight() {
  const programs = [
    {programId: 'alpha', usable: true},
    {programId: 'beta', usable: true},
    {programId: 'gamma', usable: false},
    {programId: 'delta', usable: true},
  ];
  const blocks = access('deliverable', 'blocks.json');
  const reference = access('reference', 'programs.json');
  const files = (next) => rowsFile('blocks.json', next);
  const first = [{programId: 'alpha', night: '1'}, {programId: 'beta', night: '2'}];
  return finish({
    id: 'usable-1',
    family: 'telescope-scheduling',
    spec: {kind: 'usable-night'},
    title: 'Schedule only usable telescope programs',
    prompt: 'Schedule usable telescope programs. Nights are integer decimal strings and are 1 or 2. Use each programId once. Each program has usable true. At least one block uses night 1 and at least one uses night 2. A listed program with usable false is a policy failure. Another feasible pair is acceptable.',
    requirements: [
      requirement('unique-program', 'Use each programId once.'),
      requirement('night-domain', 'Use only night 1 or night 2.'),
      requirement('usable', 'Use only programs whose usable flag is true.'),
      requirement('cover-night-1', 'Assign at least one block to night 1.'),
      requirement('cover-night-2', 'Assign at least one block to night 2.'),
    ],
    plan: planOf(
      [table('blocks.json', {programId: 'string', night: 'i64'})],
      [table('programs.json', {programId: 'string', usable: 'bool'})],
      [
        unique(blocks, 'programId'),
        nightDomain(blocks),
        all(blocks, bin('eq', lookup(reference, 'programId', rf('programId'), 'usable'), bool(true))),
        ...coverNights(blocks),
      ],
    ),
    referenceFiles: rowsFile('programs.json', programs),
    candidates: [
      candidate('valid', files(first)),
      candidate('valid-swapped', files([{programId: 'alpha', night: '2'}, {programId: 'beta', night: '1'}])),
      candidate('duplicate-program', files([{programId: 'alpha', night: '1'}, {programId: 'alpha', night: '2'}]), 'fail', ['unique-program']),
      candidate('night-nine', files([...first, {programId: 'delta', night: '9'}]), 'fail', ['night-domain']),
      candidate('unusable-program', files([{programId: 'alpha', night: '1'}, {programId: 'gamma', night: '2'}]), 'fail', ['usable']),
      candidate('no-night-1', files([{programId: 'alpha', night: '2'}, {programId: 'beta', night: '2'}]), 'fail', ['cover-night-1']),
      candidate('no-night-2', files([{programId: 'alpha', night: '1'}, {programId: 'beta', night: '1'}]), 'fail', ['cover-night-2']),
      candidate('unknown-program', files(mutate(first, (value) => {
        value[0].programId = 'omega';
      })), 'reject', ['reference-membership']),
      candidate('numeric-night', files(mutate(first, (value) => {
        value[0].night = 1;
      })), 'reject', ['input-types']),
    ],
  });
}

function programBudget() {
  const programs = [
    {programId: 'alpha', costCents: '40'},
    {programId: 'beta', costCents: '70'},
    {programId: 'gamma', costCents: '200'},
    {programId: 'delta', costCents: '10'},
  ];
  const blocks = access('deliverable', 'blocks.json');
  const reference = access('reference', 'programs.json');
  const files = (next) => rowsFile('blocks.json', next);
  const first = [{programId: 'alpha', night: '1'}, {programId: 'beta', night: '2'}];
  return finish({
    id: 'programs-1',
    family: 'telescope-scheduling',
    spec: {kind: 'program-budget'},
    title: 'Stay inside the telescope program budget',
    prompt: 'Choose a feasible telescope program set. Nights are integer decimal strings and are 1 or 2. Use each programId once. Cover night 1 and night 2. The sum of program costCents is at most budget.json totalCents. A second feasible pair is acceptable. Do not search for the cheapest schedule.',
    requirements: [
      requirement('unique-program', 'Use each programId once.'),
      requirement('night-domain', 'Use only night 1 or night 2.'),
      requirement('cover-night-1', 'Assign at least one block to night 1.'),
      requirement('cover-night-2', 'Assign at least one block to night 2.'),
      requirement('program-cost', 'Keep the sum of program costCents at or below totalCents.'),
    ],
    plan: planOf(
      [table('blocks.json', {programId: 'string', night: 'i64'})],
      [table('programs.json', {programId: 'string', costCents: 'i64'}), scalar('budget.json', {totalCents: 'i64'})],
      [
        unique(blocks, 'programId'),
        nightDomain(blocks),
        ...coverNights(blocks),
        bin('lte', sum(blocks, lookup(reference, 'programId', rf('programId'), 'costCents')), refField('budget.json', 'totalCents')),
      ],
    ),
    referenceFiles: {...rowsFile('programs.json', programs), 'budget.json': jsonText({totalCents: '120'})},
    candidates: [
      candidate('valid', files(first)),
      candidate('valid-swapped', files([{programId: 'alpha', night: '2'}, {programId: 'beta', night: '1'}])),
      candidate('duplicate-program', files([{programId: 'alpha', night: '1'}, {programId: 'alpha', night: '2'}]), 'fail', ['unique-program']),
      candidate('night-zero', files([...first, {programId: 'delta', night: '0'}]), 'fail', ['night-domain']),
      candidate('no-night-1', files([{programId: 'alpha', night: '2'}, {programId: 'beta', night: '2'}]), 'fail', ['cover-night-1']),
      candidate('no-night-2', files([{programId: 'alpha', night: '1'}, {programId: 'beta', night: '1'}]), 'fail', ['cover-night-2']),
      candidate('over-budget', files([{programId: 'alpha', night: '1'}, {programId: 'gamma', night: '2'}]), 'fail', ['program-cost']),
      candidate('unknown-program', files(mutate(first, (value) => {
        value[0].programId = 'omega';
      })), 'reject', ['reference-membership']),
      candidate('numeric-night', files(mutate(first, (value) => {
        value[0].night = 1;
      })), 'reject', ['input-types']),
    ],
  });
}

function allocationTask({id, kind, title, prompt, requirements, rules, referenceFiles, candidates}) {
  return finish({
    id,
    family: 'berth-allocation',
    spec: {kind},
    title,
    prompt,
    requirements,
    plan: planOf(
      [table('allocations.json', {vesselId: 'string', berthId: 'string'})],
      [table('vessels.json', {vesselId: 'string', length: 'i64'}), table('berths.json', {berthId: 'string', ...referenceFiles.berthFields})],
      rules,
    ),
    referenceFiles: referenceFiles.files,
    candidates,
  });
}

function berthBase(extraBerthFields, extraRules, extraRequirements, extras) {
  const vessels = [{vesselId: 'skiff', length: '10'}, {vesselId: 'yawl', length: '20'}];
  const allocations = access('deliverable', 'allocations.json');
  const vesselRef = access('reference', 'vessels.json');
  const berthRef = access('reference', 'berths.json');
  const shared = [
    unique(allocations, 'vesselId'),
    unique(allocations, 'berthId'),
    bin('eq', count(allocations), count(vesselRef)),
  ];
  const files = (next) => rowsFile('allocations.json', next);
  const first = [{vesselId: 'skiff', berthId: 'south'}, {vesselId: 'yawl', berthId: 'north'}];
  const swapped = [{vesselId: 'skiff', berthId: 'north'}, {vesselId: 'yawl', berthId: 'south'}];
  return {
    vessels, allocations, vesselRef, berthRef, shared, files, first, swapped,
    commonCandidates(fitOk = first) {
      return [
        candidate('duplicate-vessel', files([
          {vesselId: 'skiff', berthId: 'north'},
          {vesselId: 'skiff', berthId: 'south'},
        ]), 'fail', ['unique-vessel']),
        candidate('duplicate-berth', files([
          {vesselId: 'skiff', berthId: 'north'},
          {vesselId: 'yawl', berthId: 'north'},
        ]), 'fail', ['unique-berth']),
        candidate('missing-vessel', files(fitOk.slice(0, 1)), 'fail', ['vessel-count']),
        candidate('unknown-berth', files(mutate(fitOk, (value) => {
          value[0].berthId = 'west';
        })), 'reject', ['reference-membership']),
        candidate('numeric-vessel', files([{vesselId: 1, berthId: 'north'}]), 'reject', ['input-types']),
      ];
    },
    extraBerthFields, extraRules, extraRequirements,
  };
}

function berthFit() {
  const base = berthBase();
  const berths = [
    {berthId: 'north', length: '30'},
    {berthId: 'south', length: '25'},
    {berthId: 'tight', length: '12'},
  ];
  const {allocations, vesselRef, berthRef, shared, files, first, swapped} = base;
  return finish({
    id: 'berth-fit-1',
    family: 'berth-allocation',
    spec: {kind: 'berth-fit'},
    title: 'Fit vessels into berths',
    prompt: 'Assign each vessel to a distinct berth. Use each vesselId once and each berthId once. Include every vessel. Each vessel length is at most that berth length. Another fitting assignment is acceptable.',
    requirements: [
      requirement('unique-vessel', 'Use each vesselId once.'),
      requirement('unique-berth', 'Use each berthId once.'),
      requirement('vessel-count', 'Include every vessel.'),
      requirement('fit', 'Keep each vessel length at or below the berth length.'),
    ],
    plan: planOf(
      [table('allocations.json', {vesselId: 'string', berthId: 'string'})],
      [table('vessels.json', {vesselId: 'string', length: 'i64'}), table('berths.json', {berthId: 'string', length: 'i64'})],
      [...shared, all(allocations, bin('lte', lookup(vesselRef, 'vesselId', rf('vesselId'), 'length'), lookup(berthRef, 'berthId', rf('berthId'), 'length')))],
    ),
    referenceFiles: {...rowsFile('vessels.json', base.vessels), ...rowsFile('berths.json', berths)},
    candidates: [
      candidate('valid', files(first)),
      candidate('valid-swapped', files(swapped)),
      ...base.commonCandidates(first),
      candidate('too-long', files([{vesselId: 'skiff', berthId: 'north'}, {vesselId: 'yawl', berthId: 'tight'}]), 'fail', ['fit']),
    ],
  });
}

function berthFee() {
  const base = berthBase();
  const berths = [
    {berthId: 'north', fee: '4'},
    {berthId: 'south', fee: '6'},
    {berthId: 'east', fee: '9'},
  ];
  const {allocations, vesselRef, berthRef, shared, files, first, swapped} = base;
  return finish({
    id: 'berth-fee-1',
    family: 'berth-allocation',
    spec: {kind: 'berth-fee'},
    title: 'Stay inside the berth fee cap',
    prompt: 'Assign each vessel to a distinct berth. Use each vesselId once and each berthId once. Include every vessel. The sum of berth fee values is at most budget.json capCents. Another assignment inside the cap is acceptable.',
    requirements: [
      requirement('unique-vessel', 'Use each vesselId once.'),
      requirement('unique-berth', 'Use each berthId once.'),
      requirement('vessel-count', 'Include every vessel.'),
      requirement('fee-cap', 'Keep the sum of berth fees at or below capCents.'),
    ],
    plan: planOf(
      [table('allocations.json', {vesselId: 'string', berthId: 'string'})],
      [table('vessels.json', {vesselId: 'string', length: 'i64'}), table('berths.json', {berthId: 'string', fee: 'i64'}), scalar('budget.json', {capCents: 'i64'})],
      [...shared, bin('lte', sum(allocations, lookup(berthRef, 'berthId', rf('berthId'), 'fee')), refField('budget.json', 'capCents'))],
    ),
    referenceFiles: {
      ...rowsFile('vessels.json', base.vessels),
      ...rowsFile('berths.json', berths),
      'budget.json': jsonText({capCents: '12'}),
    },
    candidates: [
      candidate('valid', files(first)),
      candidate('valid-swapped', files(swapped)),
      ...base.commonCandidates(first),
      candidate('over-fee', files([{vesselId: 'skiff', berthId: 'east'}, {vesselId: 'yawl', berthId: 'south'}]), 'fail', ['fee-cap']),
    ],
  });
}

function berthOpen() {
  const base = berthBase();
  const berths = [
    {berthId: 'north', open: true},
    {berthId: 'south', open: false},
    {berthId: 'east', open: true},
  ];
  const openFirst = [{vesselId: 'skiff', berthId: 'north'}, {vesselId: 'yawl', berthId: 'east'}];
  const openSwap = [{vesselId: 'skiff', berthId: 'east'}, {vesselId: 'yawl', berthId: 'north'}];
  const {allocations, vesselRef, berthRef, shared, files} = base;
  return finish({
    id: 'berth-open-1',
    family: 'berth-allocation',
    spec: {kind: 'berth-open'},
    title: 'Use only open berths',
    prompt: 'Assign each vessel to a distinct open berth. Use each vesselId once and each berthId once. Include every vessel. Each berth open flag is true. A closed berth is a policy failure, not a missing berth. Another open assignment is acceptable.',
    requirements: [
      requirement('unique-vessel', 'Use each vesselId once.'),
      requirement('unique-berth', 'Use each berthId once.'),
      requirement('vessel-count', 'Include every vessel.'),
      requirement('berth-open', 'Use only berths whose open flag is true.'),
    ],
    plan: planOf(
      [table('allocations.json', {vesselId: 'string', berthId: 'string'})],
      [table('vessels.json', {vesselId: 'string', length: 'i64'}), table('berths.json', {berthId: 'string', open: 'bool'})],
      [...shared, all(allocations, bin('eq', lookup(berthRef, 'berthId', rf('berthId'), 'open'), bool(true)))],
    ),
    referenceFiles: {...rowsFile('vessels.json', base.vessels), ...rowsFile('berths.json', berths)},
    candidates: [
      candidate('valid', files(openFirst)),
      candidate('valid-swapped', files(openSwap)),
      candidate('duplicate-vessel', files([
        {vesselId: 'skiff', berthId: 'north'},
        {vesselId: 'skiff', berthId: 'east'},
      ]), 'fail', ['unique-vessel']),
      candidate('duplicate-berth', files([
        {vesselId: 'skiff', berthId: 'north'},
        {vesselId: 'yawl', berthId: 'north'},
      ]), 'fail', ['unique-berth']),
      candidate('missing-vessel', files(openFirst.slice(0, 1)), 'fail', ['vessel-count']),
      candidate('closed-berth', files([{vesselId: 'skiff', berthId: 'north'}, {vesselId: 'yawl', berthId: 'south'}]), 'fail', ['berth-open']),
      candidate('unknown-berth', files(mutate(openFirst, (value) => {
        value[0].berthId = 'west';
      })), 'reject', ['reference-membership']),
      candidate('numeric-vessel', files([{vesselId: 1, berthId: 'north'}]), 'reject', ['input-types']),
    ],
  });
}

function berthChoice() {
  const base = berthBase();
  const berths = [
    {berthId: 'north', length: '30', fee: '4'},
    {berthId: 'south', length: '22', fee: '6'},
    {berthId: 'east', length: '40', fee: '9'},
    {berthId: 'tight', length: '12', fee: '1'},
  ];
  const {allocations, vesselRef, berthRef, shared, files, first, swapped} = base;
  return finish({
    id: 'berth-swap-1',
    family: 'berth-allocation',
    spec: {kind: 'berth-choice'},
    title: 'Choose berths by length and fee',
    prompt: 'Assign each vessel to a distinct berth. Use each vesselId once and each berthId once. Include every vessel. Each vessel length is at most that berth length. The sum of berth fee values is at most budget.json capCents. Another assignment that meets both limits is acceptable.',
    requirements: [
      requirement('unique-vessel', 'Use each vesselId once.'),
      requirement('unique-berth', 'Use each berthId once.'),
      requirement('vessel-count', 'Include every vessel.'),
      requirement('fit', 'Keep each vessel length at or below the berth length.'),
      requirement('fee-cap', 'Keep the sum of berth fees at or below capCents.'),
    ],
    plan: planOf(
      [table('allocations.json', {vesselId: 'string', berthId: 'string'})],
      [
        table('vessels.json', {vesselId: 'string', length: 'i64'}),
        table('berths.json', {berthId: 'string', length: 'i64', fee: 'i64'}),
        scalar('budget.json', {capCents: 'i64'}),
      ],
      [
        ...shared,
        all(allocations, bin('lte', lookup(vesselRef, 'vesselId', rf('vesselId'), 'length'), lookup(berthRef, 'berthId', rf('berthId'), 'length'))),
        bin('lte', sum(allocations, lookup(berthRef, 'berthId', rf('berthId'), 'fee')), refField('budget.json', 'capCents')),
      ],
    ),
    referenceFiles: {
      ...rowsFile('vessels.json', base.vessels),
      ...rowsFile('berths.json', berths),
      'budget.json': jsonText({capCents: '12'}),
    },
    candidates: [
      candidate('valid', files(first)),
      candidate('valid-swapped', files(swapped)),
      ...base.commonCandidates(first),
      candidate('too-long', files([{vesselId: 'skiff', berthId: 'north'}, {vesselId: 'yawl', berthId: 'tight'}]), 'fail', ['fit']),
      candidate('over-fee', files([{vesselId: 'skiff', berthId: 'east'}, {vesselId: 'yawl', berthId: 'south'}]), 'fail', ['fee-cap']),
    ],
  });
}

export function policyChallenges() {
  return [
    badgeZone(), clearanceLevel(), queueCap(), purposeAllow(),
    nightCover(), instrumentMatch(), usableNight(), programBudget(),
    berthFit(), berthFee(), berthOpen(), berthChoice(),
  ];
}
