// Home page demo: three sample jobs, the recorded proof replays, live Arc confirmations and an activity feed.
// Honesty rule: the checks run in this browser and send nothing; receipts and block numbers are read live from Arc.
import { initRecordedProof } from './recorded-proof.js?v=12';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EXPLORER = 'https://explorer.testnet.arc.io/tx/';
const RPCS = ['/rpc', 'https://rpc.testnet.arc.io'];

// ---------- Arc RPC (same request the escrow inspector uses) ----------
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

// ---------- activity feed ----------
const feedList = () => $('#demo-feed');
function feed(text, tone = 'info', source = 'browser') {
  const list = feedList(); if (!list) return;
  const li = document.createElement('li');
  li.className = tone;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<time>${time}</time><span class="src ${source}">${source === 'arc' ? 'ARC' : 'CHECK'}</span><span class="msg"></span>`;
  li.querySelector('.msg').textContent = text;
  list.prepend(li);
  while (list.children.length > 30) list.lastElementChild.remove();
}

async function confirmOnArc(hash, el, label) {
  if (el) { el.hidden = false; el.textContent = 'Checking this transaction on Arc testnet…'; delete el.dataset.ok; }
  feed(`Asking Arc for the ${label} receipt…`, 'info', 'arc');
  try {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r?.transactionHash?.toLowerCase() !== hash.toLowerCase() || !/^0x[0-9a-f]+$/i.test(r.blockNumber)) throw new Error('missing');
    const block = BigInt(r.blockNumber).toLocaleString();
    const msg = r.status === '0x0' ? `Confirmed on Arc: this transaction reverted, as expected (block ${block}).` : `Confirmed on Arc in block ${block}.`;
    if (el) { el.textContent = msg; el.dataset.ok = 'true'; }
    feed(`${label}: ${r.status === '0x0' ? 'reverted on chain, as expected' : 'confirmed'} · block ${block}`, r.status === '0x0' ? 'fail' : 'pass', 'arc');
  } catch {
    if (el) el.textContent = 'Live confirmation unavailable. Open the receipt to check it on the explorer.';
    feed(`${label}: live confirmation unavailable, use the explorer link`, 'warn', 'arc');
  }
}

// Live Arc block height: shows the chain behind the receipts is live right now.
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
    } catch {
      if (++failures > 2) { el.textContent = 'unavailable'; $('#arc-live').dataset.state = 'down'; }
    }
  };
  tick(); setInterval(tick, 4000);
}

export function initDemoLab({ onOutcome = () => {}, setStatus } = {}) {
  if (!$('#invoice-demo')) return;
  const status = setStatus ?? ((t) => { const s = $('#status'); if (s) s.textContent = t; });

  // Sample picker.
  const presets = $$('.demo-preset-controls button');
  const select = (button) => {
    for (const p of presets) { const on = p === button; p.setAttribute('aria-pressed', String(on)); document.getElementById(p.getAttribute('aria-controls')).hidden = !on; }
    feed(`Opened sample: ${button.textContent.replace(/^\d+\s·\s/, '')}`);
  };
  presets.forEach((b) => b.addEventListener('click', () => select(b)));
  $$('[data-demo-preset]').forEach((link) => link.addEventListener('click', () => { const b = presets.find((p) => p.getAttribute('aria-controls') === link.dataset.demoPreset); if (b) select(b); }));

  // 01 Invoices: the home page's original rules and copy.
  const checks = $$('#check-list li');
  const COPY = {
    idle: ['Payment stays locked.', 'Pick a delivery and run the checks.', 'WAITING FOR CHECKS'],
    checking: ['Checking the delivery…', 'Comparing the files with the agreed rules.', 'CHECKING'],
    failed: ['Payment stays locked.', 'A failed check stops the payout.', 'FAILED CHECK · NO PAYOUT'],
    released: ['Payment can release.', 'All three sample checks passed.', 'SIMULATED RELEASE'],
  };
  const NAMES = ['Same invoice IDs', 'Amounts and total match', 'Report contains data'];
  let gen = 0;
  const setLab = (state) => { document.body.dataset.lab = state; const [t, c, s] = COPY[state]; $('#outcome').textContent = t; $('#outcome-copy').textContent = c; status(s); };
  function resetLab() {
    gen++; const v = $('#scenario').value; $('#run').disabled = false;
    checks.forEach((r) => { r.className = ''; r.querySelector('.ic').textContent = '○'; r.querySelector('.res').textContent = 'WAITING'; });
    $('#amount').textContent = v === 'tampered' ? '2,001¢' : '2,000¢'; $('#amount').classList.toggle('bad', v === 'tampered');
    $('#report').textContent = v === 'missing' ? 'missing' : 'nonempty'; $('#report').classList.toggle('bad', v === 'missing');
    setLab('idle'); onOutcome('idle');
  }
  $('#scenario').addEventListener('change', resetLab);
  $('#run').addEventListener('click', () => {
    resetLab(); const token = gen, v = $('#scenario').value, res = [true, v !== 'tampered', v !== 'missing'];
    $('#run').disabled = true; setLab('checking');
    feed(`Running 3 checks on "${$('#scenario').selectedOptions[0].text}"`);
    checks.forEach((r, i) => setTimeout(() => {
      if (token !== gen) return;
      r.className = res[i] ? 'pass' : 'fail'; r.querySelector('.ic').textContent = res[i] ? '✓' : '✕'; r.querySelector('.res').textContent = res[i] ? 'PASS' : 'FAIL';
      feed(`${NAMES[i]}: ${res[i] ? 'pass' : 'fail'}`, res[i] ? 'pass' : 'fail');
      if (i === checks.length - 1) {
        const ok = res.every(Boolean); setLab(ok ? 'released' : 'failed'); onOutcome(ok ? 'released' : 'failed'); $('#run').disabled = false;
        feed(ok ? 'All checks pass: payment can release' : 'A check failed: payment stays locked', ok ? 'pass' : 'fail');
      }
    }, reduced ? 0 : 450 + i * 380));
  });
  resetLab();

  // Job #3 replay (recorded-proof.js), with live confirmation of each receipt it shows.
  initRecordedProof();
  const receipt = $('#proof-receipt');
  let lastHash = null;
  new MutationObserver(() => {
    const hash = receipt.hidden ? null : receipt.href.split('/tx/')[1];
    if (!hash) { $('#invoice-chain').hidden = true; lastHash = null; return; }
    if (hash !== lastHash) { lastHash = hash; confirmOnArc(hash, $('#invoice-chain'), receipt.textContent.includes('payout') ? 'Job #3 payout' : 'Job #3 proof acceptance'); }
  }).observe(receipt, { attributes: true, attributeFilter: ['href', 'hidden'] });
  const detail = $('#proof-detail');
  new MutationObserver(() => { if (/matched the encrypted delivery/.test(detail.textContent)) feed('Job #3 delivery re-checked in this browser: hashes match the on-chain commitments', 'pass'); })
    .observe(detail, { childList: true, characterData: true, subtree: true });

  // 02 Kiln: Harbor's load and kiln limits from the checked-in Meridian reference.
  const schedule = $('#meridian-scenario'), result = $('#meridian-result');
  const kilnLimits = { 'K-03': 110, 'K-05': 88 }, harborLoad = 96;
  const gauge = () => {
    const limit = kilnLimits[schedule.value], g = $('.kiln-gauge');
    g.style.setProperty('--capacity', `${limit / 120 * 100}%`); g.style.setProperty('--load', `${harborLoad / 120 * 100}%`);
    g.classList.toggle('over-capacity', harborLoad > limit);
    $('#kiln-gauge-label').textContent = `${harborLoad} KG LOAD · ${limit} KG CAPACITY`;
  };
  schedule.addEventListener('change', () => {
    $('#meridian-kiln').textContent = schedule.value; gauge();
    result.textContent = 'Run the check to compare Harbor’s 96 kg load with the selected kiln’s capacity.'; delete result.dataset.verdict;
  });
  $('#meridian-run').addEventListener('click', () => {
    const limit = kilnLimits[schedule.value], passes = harborLoad <= limit;
    result.dataset.verdict = passes ? 'pass' : 'fail';
    result.textContent = passes
      ? `Pass. Harbor’s ${harborLoad} kg fits in kiln ${schedule.value}, which holds ${limit} kg.`
      : `Fail. Harbor exceeds kiln ${schedule.value}’s ${limit} kg capacity by ${harborLoad - limit} kg.`;
    feed(`Kiln capacity on ${schedule.value}: ${passes ? 'pass' : `fail, over by ${harborLoad - limit} kg`}`, passes ? 'pass' : 'fail');
    onOutcome(passes ? 'released' : 'failed');
  });
  gauge();

  // 03 Open bounty: recorded open-claim jobs #7 (valid claim) and #6 (invalid claim).
  const BOUNTY = {
    valid: {
      kicker: 'STEP 3 · RECORDED RUN · ARC TESTNET JOB #7', title: 'Watch a real bounty get claimed.',
      outcome: ['Bounty can be claimed.', 'The proof passes, and no one has claimed the bounty yet.'], res: [true, true, true],
      stages: [
        ['Bounty funded', 'The buyer locked 0.01 testnet USDC in the bounty.', '0x03825acc379fcfdbb640344beb64a7e78ce184449dee7399aa297e2ec730e061'],
        ['Claim accepted', 'The first valid proof won the claim. A second solver saw the winner and stopped before proving.', '0x7105aab313556ff9227864cf7e9f7db901ee048fe6e92c6483b7f8d8bcf91491'],
        ['Payout and key released', 'One release transaction paid the winner 0.01 testnet USDC and published the delivery key.', '0x78b6870536b171a989a5ebdeb278a20a2ec730bcec91173852bb29a13c3013e2'],
      ],
    },
    invalid: {
      kicker: 'STEP 3 · RECORDED RUN · ARC TESTNET JOB #6', title: 'Watch an invalid claim get rejected.',
      outcome: ['Bounty stays locked.', 'The proof fails the rules, so the claim is rejected and nothing is paid.'], res: [false, true, false],
      stages: [
        ['Claim reverted', 'Arc rejected the invalid claim. No payout was made.', '0xfd70667b27a303f9836b7520b8dceb7fc551ce99a3fa023657fb7c3c2e3290a2'],
        ['Refunded after expiry', 'With no valid claim before the deadline, the buyer took the 0.01 testnet USDC back.', '0x4e030f22684c75c5e2e5360c7428ad574400a44d7cc5a08d627dd8076d75434d'],
      ],
    },
  };
  const BNAMES = ['Proof matches the bounty’s rules', 'No earlier winner', 'Claim accepted'];
  const bChecks = $$('#bounty-checks li');
  let bGen = 0, step = -1;
  const current = () => BOUNTY[$('#bounty-scenario').value];
  function resetReplay() {
    const b = current(); step = -1;
    $('#bounty-kicker').textContent = b.kicker; $('#bounty-title').textContent = b.title;
    $('#bounty-stages').innerHTML = b.stages.map(([label]) => `<li>${label}</li>`).join('');
    $('#bounty-detail').textContent = 'Step through the historical run at your own pace.';
    $('#bounty-receipt').hidden = true; $('#bounty-chain').hidden = true; $('#bounty-next').textContent = 'Show the proof';
  }
  function resetBounty() {
    bGen++; $('#bounty-run').disabled = false;
    bChecks.forEach((r) => { r.className = ''; r.querySelector('.ic').textContent = '○'; r.querySelector('.res').textContent = 'WAITING'; });
    $('#bounty-outcome').textContent = 'Bounty stays locked.'; $('#bounty-copy').textContent = 'Choose a claim and submit it.';
    resetReplay();
  }
  $('#bounty-scenario').addEventListener('change', resetBounty);
  $('#bounty-run').addEventListener('click', () => {
    resetBounty(); const token = bGen, b = current(); $('#bounty-run').disabled = true;
    $('#bounty-outcome').textContent = 'Checking the claim…'; $('#bounty-copy').textContent = 'Comparing the proof with the bounty’s rules.';
    feed(`Submitting "${$('#bounty-scenario').selectedOptions[0].text}"`);
    bChecks.forEach((r, i) => setTimeout(() => {
      if (token !== bGen) return;
      const ok = b.res[i];
      r.className = ok ? 'pass' : 'fail'; r.querySelector('.ic').textContent = ok ? '✓' : '✕'; r.querySelector('.res').textContent = ok ? 'PASS' : 'FAIL';
      feed(`${BNAMES[i]}: ${ok ? 'pass' : 'fail'}`, ok ? 'pass' : 'fail');
      if (i === bChecks.length - 1) { [$('#bounty-outcome').textContent, $('#bounty-copy').textContent] = b.outcome; $('#bounty-run').disabled = false; onOutcome(b.res.every(Boolean) ? 'released' : 'failed'); }
    }, reduced ? 0 : 450 + i * 380));
  });
  $('#bounty-next').addEventListener('click', () => {
    const b = current(), last = b.stages.length - 1;
    step = step >= last ? -1 : step + 1;
    $$('#bounty-stages li').forEach((li, i) => { li.classList.toggle('complete', i <= step); if (i === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    if (step < 0) { resetReplay(); return; }
    const [label, detailText, hash] = b.stages[step];
    $('#bounty-detail').textContent = detailText;
    const r = $('#bounty-receipt'); r.hidden = false; r.href = EXPLORER + hash; r.textContent = `View the ${label.toLowerCase()} receipt ↗`;
    confirmOnArc(hash, $('#bounty-chain'), `Bounty · ${label}`);
    $('#bounty-next').textContent = step === last ? 'Restart replay' : 'Next step';
  });
  resetBounty();

  feed('Demo ready. Pick a sample and run it.');
  startBlockTicker();
}
