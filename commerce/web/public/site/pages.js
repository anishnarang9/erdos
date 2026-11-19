// Shared behaviour for demo.html and agents.html: mobile menu, demo replay, guide navigation.
// The demo replays RECORDED Arc testnet runs (see commerce/evidence and agents/anish/reports). It sends nothing.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tx = (h) => `https://explorer.testnet.arc.io/tx/${h}`;
const short = (h) => `${h.slice(0, 8)}…${h.slice(-6)}`;

// ---------- chrome ----------
const toggle = $('.menu-toggle'), mobile = $('#mobile-nav');
toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); mobile.hidden = !open; });

// ---------- demo ----------
const PROBLEMS = [
  {
    brief: 'Reconcile our invoice ledger. Deliver result.json with exactly the invoices in ledger.json, each amount equal to the ledger, plus a short report.txt.',
    rules: ['Same invoice IDs as the ledger, no duplicates', 'Each amount equals the ledger amount', 'Totals match', 'report.txt is not empty'],
    reference: 'ledger.json', deliverables: 'result.json · report.txt', budget: '0.01 USDC',
    passDesc: 'Every amount matches the ledger.', failDesc: 'invoice-b is off by one cent.',
    pass: { preview: '{\n  "rows": [\n    { "id": "invoice-a", "amountCents": 1000 },\n    { "id": "invoice-b", "amountCents": 2000 }\n  ]\n}',
      outcome: 'Paid · files released', copy: 'Arc accepted the proof. One transaction paid the solver and released the key, and the buyer decrypted the files.',
      verdict: 1, metrics: [['147.7 s', 'proof time'], ['937,488', 'guest cycles'], ['260 B', 'seal']],
      hashes: [['envelopeHash', '0xe85d0d24416ef80f30b29b7c91f80b29f5dbb17dac77250f00b182460d363b3b'], ['keyCommitment', '0xca3dd3d96089168d143159a7e5f27dcb43c479819341bb3046d381d7fd65b405']],
      txs: [['Submit · proof accepted', '0x05693a09af7886d83b0c7cdac00b0bd134bfc471be76cc9e7b0abaa704abf76c'], ['Release · payout + key', '0xb9caccce8c09ad659812fa12021f3728471caf202765a0e709cbea1c382b4956']],
      source: 'Recorded run: Arc job #3, 16 Nov 2026.' },
    fail: { preview: '{\n  "rows": [\n    { "id": "invoice-a", "amountCents": 1000 },\n    { "id": "invoice-b", "amountCents": 2001 }\n  ]\n}',
      outcome: 'Refused · refunded', copy: 'The proof came back verdict 0. The pre-check showed the chain would reject it, so nothing was submitted or paid. After the deadline the buyer reclaimed the budget.',
      verdict: 0, metrics: [['101.1 s', 'proof time'], ['937,488', 'guest cycles'], ['0 USDC', 'paid']],
      hashes: [],
      txs: [['Fund · escrow locked', null, '0x941fd66d…1a696e'], ['Refund · after expiry', '0xcfaa40a06a4b29fa30454e5aac373f7ffc8e8640a6c471491491500a87832540']],
      source: 'Recorded run: Arc job #4, 16 Nov 2026.' },
  },
  {
    brief: 'Post a bounty for the same reconciliation. No solver is chosen in advance: the first agent to submit a valid proof is paid.',
    rules: ['Same invoice IDs as the ledger, no duplicates', 'Each amount equals the ledger amount', 'Totals match', 'First valid claim wins'],
    reference: 'ledger.json', deliverables: 'result.json · report.txt', budget: '0.01 USDC',
    passDesc: 'A valid proof wins the claim.', failDesc: 'An invalid claim is submitted.',
    pass: { preview: 'claim(jobId, envelope, seal, keyCommitment)\n→ ClaimAccepted\nrelease(jobId, key)\n→ KeyReleased · 0.01 USDC paid',
      outcome: 'Claimed · paid', copy: 'The first valid proof won the claim. A second solver saw the winner and stopped before proving.',
      verdict: 1, metrics: [['0.01', 'USDC paid'], ['0.0329', 'USDC gas, whole job'], ['1 of 2', 'solvers proved']],
      hashes: [],
      txs: [['Fund · bounty locked', '0x03825acc379fcfdbb640344beb64a7e78ce184449dee7399aa297e2ec730e061'], ['Claim · proof accepted', '0x7105aab313556ff9227864cf7e9f7db901ee048fe6e92c6483b7f8d8bcf91491'], ['Release · payout + key', '0x78b6870536b171a989a5ebdeb278a20a2ec730bcec91173852bb29a13c3013e2']],
      source: 'Recorded run: open-claim job #7, 16 Nov 2026.' },
    fail: { preview: 'claim(jobId, envelope, badSeal, keyCommitment)\n→ reverted · no payout',
      outcome: 'Claim reverted · refunded', copy: 'The adapter rejected the invalid claim on chain and paid nothing. The bounty was refunded to the buyer after expiry.',
      verdict: 0, metrics: [['reverted', 'claim'], ['0 USDC', 'paid'], ['0.01', 'USDC refunded']],
      hashes: [],
      txs: [['Claim · reverted', '0xfd70667b27a303f9836b7520b8dceb7fc551ce99a3fa023657fb7c3c2e3290a2'], ['Refund · after expiry', '0x4e030f22684c75c5e2e5360c7428ad574400a44d7cc5a08d627dd8076d75434d']],
      source: 'Recorded run: open-claim job #6, 16 Nov 2026.' },
  },
  {
    brief: 'Convert our product catalog from CSV to JSON. Keep every row, and make sure each product has an id, a name and a price.',
    rules: ['Row count equals the source CSV', 'Every row has id, name and price', 'IDs are unique', 'Prices are non-negative'],
    reference: 'catalog.csv', deliverables: 'catalog.json', budget: '0.01 USDC',
    passDesc: 'All rows converted with every field.', failDesc: 'One product is missing its price.',
    pass: { preview: '[\n  { "id": "sku-101", "name": "Desk lamp", "price": 2400 },\n  { "id": "sku-102", "name": "Notebook", "price": 450 }\n]',
      outcome: 'Would be paid', copy: 'This sample has no recorded run yet. Once integrated, the proof and its Arc transactions appear here.',
      verdict: 1, metrics: [['—', 'proof time'], ['—', 'guest cycles'], ['260 B', 'seal']], hashes: [],
      txs: [['Submit · proof accepted', null, 'available after integration'], ['Release · payout + key', null, 'available after integration']],
      source: 'Preview only: no on-chain run yet.' },
    fail: { preview: '[\n  { "id": "sku-101", "name": "Desk lamp", "price": 2400 },\n  { "id": "sku-102", "name": "Notebook" }\n]',
      outcome: 'Would be refused', copy: 'This sample has no recorded run yet. A missing field fails the check, so no valid proof of success could be produced.',
      verdict: 0, metrics: [['—', 'proof time'], ['—', 'guest cycles'], ['0 USDC', 'paid']], hashes: [],
      txs: [['Refund · after expiry', null, 'available after integration']],
      source: 'Preview only: no on-chain run yet.' },
  },
];

