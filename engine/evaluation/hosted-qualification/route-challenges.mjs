import {
  access, all, bin, bool, candidate, count, finish, int, jsonText, lookup, planOf, requirement, rf,
  rowsFile, scalar, sum, table, unique,
} from './shape.mjs';

const limitField = (field) => ({op: 'field', source: 'reference', file: 'limits.json', field});
const limitSchema = (limits) => Object.fromEntries(Object.keys(limits).map((key) => [
  key, key === 'origin' || key === 'destination' ? 'string' : 'i64',
]));
const hopFile = (rows) => rowsFile('hops.json', rows);
const hop = (edgeId, seq) => ({edgeId, seq: String(seq)});
const edge = (edgeId, fromStop, toStop, meters, extra = {}) => ({
  edgeId, fromStop, toStop, meters: String(meters), ...extra,
});

function limitsText(fields) {
  return jsonText(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])));
}

function routeTask({
  id, kind, title, prompt, edges, edgeSchema, limits, extraRules, extraRequirements, candidates,
}) {
  const hops = access('deliverable', 'hops.json');
  const edgesRef = access('reference', 'edges.json');
  const stop = (field, level = 0) => lookup(edgesRef, 'edgeId', rf('edgeId', level), field);
  return finish({
    id,
    family: 'route-feasibility',
    spec: {kind},
    title,
    prompt,
    requirements: [
      requirement('unique-seq', 'Use each seq value once.'),
      requirement('seq-domain', 'Use each integer from 1 through the hop count once.'),
      requirement('origin', 'Start the first hop at the origin.'),
      requirement('destination', 'End the last hop at the destination.'),
      requirement('continuity', 'Meet consecutive hops at the same stop.'),
      requirement('hop-bounds', 'Keep the hop count inside the stated bounds.'),
      ...extraRequirements,
    ],
    plan: planOf(
      [table('hops.json', {edgeId: 'string', seq: 'i64'})],
      [table('edges.json', edgeSchema), scalar('limits.json', limitSchema(limits))],
      [
        unique(hops, 'seq'),
        all(hops, bin('and', bin('gte', rf('seq'), int(1)), bin('lte', rf('seq'), count(hops)))),
        all(hops, bin('or', bin('ne', rf('seq'), int(1)), bin('eq', stop('fromStop'), limitField('origin')))),
        all(hops, bin('or', bin('ne', rf('seq'), count(hops)), bin('eq', stop('toStop'), limitField('destination')))),
        all(hops, all(hops, bin('or',
          bin('ne', rf('seq'), bin('add', rf('seq', 1), int(1))),
          bin('eq', stop('fromStop'), stop('toStop', 1)),
        ))),
        bin('and', bin('gte', count(hops), limitField('minHops')), bin('lte', count(hops), limitField('maxHops'))),
        ...extraRules(hops, stop),
      ],
    ),
    referenceFiles: {...rowsFile('edges.json', edges), 'limits.json': limitsText(limits)},
    candidates,
  });
}

const sharedTail = [
  candidate('unknown-edge', hopFile([hop('missing', 1)]), 'reject', ['reference-membership']),
  candidate('numeric-seq', hopFile([{edgeId: 'direct', seq: 1}]), 'reject', ['input-types']),
];

function campusRoute() {
  const edges = [
    edge('direct', 'dock', 'gate', 800),
    edge('a', 'dock', 'quad', 400),
    edge('b', 'quad', 'gate', 500),
    edge('c', 'dock', 'lab', 300),
    edge('d', 'lab', 'gate', 450),
    edge('long', 'quad', 'gate', 5000),
    edge('t1', 'dock', 'gate', 10),
    edge('t2', 'dock', 'gate', 10),
    edge('h1', 'dock', 'n1', 10),
    edge('h2', 'n1', 'n2', 10),
    edge('h3', 'n2', 'n3', 10),
    edge('h4', 'n3', 'gate', 10),
  ];
  return routeTask({
    id: 'route-1',
    kind: 'route-campus',
    title: 'Campus shuttle route',
    prompt: 'Choose a feasible campus shuttle route from dock to gate. Each hop cites one edges.json edgeId. seq is an integer decimal string. Use each seq once and use every integer from 1 through the hop count. The seq 1 hop starts at limits.json origin. The hop whose seq equals the hop count ends at limits.json destination. Consecutive seq values meet at the same stop. The hop count is from minHops through maxHops. The sum of edge meters is at most maxMeters. Another feasible route is acceptable. Do not search for a shortest route.',
    edges,
    edgeSchema: {edgeId: 'string', fromStop: 'string', toStop: 'string', meters: 'i64'},
    limits: {origin: 'dock', destination: 'gate', minHops: 1, maxHops: 3, maxMeters: 900},
    extraRequirements: [requirement('distance', 'Keep the sum of edge meters at or below maxMeters.')],
    extraRules: (hops, stop) => [bin('lte', sum(hops, stop('meters')), limitField('maxMeters'))],
    candidates: [
      candidate('valid-direct', hopFile([hop('direct', 1)])),
      candidate('valid-quad', hopFile([hop('a', 1), hop('b', 2)])),
      candidate('over-distance', hopFile([hop('a', 1), hop('long', 2)]), 'fail', ['distance']),
      candidate('broken-join', hopFile([hop('a', 1), hop('d', 2)]), 'fail', ['continuity']),
      candidate('wrong-origin', hopFile([hop('b', 1)]), 'fail', ['origin']),
      candidate('wrong-destination', hopFile([hop('a', 1)]), 'fail', ['destination']),
      candidate('too-many-hops', hopFile([hop('h1', 1), hop('h2', 2), hop('h3', 3), hop('h4', 4)]), 'fail', ['hop-bounds']),
      candidate('duplicate-seq', hopFile([hop('t1', 1), hop('t2', 1)]), 'fail', ['unique-seq']),
      candidate('seq-zero', hopFile([hop('h1', 0), hop('h4', 2)]), 'fail', ['seq-domain']),
      ...sharedTail,
    ],
  });
}

