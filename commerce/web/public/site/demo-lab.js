// Home page demo: replay three real Arc testnet jobs. A progress bar walks the stages while the solver robot acts
// each one out, and the live panel logs every step and asks Arc to confirm each transaction as it is reached.
// Honesty: the checks run in this browser; every transaction is a real recorded one, confirmed live from Arc.
import { initRobot } from './robot.js?v=18';
import { verifyDelivery } from './recorded-proof.js?v=13';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EXPLORER = 'https://explorer.testnet.arc.io/tx/';
const RPCS = ['/rpc', 'https://rpc.testnet.arc.io'];
const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;

// Robot poses (robot.js): 0 reading, 1 compiling, 2 escrow funded, 3 proving, 4 paid, 5 files recovered.
const INVOICE_CHECKS = ['Same invoice IDs', 'Amounts and total match', 'Report contains data'];
const SAMPLES = {
  paid: {
    kicker: 'ARC TESTNET · JOB #3', title: 'Reconcile the invoice ledger',
    brief: 'The buyer pays 0.01 test USDC only if the delivered file has every invoice, each amount exact, and a short report.',
    amount: '2,000¢', report: 'nonempty', checks: INVOICE_CHECKS, results: [true, true, true],
    outcome: ['Paid · files released', 'Arc accepted the proof. One transaction paid the solver and released the key; the files are recoverable from chain data.'], verdict: 1,
    stages: [
      { label: 'Check the delivery', pose: 0, checks: true },
      { label: 'Fund the escrow', pose: 2, tx: '0xaf13982078e44f2217d61ba37b6e53943cd1c6e28413d6bb1e0dbf7e04981be0', look: 'JobFunded', note: 'Buyer locked 0.01 test USDC' },
      { label: 'Generate the proof', pose: 3, info: 'Real run: 260-byte Groth16 proof, 937,488 cycles, 147.7 s, verdict 1' },
      { label: 'Arc verifies the proof', pose: 3, tx: '0x05693a09af7886d83b0c7cdac00b0bd134bfc471be76cc9e7b0abaa704abf76c', look: 'JobSubmitted, ProofAccepted', note: 'Verifier contract accepted the proof' },
      { label: 'Payout and key released', pose: 4, tx: '0xb9caccce8c09ad659812fa12021f3728471caf202765a0e709cbea1c382b4956', look: 'PaymentReleased, KeyReleased', note: 'Solver paid; delivery key published' },
      { label: 'Files recovered', pose: 5, info: 'Buyer can now decrypt the files from chain data' },
    ],
    delivery: true,
  },
  refused: {
    kicker: 'ARC TESTNET · JOB #4', title: 'Same job, one cent off',
    brief: 'A cheaper solver delivered invoice-b as 2,001¢. The rules do not change, so neither does the outcome.',
    amount: '2,001¢', report: 'nonempty', checks: INVOICE_CHECKS, results: [true, false, true],
    outcome: ['Refused · refunded', 'The proof came back verdict 0, so nothing was submitted or paid. After the deadline the buyer took the money back.'], verdict: 0,
    stages: [
      { label: 'Check the delivery', pose: 0, checks: true },
      { label: 'Fund the escrow', pose: 2, tx: '0x941fd66d3a6e42143a801aa99d6926f87da93637e84c165cab5e53f0f51a696e', look: 'JobFunded', note: 'Buyer locked 0.01 test USDC' },
      { label: 'Generate the proof', pose: 3, info: 'Real run: verdict 0 after 101.1 s; the amount rule failed', fail: true },
      { label: 'Nothing sent', pose: 1, info: 'Pre-check showed Arc would reject the proof (VerificationFailed), so the solver sent nothing', fail: true },
      { label: 'Refunded after expiry', pose: 2, tx: '0xcfaa40a06a4b29fa30454e5aac373f7ffc8e8640a6c471491491500a87832540', look: 'Refunded, JobExpired', note: 'Budget returned to the buyer' },
    ],
  },
  bounty: {
    kicker: 'ARC TESTNET · OPEN-CLAIM JOB #7', title: 'Open bounty: first valid proof wins',
    brief: 'No solver is chosen in advance. Any agent can claim the 0.01 test USDC, but only with a proof that passes the same rules.',
    amount: '2,000¢', report: 'nonempty', checks: ['Proof matches the bounty’s rules', 'No earlier winner', 'Report contains data'], results: [true, true, true],
    outcome: ['Claimed · paid', 'The first valid proof won. A second solver saw the winner and stopped before proving. An invalid claim on job #6 was rejected on chain.'], verdict: 1,
    stages: [
      { label: 'Check the claim', pose: 0, checks: true },
      { label: 'Bounty funded', pose: 2, tx: '0x03825acc379fcfdbb640344beb64a7e78ce184449dee7399aa297e2ec730e061', look: 'JobFunded', note: 'Buyer locked 0.01 test USDC' },
      { label: 'Generate the proof', pose: 3, info: 'Real run: one fresh Groth16 proof, verdict 1' },
      { label: 'Claim accepted', pose: 3, tx: '0x7105aab313556ff9227864cf7e9f7db901ee048fe6e92c6483b7f8d8bcf91491', look: 'ClaimAccepted', note: 'First valid claim wins' },
      { label: 'Payout and key released', pose: 4, tx: '0x78b6870536b171a989a5ebdeb278a20a2ec730bcec91173852bb29a13c3013e2', look: 'KeyReleased', note: 'Winner paid; key published' },
    ],
    extra: { label: 'Invalid claim (job #6)', look: 'Failed (reverted)', tx: '0xfd70667b27a303f9836b7520b8dceb7fc551ce99a3fa023657fb7c3c2e3290a2' },
  },
};

