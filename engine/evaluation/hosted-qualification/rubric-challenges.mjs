import {bin, int, syntheticSigner} from './shape.mjs';

const boundary = 'The current catalog does not expose this named primitive. This label does not claim the domain task is impossible through a separately approved formulation.';

function ambiguous(id, family, title, prompt, questions, facets) {
  return {
    id, family, title, prompt,
    classification: 'ambiguous',
    requirements: [],
    clarificationQuestions: questions,
    facets,
    candidates: [],
  };
}

function operationDraft(name) {
  return {
    version: 1,
    deliverables: [{name: 'input.bin', parser: 'opaque/v1'}],
    references: [],
    rules: [{op: name}],
  };
}

function parserDraft(parser) {
  return {
    version: 1,
    deliverables: [{name: 'sheet.bin', parser}],
    references: [],
    rules: [bin('eq', int(1), int(1))],
  };
}

function evidenceDraft(profile) {
  return {
    version: 1,
    deliverables: [{name: 'input.bin', parser: 'opaque/v1'}],
    references: [],
    evidence: [{
      name: 'custody.json',
      parser: 'json/v1',
      profile,
      signer: syntheticSigner,
    }],
    rules: [bin('eq', int(1), int(1))],
  };
}

function unsupported(id, family, title, prompt, kind, name) {
  const unsupportedDraft = kind === 'parser'
    ? parserDraft(name)
    : kind === 'evidence'
      ? evidenceDraft(name)
      : operationDraft(name);
  return {
    id, family, title, prompt,
    classification: 'unsupported',
    requirements: [],
    capabilityRequests: [{kind, name}],
    unsupportedDraft,
    boundary,
    candidates: [],
  };
}

export function rubricChallenges() {
  return [
    ambiguous(
      'hq-ambiguous-1',
      'harbor-fees',
      'Harbor fee table',
      'Charge this harbor call a fair fee and accept the manifest.',
      ['Which harbor fee table applies to this call?', 'Which currency unit applies to the fee?'],
      ['fee table', 'currency unit'],
    ),
    ambiguous(
      'hq-ambiguous-2',
      'pharmacy-substitution',
      'Pharmacy substitution',
      'Substitute an equivalent pharmacy lot when the requested lot is short.',
      ['Which substitution list defines an equivalent lot?', 'Who must approve a substitution?'],
      ['substitution list', 'approve'],
    ),
    ambiguous(
      'hq-ambiguous-3',
      'studio-overtime',
      'Studio overtime',
      'Accept the studio invoice if overtime looks reasonable.',
      ['Which overtime multiplier applies?', 'Which hour threshold starts overtime?'],
      ['overtime multiplier', 'hour threshold'],
    ),
    ambiguous(
      'hq-ambiguous-4',
      'badge-escort',
      'Badge guest escort',
      'Admit the guest when an escort is appropriate.',
      ['Which zones require a guest escort?', 'Which badge roles may escort a guest?'],
      ['zones', 'badge roles'],
    ),
    ambiguous(
      'hq-ambiguous-5',
      'telescope-weather',
      'Telescope weather cancel',
      'Cancel the telescope block when the weather is unsuitable.',
      ['Which weather measurement cancels a block?', 'Which numeric threshold makes weather unsuitable?'],
      ['weather measurement', 'numeric threshold'],
    ),
    ambiguous(
      'hq-ambiguous-6',
      'berth-priority',
      'Berth priority',
      'Assign the better berth to the higher priority vessel.',
      ['Which priority order ranks the vessels?', 'Which berth attribute defines the better berth?'],
      ['priority order', 'berth attribute'],
    ),
    ambiguous(
      'hq-ambiguous-7',
      'route-toll',
      'Route toll',
      'Accept a route when its toll is reasonable.',
      ['Which toll table applies to each edge?', 'Which currency unit applies to the toll?'],
      ['toll table', 'currency unit'],
    ),
    ambiguous(
      'hq-ambiguous-8',
      'dilution-rounding',
      'Dilution rounding',
      'Round the dilution take to a practical quantity.',
      ['Which rounding mode applies to a take?', 'Which integer unit is the rounding step?'],
      ['rounding mode', 'rounding step'],
    ),
    ambiguous(
      'hq-ambiguous-9',
      'custody-after-hours',
      'After-hours release',
      'Release the sealed item after hours when the duty officer agrees.',
      ['Which clock and time zone define after hours?', 'Which duty roles may approve an after-hours release?'],
      ['time zone', 'duty roles'],
    ),
    ambiguous(
      'hq-ambiguous-10',
      'firmware-channel',
      'Firmware channel choice',
      'Ship the firmware build on the preferred channel.',
      ['Which channel names are allowed?', 'Does the preferred channel mean stable or beta?'],
      ['channel names', 'stable or beta'],
    ),
    unsupported(
      'hq-unsupported-1',
      'firmware-file',
      'Firmware line pattern',
      'Accept notice lines that match the regular expression ^build-[0-9]+$ inside the checker.',
      'operation',
      'regex_match',
    ),
    unsupported(
      'hq-unsupported-2',
      'studio-budgets',
      'Studio ratio',
      'Compute a decimal reimbursement ratio with division inside the checker.',
      'operation',
      'div',
    ),
    unsupported(
      'hq-unsupported-3',
      'route-feasibility',
      'Shortest harbor route',
      'Choose the shortest harbor route with a shortest_path primitive inside the checker.',
      'operation',
      'shortest_path',
    ),
    unsupported(
      'hq-unsupported-4',
      'pharmacy-inventory',
      'Median lot count',
      'Accept the lot list when its median quantity is inside the catalog band, using a median primitive.',
      'operation',
      'median',
    ),
    unsupported(
      'hq-unsupported-5',
      'telescope-scheduling',
      'Free-form observation dates',
      'Parse free-form local date strings into time zones inside the checker.',
      'operation',
      'date_parse',
    ),
    unsupported(
      'hq-unsupported-6',
      'harbor-fees',
      'Live harbor rate',
      'Fetch the current harbor rate from an HTTPS endpoint inside the guest.',
      'operation',
      'http_get',
    ),
    unsupported(
      'hq-unsupported-7',
      'studio-budgets',
      'Subjective cover quality',
      'Ask a language model inside the guest whether the cover prose is persuasive.',
      'operation',
      'llm_judge',
    ),
    unsupported(
      'hq-unsupported-8',
      'firmware-file',
      'SHA3 firmware digest',
      'Compare blob.bin with a SHA3-256 file hashing primitive inside the checker.',
      'operation',
      'sha3_256',
    ),
    unsupported(
      'hq-unsupported-9',
      'pharmacy-inventory',
      'PDF lot sheet',
      'Extract lot rows directly from a PDF with a native PDF parser.',
      'parser',
      'pdf/v1',
    ),
    unsupported(
      'hq-unsupported-10',
      'custody-signature',
      'X509 custody chain',
      'Validate an X.509 certificate chain and its revocation status as a native evidence profile.',
      'evidence',
      'x509/v1',
    ),
  ];
}