function harborRoute() {
  const edges = [
    edge('direct', 'mole', 'quay', 100, {open: true}),
    edge('a', 'mole', 'buoy', 40, {open: true}),
    edge('b', 'buoy', 'quay', 50, {open: true}),
    edge('shut', 'mole', 'quay', 20, {open: false}),
    edge('c', 'mole', 'reef', 30, {open: true}),
    edge('d', 'reef', 'quay', 40, {open: true}),
    edge('long', 'buoy', 'quay', 5000, {open: true}),
    edge('t1', 'mole', 'quay', 10, {open: true}),
    edge('t2', 'mole', 'quay', 10, {open: true}),
    edge('h1', 'mole', 'spar', 10, {open: true}),
    edge('h2', 'spar', 'mark', 10, {open: true}),
    edge('h3', 'mark', 'quay', 10, {open: true}),
  ];
  return routeTask({
    id: 'route-open-1',
    kind: 'route-harbor',
    title: 'Harbor road open edges',
    prompt: 'Choose a feasible harbor road route from mole to quay. Each hop cites one edges.json edgeId. seq is an integer decimal string. Use each seq once and use every integer from 1 through the hop count. The seq 1 hop starts at limits.json origin. The hop whose seq equals the hop count ends at limits.json destination. Consecutive seq values meet at the same stop. The hop count is from minHops through maxHops. The sum of edge meters is at most maxMeters. Use only edges whose open field is true. Another feasible route is acceptable. Do not search for a shortest route.',
    edges,
    edgeSchema: {edgeId: 'string', fromStop: 'string', toStop: 'string', meters: 'i64', open: 'bool'},
    limits: {origin: 'mole', destination: 'quay', minHops: 1, maxHops: 2, maxMeters: 200},
    extraRequirements: [
      requirement('distance', 'Keep the sum of edge meters at or below maxMeters.'),
      requirement('edge-open', 'Use only open edges.'),
    ],
    extraRules: (hops, stop) => [
      bin('lte', sum(hops, stop('meters')), limitField('maxMeters')),
      all(hops, bin('eq', stop('open'), bool(true))),
    ],
    candidates: [
      candidate('valid-direct', hopFile([hop('direct', 1)])),
      candidate('valid-buoy', hopFile([hop('a', 1), hop('b', 2)])),
      candidate('over-distance', hopFile([hop('a', 1), hop('long', 2)]), 'fail', ['distance']),
      candidate('broken-join', hopFile([hop('a', 1), hop('d', 2)]), 'fail', ['continuity']),
      candidate('wrong-origin', hopFile([hop('b', 1)]), 'fail', ['origin']),
      candidate('wrong-destination', hopFile([hop('a', 1)]), 'fail', ['destination']),
      candidate('too-many-hops', hopFile([hop('h1', 1), hop('h2', 2), hop('h3', 3)]), 'fail', ['hop-bounds']),
      candidate('duplicate-seq', hopFile([hop('t1', 1), hop('t2', 1)]), 'fail', ['unique-seq']),
      candidate('seq-zero', hopFile([hop('h1', 0), hop('h3', 2)]), 'fail', ['seq-domain']),
      candidate('closed-edge', hopFile([hop('shut', 1)]), 'fail', ['edge-open']),
      ...sharedTail,
    ],
  });
}

