// System layers for the stacked diagram. Coordinates are in a 1200×520 design box (icon centres).
// Rows: top y=95, bottom y=345, hub (600,215), footer chip (600,490), exit chip (1085,215).
const svg = (body) => `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const A = 'class="acc"'; // accent stroke (gradient colour set in CSS)

export const ICONS = {
  doc: svg(`<rect x="12" y="6" width="24" height="36" rx="3"/><path d="M18 15h12M18 22h12M18 29h7" ${A}/>`),
  files: svg(`<rect x="8" y="12" width="20" height="28" rx="3"/><rect x="20" y="6" width="20" height="28" rx="3" fill="#15151f"/><path d="M25 14h10M25 20h10M25 26h6" ${A}/>`),
  spark: svg(`<path d="M22 6c1 9 4 12 13 14-9 2-12 5-13 14-1-9-4-12-13-14 9-2 12-5 13-14z" ${A}/><path d="M37 30c.5 4 2 5.5 6 6-4 .5-5.5 2-6 6-.5-4-2-5.5-6-6 4-.5 5.5-2 6-6z"/>`),
  gear: svg(`<circle cx="24" cy="24" r="6" ${A}/><path d="M24 6v6M24 36v6M6 24h6M36 24h6M11.3 11.3l4.2 4.2M32.5 32.5l4.2 4.2M36.7 11.3l-4.2 4.2M15.5 32.5l-4.2 4.2"/><circle cx="24" cy="24" r="13"/>`),
  flask: svg(`<path d="M19 6h10M21 6v12L10 38a3 3 0 0 0 3 4h22a3 3 0 0 0 3-4L27 18V6"/><path d="M15 31h18" ${A}/><circle cx="21" cy="36" r="1.2" ${A}/><circle cx="27" cy="35" r="1.2" ${A}/>`),
  list: svg(`<path d="M8 13l3 3 5-6M8 25l3 3 5-6M8 37l3 3 5-6" ${A}/><path d="M23 14h17M23 26h17M23 38h12"/>`),
  shield: svg(`<path d="M24 5l15 6v11c0 10-6.5 17-15 21-8.5-4-15-11-15-21V11z"/><path d="M17 24l5 5 9-10" ${A}/>`),
  wallet: svg(`<path d="M8 14a4 4 0 0 1 4-4h22v8"/><rect x="8" y="14" width="33" height="26" rx="4"/><path d="M30 24h11v8H30a4 4 0 0 1 0-8z" ${A}/>`),
  tag: svg(`<path d="M6 24V8h16l20 20-16 16z"/><circle cx="15" cy="17" r="2.5" ${A}/><path d="M22 30c2-3 4 2 6-1s3-1 4 1" ${A}/>`),
  coin: svg(`<ellipse cx="24" cy="14" rx="14" ry="6" ${A}/><path d="M10 14v9c0 3.3 6.3 6 14 6s14-2.7 14-6v-9"/><path d="M10 23v9c0 3.3 6.3 6 14 6s14-2.7 14-6v-9"/>`),
  vault: svg(`<rect x="7" y="7" width="34" height="34" rx="5"/><circle cx="24" cy="24" r="8" ${A}/><path d="M24 16v-3M24 35v-3M16 24h-3M35 24h-3M24 24l4-4"/>`),
  link: svg(`<path d="M20 28l8-8"/><path d="M18 22l-5 5a6.4 6.4 0 0 0 9 9l5-5" ${A}/><path d="M30 26l5-5a6.4 6.4 0 0 0-9-9l-5 5"/>`),
  layers: svg(`<path d="M24 7l17 8-17 8-17-8z" ${A}/><path d="M7 24l17 8 17-8M7 33l17 8 17-8"/>`),
  verify: svg(`<path d="M24 5l16.5 9.5v19L24 43 7.5 33.5v-19z"/><path d="M16 24l6 6 10-11" ${A}/>`),
  robot: svg(`<path d="M24 5v6"/><circle cx="24" cy="4.5" r="1.5" ${A}/><rect x="9" y="11" width="30" height="24" rx="8"/><path d="M18 21v5M30 21v5" ${A}/><path d="M16 41h16M5 20v8M43 20v8"/>`),
  lock: svg(`<rect x="10" y="21" width="28" height="21" rx="4"/><path d="M16 21v-6a8 8 0 0 1 16 0v6"/><path d="M24 29v5" ${A}/><circle cx="24" cy="29" r="1.5" ${A}/>`),
  cube: svg(`<path d="M24 5l17 9.5v19L24 43 7 33.5v-19z"/><path d="M7 14.5L24 24l17-9.5M24 24v19" ${A}/>`),
  chip: svg(`<rect x="13" y="13" width="22" height="22" rx="3"/><rect x="19" y="19" width="10" height="10" rx="1.5" ${A}/><path d="M19 13V7M24 13V7M29 13V7M19 41v-6M24 41v-6M29 41v-6M13 19H7M13 24H7M13 29H7M41 19h-6M41 24h-6M41 29h-6"/>`),
  seal: svg(`<path d="M24 5l16.5 9.5v19L24 43 7.5 33.5v-19z"/><path d="M16 19h16M20 19v12M28 19v9c0 2 1 3 3 3" ${A}/>`),
  stop: svg(`<path d="M17 6h14l11 11v14L31 42H17L6 31V17z"/><path d="M16 24h16" ${A}/>`),
};

export const LAYERS = [
  {
    title: 'Authoring Layer',
    sub: 'Plain English becomes rules a machine can check.',
    nodes: [
      { id: 'brief', icon: 'doc', label: 'ENGLISH BRIEF', x: 130, y: 95, detail: 'The buyer describes the deliverable, the outputs and the deadline in ordinary language.' },
      { id: 'grok', icon: 'spark', label: 'GROK DRAFT', x: 360, y: 95, detail: 'grok-4.7 drafts a structured plan. It can ask up to two rounds of clarifying questions.' },
      { id: 'refs', icon: 'files', label: 'REFERENCE FILES', x: 130, y: 345, detail: 'The data the delivery is checked against, such as ledger.json. Its hash is committed on chain.' },
      { id: 'examples', icon: 'flask', label: 'LABELLED EXAMPLES', x: 360, y: 345, detail: 'Pass and fail examples are labelled by the checker itself, never by the model.' },
      { id: 'engine', icon: 'gear', label: 'CHECK ENGINE', x: 600, y: 215, big: true, detail: 'Validates the plan, renders the canonical rules and evaluates examples. If it cannot check something, no job is created.' },
      { id: 'rules', icon: 'list', label: 'CANONICAL RULES', x: 850, y: 95, chips: ['EXACT IDS', 'AMOUNTS + TOTAL', 'NONEMPTY REPORT'], detail: 'The rules shown to the buyer come from the engine’s own structure, not from the model’s prose.' },
      { id: 'approval', icon: 'shield', label: 'BUYER APPROVAL', x: 850, y: 345, detail: 'Approval records the exact structure and rules hashes. Any edit voids it.' },
      { id: 'unsupported', kind: 'chip', label: 'UNSUPPORTED → NO JOB', x: 600, y: 490 },
      { id: 'out', kind: 'chip', label: 'COMPILED GUEST', x: 1085, y: 215, link: '#layer-2' },
    ],
    edges: [['brief', 'grok'], ['refs', 'grok'], ['grok', 'engine'], ['refs', 'examples'], ['engine', 'examples'], ['engine', 'rules'], ['rules', 'approval'], ['engine', 'approval'], ['engine', 'unsupported'], ['engine', 'out']],
  },
  {
    title: 'USDC Settlement Layer',
    sub: 'Escrow on Arc that only a valid proof, or expiry, can move.',
    nodes: [
      { id: 'buyer', icon: 'wallet', label: 'BUYER WALLET', x: 130, y: 95, detail: 'Signs four transactions: create the job, set the budget, approve exactly that budget, fund.' },
      { id: 'usdc', icon: 'coin', label: 'USDC ALLOWANCE', x: 360, y: 95, detail: 'The allowance equals the budget and nothing more. USDC on Arc has 6 decimals.' },
      { id: 'quotes', icon: 'tag', label: 'SIGNED QUOTES', x: 130, y: 345, detail: 'Solvers sign EIP-712 quotes. The buyer selects one before funding.' },
      { id: 'verifier', icon: 'verify', label: 'GROTH16 VERIFIER', x: 360, y: 345, detail: 'The RISC Zero verifier contract checks the seal inside the submit call.' },
      { id: 'escrow', icon: 'vault', label: 'ERC-8183 ESCROW', x: 600, y: 215, big: true, detail: 'The agentic-commerce core holds the budget. It charges no platform or evaluator fee here.' },
      { id: 'hook', icon: 'link', label: 'SETTLEMENT HOOK', x: 850, y: 95, chips: ['TERMS FROZEN', 'PROOF ACCEPTED', 'KEY RELEASED'], detail: 'Selected-solver mode: freezes image ID, rules hash, reference hash, provider, budget and expiry at funding.' },
      { id: 'adapter', icon: 'layers', label: 'OPEN-CLAIM ADAPTER', x: 850, y: 345, chips: ['FIRST VALID PROOF', 'NO SELECTED SOLVER'], detail: 'Open-claim mode: any solver can claim a funded job with a valid proof. Verified on Arc in job #7.' },
      { id: 'refund', kind: 'chip', label: 'REFUND AFTER EXPIRY', x: 600, y: 490 },
      { id: 'out', kind: 'chip', label: 'PROVING LAYER', x: 1085, y: 215, link: '#layer-3' },
    ],
    edges: [['quotes', 'buyer'], ['buyer', 'usdc'], ['usdc', 'escrow'], ['escrow', 'verifier'], ['escrow', 'hook'], ['escrow', 'adapter'], ['escrow', 'refund'], ['escrow', 'out']],
  },
  {
    title: 'Proving Layer',
    sub: 'The solver proves its encrypted delivery passes, without revealing it first.',
    nodes: [
      { id: 'solver', icon: 'robot', label: 'SOLVER AGENT', x: 130, y: 95, detail: 'Watches the job feed, quotes, and runs funded jobs. Human-prepared files are eligible; that adapter is next.' },
      { id: 'guest', icon: 'cube', label: 'COMPILED GUEST', x: 360, y: 95, detail: 'The approved checker compiled to a zkVM program. Its image ID is frozen in the job’s terms.' },
      { id: 'files', icon: 'files', label: 'DELIVERY FILES', x: 130, y: 345, detail: 'The solver’s result.json and report.txt for this job.' },
      { id: 'envelope', icon: 'lock', label: 'ENCRYPTED ENVELOPE', x: 360, y: 345, detail: 'The files are encrypted to a key bound to the job context. Only the key’s commitment is public until release.' },
      { id: 'zkvm', icon: 'chip', label: 'RISC ZERO ZKVM', x: 600, y: 215, big: true, detail: 'Runs the guest over the delivery: 812,683 to 937,488 cycles, 101 to 148 seconds on a 24-core machine.' },
      { id: 'seal', icon: 'seal', label: 'GROTH16 SEAL', x: 850, y: 95, chips: ['260 BYTES', 'VERDICT 1', '0xE71E6620'], detail: 'A constant-size proof that the committed delivery passed the approved checker.' },
      { id: 'preflight', icon: 'stop', label: 'PREFLIGHT', x: 850, y: 345, chips: ['ETH_CALL FIRST', 'VERDICT 0 → STOP'], detail: 'Before any send, the worker simulates the call. A failing proof is never submitted.' },
      { id: 'none', kind: 'chip', label: 'NOTHING SENT ON FAILURE', x: 600, y: 490 },
      { id: 'out', kind: 'chip', label: 'FILES RECOVERED', x: 1085, y: 215, link: '#case-3' },
    ],
    edges: [['solver', 'files'], ['files', 'envelope'], ['envelope', 'zkvm'], ['guest', 'zkvm'], ['zkvm', 'seal'], ['zkvm', 'preflight'], ['zkvm', 'none'], ['zkvm', 'out']],
  },
];