function initDemo() {
  const tabs = $$('.problem'); if (!tabs.length) return;
  let current = 0, gen = 0;
  const choice = () => $('input[name="delivery"]:checked').value;
  const setText = (id, t) => { $(`#${id}`).textContent = t; };

  function showProblem(i) {
    current = i; gen++;
    tabs.forEach((t, k) => { const on = k === i; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    $('#workbench').setAttribute('aria-labelledby', `tab-${i}`);
    const p = PROBLEMS[i];
    setText('brief', p.brief); setText('reference', p.reference); setText('deliverables', p.deliverables); setText('budget', p.budget);
    setText('pass-desc', p.passDesc); setText('fail-desc', p.failDesc);
    $('#rules').innerHTML = p.rules.map((r) => `<li>${r}</li>`).join('');
    resetRun();
  }
  function resetRun() {
    gen++;
    const run = PROBLEMS[current][choice()];
    setText('preview', run.preview);
    $$('#pipeline li').forEach((li) => (li.className = ''));
    setText('run-state', 'READY');
    $('#receipt').hidden = true; $('#empty').hidden = false; $('#run').disabled = false;
  }
  function render(run) {
    const ok = run.verdict === 1;
    const badge = $('#verdict-badge'); badge.className = `badge ${ok ? 'ok' : 'no'}`; badge.textContent = `VERDICT ${run.verdict}`;
    setText('outcome', run.outcome); setText('outcome-copy', run.copy); setText('source', run.source);
    $('#metrics').innerHTML = run.metrics.map(([v, l]) => `<div><dt>${v}</dt><dd>${l}</dd></div>`).join('');
    $('#hashes').innerHTML = run.hashes.map(([k, v]) => `<dt>${k}</dt><dd class="mono" title="${v}">${short(v)}</dd>`).join('');
    $('#hashes').hidden = !run.hashes.length;
    $('#txs').innerHTML = run.txs.map(([label, hash, note]) => hash
      ? `<a class="tx" href="${tx(hash)}" target="_blank" rel="noreferrer"><span>${label}</span><span class="mono">${short(hash)} ↗</span></a>`
      : `<div class="tx off"><span>${label}</span><span class="mono">${note}</span></div>`).join('');
    $('#empty').hidden = true; $('#receipt').hidden = false;
  }
  function run() {
    const token = ++gen, r = PROBLEMS[current][choice()], steps = $$('#pipeline li');
    $('#run').disabled = true; $('#receipt').hidden = true; $('#empty').hidden = false; setText('run-state', 'RUNNING');
    const last = steps.length - 1, delay = reduced ? 0 : 520;
    steps.forEach((li, k) => setTimeout(() => {
      if (token !== gen) return;
      // A failing proof stops at verification (red), and settlement becomes a refund.
      const finalClass = (j) => (j === 3 && r.verdict === 0 ? 'fail' : j === last && r.verdict === 0 ? 'refund' : 'done');
      steps.forEach((s, j) => { if (j < k) s.className = finalClass(j); });
      li.className = k === 3 && r.verdict === 0 ? 'fail' : k === last ? finalClass(k) : 'active';
      if (k === last) {
        setTimeout(() => { if (token !== gen) return; steps.forEach((s, j) => (s.className = finalClass(j))); setText('run-state', r.verdict ? 'SETTLED' : 'REFUSED'); render(r); $('#run').disabled = false; $('#receipt').scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); }, delay);
      }
    }, k * delay));
  }

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => showProblem(i));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; tabs[n].focus(); showProblem(n);
    });
  });
  $$('input[name="delivery"]').forEach((r) => r.addEventListener('change', resetRun));
  $('#run').addEventListener('click', run);
  showProblem(0);
}

// ---------- agents guide: highlight the section in view ----------
function initGuide() {
  const links = $$('.doc-nav a'); if (!links.length) return;
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
  }), { rootMargin: '-30% 0px -60% 0px' });
  $$('.doc-section').forEach((s) => io.observe(s));
}

initDemo();
initGuide();