function clinicRoute() {
  const edges = [
    edge('direct', 'lobby', 'exit', 100),
    edge('a', 'lobby', 'ward', 40),
    edge('b', 'ward', 'exit', 50),
    edge('p', 'lobby', 'hall', 30),
    edge('q', 'hall', 'exit', 45),
    edge('d', 'desk', 'exit', 40),
    edge('long', 'ward', 'exit', 5000),
    edge('r', 'ward', 'hall', 20),
    edge('s', 'ward', 'desk', 25),
    edge('t1', 'lobby', 'exit', 10),
    edge('t2', 'lobby', 'exit', 10),
  ];
  return routeTask({
    id: 'route-fixed-1',
    kind: 'route-clinic',
    title: 'Clinic corridor fixed hop count',
    prompt: 'Choose a feasible clinic corridor route from lobby to exit. Each hop cites one edges.json edgeId. seq is an integer decimal string. Use each seq once and use every integer from 1 through the hop count. The seq 1 hop starts at limits.json origin. The hop whose seq equals the hop count ends at limits.json destination. Consecutive seq values meet at the same stop. The hop count is from minHops through maxHops. The sum of edge meters is at most maxMeters. Another feasible route is acceptable. Do not search for a shortest route.',
    edges,
    edgeSchema: {edgeId: 'string', fromStop: 'string', toStop: 'string', meters: 'i64'},
    limits: {origin: 'lobby', destination: 'exit', minHops: 2, maxHops: 2, maxMeters: 300},
    extraRequirements: [requirement('distance', 'Keep the sum of edge meters at or below maxMeters.')],
    extraRules: (hops, stop) => [bin('lte', sum(hops, stop('meters')), limitField('maxMeters'))],
    candidates: [
      candidate('valid-ward', hopFile([hop('a', 1), hop('b', 2)])),
      candidate('valid-hall', hopFile([hop('p', 1), hop('q', 2)])),
      candidate('over-distance', hopFile([hop('a', 1), hop('long', 2)]), 'fail', ['distance']),
      candidate('broken-join', hopFile([hop('a', 1), hop('d', 2)]), 'fail', ['continuity']),
      candidate('wrong-origin', hopFile([hop('r', 1), hop('q', 2)]), 'fail', ['origin']),
      candidate('wrong-destination', hopFile([hop('a', 1), hop('s', 2)]), 'fail', ['destination']),
      candidate('one-hop', hopFile([hop('direct', 1)]), 'fail', ['hop-bounds']),
      candidate('duplicate-seq', hopFile([hop('t1', 1), hop('t2', 1)]), 'fail', ['unique-seq']),
      candidate('seq-zero', hopFile([hop('a', 0), hop('q', 2)]), 'fail', ['seq-domain']),
      ...sharedTail,
    ],
  });
}

function warehouseRoute() {
  const edges = [
    edge('direct', 'pad', 'door', 400),
    edge('a', 'pad', 'bay', 200),
    edge('b', 'bay', 'door', 300),
    edge('c', 'pad', 'rack', 250),
    edge('d', 'rack', 'door', 400),
    edge('t1', 'pad', 'door', 10),
    edge('t2', 'pad', 'door', 10),
    edge('h1', 'pad', 'aisle', 10),
    edge('h2', 'aisle', 'crate', 10),
    edge('h3', 'crate', 'bin', 10),
    edge('h4', 'bin', 'door', 10),
  ];
  return routeTask({
    id: 'route-penalty-1',
    kind: 'route-warehouse',
    title: 'Warehouse aisle route score',
    prompt: 'Choose a feasible warehouse aisle route from pad to door. Each hop cites one edges.json edgeId. seq is an integer decimal string. Use each seq once and use every integer from 1 through the hop count. The seq 1 hop starts at limits.json origin. The hop whose seq equals the hop count ends at limits.json destination. Consecutive seq values meet at the same stop. The hop count is from minHops through maxHops. The route score is the sum of edge meters plus penalty times the hop count. Keep that score at or below cap. Another feasible route is acceptable. Do not search for a shortest route.',
    edges,
    edgeSchema: {edgeId: 'string', fromStop: 'string', toStop: 'string', meters: 'i64'},
    limits: {origin: 'pad', destination: 'door', minHops: 1, maxHops: 3, penalty: 50, cap: 700},
    extraRequirements: [requirement('route-score', 'Keep meters plus penalty times the hop count at or below cap.')],
    extraRules: (hops, stop) => [bin('lte',
      bin('add', sum(hops, stop('meters')), bin('mul', limitField('penalty'), count(hops))),
      limitField('cap'),
    )],
    candidates: [
      candidate('valid-direct', hopFile([hop('direct', 1)])),
      candidate('valid-bay', hopFile([hop('a', 1), hop('b', 2)])),
      candidate('over-score', hopFile([hop('c', 1), hop('d', 2)]), 'fail', ['route-score']),
      candidate('broken-join', hopFile([hop('a', 1), hop('d', 2)]), 'fail', ['continuity']),
      candidate('wrong-origin', hopFile([hop('b', 1)]), 'fail', ['origin']),
      candidate('wrong-destination', hopFile([hop('a', 1)]), 'fail', ['destination']),
      candidate('too-many-hops', hopFile([hop('h1', 1), hop('h2', 2), hop('h3', 3), hop('h4', 4)]), 'fail', ['hop-bounds']),
      candidate('duplicate-seq', hopFile([hop('t1', 1), hop('t2', 1)]), 'fail', ['unique-seq']),
      candidate('seq-zero', hopFile([hop('h1', 0), hop('h4', 2)]), 'fail', ['seq-domain']),
      ...sharedTail,
    ],
  });
}

export function routeChallenges() {
  return [campusRoute(), harborRoute(), clinicRoute(), warehouseRoute()];
}