// ---------- Arc RPC ----------
async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const json = await res.json();
      if (json.result !== undefined) return json.result;
    } catch { /* next endpoint */ }
  }
  throw new Error('Arc RPC unavailable');
}
async function receipt(hash) {
  try {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r?.transactionHash?.toLowerCase() !== hash.toLowerCase() || !/^0x[0-9a-f]+$/i.test(r.blockNumber)) return null;
    return { ok: r.status === '0x1', block: BigInt(r.blockNumber).toLocaleString() };
  } catch { return null; }
}

// ---------- live feed ----------
function feed(text, tone = 'info', source = 'browser') {
  const list = $('#demo-feed'); if (!list) return;
  const li = document.createElement('li');
  li.className = tone;
  li.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour12: false })}</time><span class="src ${source}">${source === 'arc' ? 'ARC' : 'CHECK'}</span><span class="msg"></span>`;
  li.querySelector('.msg').textContent = text;
  list.prepend(li);
  while (list.children.length > 40) list.lastElementChild.remove();
}
function startBlockTicker() {
  const el = $('#arc-block'); if (!el) return;
  let last = null, failures = 0;
  const tick = async () => {
    if (document.hidden) return;
    try {
      const n = BigInt(await rpc('eth_blockNumber', []));
      failures = 0;
      if (n !== last) { el.textContent = n.toLocaleString(); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); last = n; }
      $('#arc-live').dataset.state = 'live';
    } catch { if (++failures > 2) { el.textContent = 'unavailable'; $('#arc-live').dataset.state = 'down'; } }
  };
  tick(); setInterval(tick, 4000);
}

export function initDemoLab({ onOutcome = () => {}, setStatus = () => {} } = {}) {
  if (!$('#demo-robot')) return;
  let robot = null;
  try { robot = initRobot($('#demo-robot'), { reduced }); } catch { $('#demo-robot').classList.add('no-webgl'); }
  let key = 'paid', gen = 0;
  const S = () => SAMPLES[key];

  function setProgress(fraction) {
    const pct = Math.round(fraction * 100);
    $('#progress-fill').style.width = `${pct}%`;
    $('.progress').setAttribute('aria-valuenow', String(pct));
  }
  function showSample(next) {
    key = next; gen++;
    $$('.demo-preset-controls button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sample === key)));
    const s = S();
    $('#job-kicker').textContent = s.kicker; $('#job-title').textContent = s.title; $('#job-brief').textContent = s.brief;
    $('#amount').textContent = s.amount; $('#amount').classList.toggle('bad', s.amount !== '2,000¢');
    $('#report').textContent = s.report;
    $('#check-list').innerHTML = s.checks.map((c) => `<li><span class="ic">○</span>${c}<span class="res">WAITING</span></li>`).join('');
    $('#stage-list').innerHTML = s.stages.map((st) => `<li>${st.label}</li>`).join('');
    $('#verify').hidden = true; $('#run').disabled = false; $('#run').textContent = 'RUN THIS JOB ↗';
    $('#solver-state').textContent = 'READY'; setProgress(0);
    robot?.setStep(0); onOutcome('idle'); setStatus('WAITING');
    $('.demo-solver').dataset.state = 'idle';
    const job = $('.demo-job'); job.classList.remove('swap'); void job.offsetWidth; job.classList.add('swap');
  }

  function verifyRow(label, look, hash) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td class="mono">${look}</td><td><a class="demo-link mono" href="${EXPLORER}${hash}" target="_blank" rel="noreferrer">${short(hash)} ↗</a></td><td class="arc-says mono">checking…</td>`;
    $('#verify-rows').append(tr);
    return tr.querySelector('.arc-says');
  }

  async function run() {
    const token = ++gen, s = S(), stages = $$('#stage-list li'), checks = $$('#check-list li');
    const live = () => token === gen;
    $('#run').disabled = true; $('#verify').hidden = true; $('#verify-rows').innerHTML = ''; $('#delivery-check').hidden = true;
    $('#delivery-result').hidden = true; $('#proof-files').hidden = true;
    stages.forEach((li) => (li.className = ''));
    $('.demo-solver').dataset.state = 'running';
    feed(`Replaying ${s.kicker.toLowerCase().replace('arc testnet · ', '')}: ${s.title}`);
    const rows = [];
    for (let i = 0; i < s.stages.length; i++) {
      if (!live()) return;
      const st = s.stages[i];
      stages[i].className = 'active'; stages.forEach((li, j) => { if (j < i && !li.className) li.className = 'done'; });
      robot?.setStep(st.pose);
      $('#solver-state').textContent = st.label.toUpperCase();
      setProgress(i / s.stages.length);
      if (st.checks) {
        setStatus('CHECKING');
        for (let c = 0; c < checks.length; c++) {
          await sleep(500); if (!live()) return;
          const ok = s.results[c];
          checks[c].className = ok ? 'pass' : 'fail'; checks[c].querySelector('.ic').textContent = ok ? '✓' : '✕'; checks[c].querySelector('.res').textContent = ok ? 'PASS' : 'FAIL';
          feed(`${s.checks[c]}: ${ok ? 'pass' : 'fail'}`, ok ? 'pass' : 'fail');
          setProgress((i + (c + 1) / checks.length) / s.stages.length);
        }
      } else if (st.tx) {
        feed(`${st.label}: asking Arc for transaction ${short(st.tx)}…`, 'info', 'arc');
        const [r] = await Promise.all([receipt(st.tx), sleep(1400)]);
        if (!live()) return;
        if (r) feed(`${st.note}: ${r.ok ? 'confirmed' : 'failed on chain'} · block ${r.block}`, r.ok ? 'pass' : 'fail', 'arc');
        else feed(`${st.label}: live confirmation unavailable, use the explorer link`, 'warn', 'arc');
        rows.push([st.label, st.look, st.tx, r]);
      } else {
        await sleep(1600); if (!live()) return;
        feed(st.info, st.fail ? 'fail' : 'info');
      }
      stages[i].className = st.fail ? 'fail' : 'done';
    }
    if (!live()) return;
    setProgress(1);
    $('#solver-state').textContent = s.verdict ? 'DONE · PAID' : 'DONE · REFUNDED';
    const ok = s.verdict === 1;
    onOutcome(ok ? 'released' : 'failed'); setStatus(ok ? 'PAID ON ARC' : 'REFUSED · REFUNDED');
    feed(ok ? 'Job complete: the proof decided who got paid' : 'Job complete: no valid proof, so no payout', ok ? 'pass' : 'fail');

    // Result + verification table.
    [$('#outcome').textContent, $('#outcome-copy').textContent] = s.outcome;
    const badge = $('#verdict-badge'); badge.className = `badge ${ok ? 'ok' : 'no'}`; badge.textContent = `VERDICT ${s.verdict}`;
    for (const [label, look, hash, r] of rows) {
      const cell = verifyRow(label, look, hash);
      cell.textContent = r ? `${r.ok ? 'Success' : 'Failed'} · block ${r.block}` : 'unavailable';
      cell.dataset.ok = r ? String(r.ok) : '';
    }
    if (s.extra) {
      const cell = verifyRow(s.extra.label, s.extra.look, s.extra.tx);
      receipt(s.extra.tx).then((r) => { cell.textContent = r ? `${r.ok ? 'Success' : 'Failed, as expected'} · block ${r.block}` : 'unavailable'; cell.dataset.ok = r ? 'true' : ''; });
    }
    $('#delivery-check').hidden = !s.delivery;
    const panel = $('#verify'); panel.hidden = false;
    $$('#verify-rows tr').forEach((tr, i) => tr.style.setProperty('--i', i));
    panel.classList.remove('enter'); void panel.offsetWidth; panel.classList.add('enter');
    if (!reduced) setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 250);
    $('.demo-solver').dataset.state = ok ? 'paid' : 'refused';
    $('#run').disabled = false; $('#run').textContent = 'RUN AGAIN ↻';
  }

  // In-browser delivery check for job #3 (same function the recorded replay uses).
  let recording = null;
  $('#check-delivery')?.addEventListener('click', async () => {
    const out = $('#delivery-result'); out.hidden = false; out.textContent = 'Hashing the delivery and key…'; delete out.dataset.ok;
    try {
      recording ??= await (await fetch(new URL('./recorded-invoice.json', import.meta.url))).json();
      await verifyDelivery(recording);
      out.textContent = `Match: sha256(envelope) = ${short(recording.envelopeHash)} and the key opens ${short(recording.keyCommitment)}, both as accepted on Arc.`;
      out.dataset.ok = 'true';
      feed('Delivery re-checked in this browser: both hashes match the on-chain commitments', 'pass');
      const files = $('#proof-files');
      files.replaceChildren(...recording.files.map((f) => { const d = document.createElement('details'); const sum = document.createElement('summary'); const pre = document.createElement('pre'); sum.textContent = f.name; pre.textContent = f.text; d.append(sum, pre); return d; }));
      files.hidden = false;
    } catch (e) {
      out.textContent = e.message?.includes('commitment') ? e.message : 'The recording could not be checked here.';
      feed('Delivery check could not run', 'warn');
    }
  });

  $$('.demo-preset-controls button').forEach((b) => b.addEventListener('click', () => { showSample(b.dataset.sample); feed(`Selected sample: ${b.textContent.replace(/^\d+\s·\s/, '')}`); }));
  $('#run').addEventListener('click', run);
  $$('[data-sample-link]').forEach((a) => a.addEventListener('click', () => showSample(a.dataset.sampleLink)));
  showSample('paid');
  feed('Demo ready. Pick a sample and press Run.');
  startBlockTicker();
}
