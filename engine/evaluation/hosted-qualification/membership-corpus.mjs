import {canonicalCorpus} from './corpus.mjs';
import {buildContractCorpus} from './contract-corpus.mjs';

export const MEMBERSHIP_CORPUS_ID = 'hosted-qualification-2026-11-18-reference-membership';
export const MEMBERSHIP_CORPUS_DIGEST = '51ef40d98452aa06b75473886b5cb474b9a8b066c5fcb60a36496d7b1942843f';

// Public input contracts. These specify schema and error semantics without publishing candidate values.
const groups = [
  [['pier-drawers', 'pier-variance'], 'drawers.json', [['drawerId', 'floats.json']]],
  [['lot-range-1'], 'vials.json', [['lotId', 'lots.json']]],
  [['lot-expiry-1'], 'expiry.json', [['lotId', 'lots.json']]],
  [['sensor-1'], 'readings.json', [['sensorId', 'sensors.json']]],
  [['category-clear-1'], 'lines.json', [['category', 'categories.json']]],
  [['badge-zone-1'], 'scans.json', [['badgeId', 'badges.json']]],
  [['clearance-1'], 'grants.json', [['postId', 'posts.json']]],
  [['queue-1'], 'tickets.json', [['deskId', 'desks.json']]],
  [['purpose-1'], 'visits.json', [['purpose', 'purposes.json']]],
  [['nights-1', 'instrument-1', 'usable-1', 'programs-1'], 'blocks.json', [['programId', 'programs.json']]],
  [['berth-fit-1', 'berth-fee-1', 'berth-open-1', 'berth-swap-1'], 'allocations.json',
    [['vesselId', 'vessels.json'], ['berthId', 'berths.json']]],
  [['route-1', 'route-open-1', 'route-fixed-1', 'route-penalty-1'], 'hops.json', [['edgeId', 'edges.json']]],
  [['yield-1'], 'yields.json', [['batchId', 'batches.json']]],
  [['dilution-1'], 'takes.json', [['sampleId', 'samples.json']]],
  [['lab-supplies-receipt-1', 'clinic-supplies-receipt-1'], 'receipt.json', [['itemId', 'purchase-order.json']]],
];

const contracts = new Map(groups.flatMap(([ids, output, fields]) => ids.map(id => [id, {output, fields}])));

export function buildMembershipCorpus() {
  return buildContractCorpus().map(challenge => {
    const contract = contracts.get(challenge.id);
    if (!contract) return challenge;
    const {output, fields} = contract;
    const prefix = fields.map(([key, reference]) =>
      `Reject the input if a row in ${output} uses a ${key} missing from ${reference}.`).join(' ');
    const requirement = `${prefix} An unknown key is an input error and has no rule verdict.`;
    const boundary = '\n\nOutput file contract: ';
    const at = challenge.prompt.indexOf(boundary);
    if (at < 0) throw new Error(`Missing public output contract for ${challenge.id}`);
    return {
      ...challenge,
      id: `${challenge.id}-membership`,
      prompt: `${challenge.prompt.slice(0, at)} ${requirement}${challenge.prompt.slice(at)}`,
    };
  });
}

export function canonicalMembershipCorpus(challenges = buildMembershipCorpus()) {
  return canonicalCorpus(challenges);
}
