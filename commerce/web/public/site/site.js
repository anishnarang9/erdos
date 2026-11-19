import { initGlobe } from './globe.js?v=12';
import { initRobot } from './robot.js?v=18';
import { initRecordedProof } from './recorded-proof.js?v=12';
import { initCoin } from './coin.js?v=9';
import { LAYERS, ICONS } from './layers.js?v=9';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// ---------- text decode ("different latency" reveals) ----------
const GLYPHS = '▚▞▓▒░#<>/\\_=+*';
const timers = new WeakMap();
/** Decode text left to right from noise. Screen readers get the final text through aria-label. */
function decode(el, delay = 0, text) {
  const final = text ?? el.dataset.text ?? el.textContent; el.dataset.text = final; el.setAttribute('aria-label', final);
  clearTimeout(timers.get(el)?.t); cancelAnimationFrame(timers.get(el)?.r);
  if (reduced) { el.textContent = final; el.classList.add('sc-in'); return; }
  const state = {}; timers.set(el, state);
  el.textContent = ''; el.classList.remove('sc-in');
  state.t = setTimeout(() => {
    el.classList.add('sc-in');
    const dur = 260 + final.length * 16, t0 = performance.now();
    const tick = (now) => {
      const p = clamp((now - t0) / dur), n = Math.floor(p * final.length);
      let out = final.slice(0, n);
      for (let i = n; i < Math.min(final.length, n + 4); i++) out += final[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      el.textContent = out;
      if (p < 1) state.r = requestAnimationFrame(tick); else el.textContent = final;
    };
    state.r = requestAnimationFrame(tick);
  }, delay);
}
/** Decode every [data-sc] inside a root with staggered, slightly irregular delays. */
function decodeAll(root, base = 0, step = 85) { $$('[data-sc]', root).forEach((el, i) => decode(el, base + i * step + Math.random() * 140)); }

// ---------- chrome ----------
const toggle = $('.menu-toggle'), mobile = $('#mobile-nav');
toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); mobile.hidden = !open; });
mobile?.addEventListener('click', (e) => { if (e.target.closest('a')) { mobile.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || mobile.hidden) return;
  mobile.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.focus();
});

// ---------- WebGL scenes ----------
const safe = (fn, name) => { try { return fn(); } catch (err) { console.warn(`${name} unavailable`, err); return null; } };
const globe = safe(() => initGlobe($('#globe'), { reduced }), 'Globe'); if (!globe) $('#globe').classList.add('no-webgl');
const robot = safe(() => initRobot($('#robot'), { reduced }), 'Robot');
const coin = safe(() => initCoin($('#coin'), { reduced }), 'Coin');
// ---------- solutions: fixed centre robot, scrolling rows ----------
const rows = $$('.sol-row'), robotLabel = $('#robot-label');
let activeRow = -1;
const escrowReceipts = {
  paid: ['Solver', '0.01 test USDC paid', 'Job #3 passed its checks. The release paid the solver and published the delivery key.', 'release', '0xb9caccce8c09ad659812fa12021f3728471caf202765a0e709cbea1c382b4956'],
  refund: ['Buyer', '0 test USDC paid to solver', 'Job #4 failed preflight. The bounty stayed locked until expiry, when the buyer claimed a refund.', 'refund', '0xcfaa40a06a4b29fa30454e5aac373f7ffc8e8640a6c471491491500a87832540'],
};
let receiptRequest;
async function checkEscrowReceipt(hash) {
  receiptRequest?.abort();
  const current = new AbortController();
  receiptRequest = current;
  const status = $('#chain-check');
  status.textContent = 'Checking the transaction on Arc Testnet...';
  const timeout = setTimeout(() => current.abort(), 8000);
  try {
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
      signal: current.signal,
    });
    if (!response.ok) throw new Error('Receipt lookup unavailable');
    const { result } = await response.json();
    if (result?.transactionHash?.toLowerCase() !== hash || !/^0x[0-9a-f]+$/i.test(result.blockNumber)) {
      throw new Error('Receipt unavailable');
    }
    if (receiptRequest !== current) return;
    if (result.status === '0x0') {
      status.textContent = 'Arc reports this transaction reverted.';
    } else if (result.status === '0x1') {
      status.textContent = 'Transaction confirmed in block ' + BigInt(result.blockNumber).toLocaleString() + '.';
    } else {
      throw new Error('Unknown receipt status');
    }
  } catch {
    if (receiptRequest === current) status.textContent = 'Live receipt unavailable. View the recorded transaction in the explorer.';
  } finally {
    clearTimeout(timeout);
  }
}
const receiptObserver = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) {
    receiptObserver.disconnect();
    if (!receiptRequest) checkEscrowReceipt(escrowReceipts.paid[4]);
  }
});
receiptObserver.observe($('.escrow-inspector'));
$$('[data-escrow]').forEach(button => button.addEventListener('click', () => {
  const selected = button.dataset.escrow;
  const [end, amount, story, action, hash] = escrowReceipts[selected];
  checkEscrowReceipt(hash);
  $('.escrow-inspector').dataset.outcome = selected;
  $$('[data-escrow]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  $('#route-end').textContent = end;
  $('#escrow-value').textContent = amount;
  $('#escrow-history').textContent = story;
  $('#escrow-receipt').href = 'https://explorer.testnet.arc.io/tx/' + hash;
  $('#escrow-receipt').textContent = 'Inspect ' + action + ' receipt ↗';
}));
function setRow(i) {
  if (i === activeRow) return; activeRow = i;
  rows.forEach((r, k) => r.classList.toggle('active', k === i));
  if (i < 0) return;
  const label = robot ? robot.setStep(Number(rows[i].dataset.step)) : '';
  if (robotLabel) decode(robotLabel, 0, `SOLVER AGENT · ${label}`);
  decodeAll(rows[i], 60, 70);
}

// ---------- ecosystem layers ----------
const NS = 'http://www.w3.org/2000/svg';
const W = 1200, H = 520;
function rectOf(n) { const w = n.kind === 'chip' ? Math.max(120, n.label.length * 8.6 + 34) : n.big ? 150 : 104, h = n.kind === 'chip' ? 38 : n.big ? 150 : 104; return { x: n.x, y: n.y, w, h }; }
/** Orthogonal connector with 45° chamfers, leaving `a` and entering `b` on their facing sides. */
function route(a, b, gap = 10) {
  const dx = b.x - a.x, dy = b.y - a.y, c = 12, sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const x1 = a.x + sx * (a.w / 2 + gap), x2 = b.x - sx * (b.w / 2 + gap);
    if (Math.abs(dy) < 2 * c) return `M${x1} ${a.y} L${x2} ${b.y}`;
    const mx = (x1 + x2) / 2;
    return `M${x1} ${a.y} L${mx - sx * c} ${a.y} L${mx} ${a.y + sy * c} L${mx} ${b.y - sy * c} L${mx + sx * c} ${b.y} L${x2} ${b.y}`;
  }
  const y1 = a.y + sy * (a.h / 2 + gap + (a.labelBelow && sy > 0 ? 74 : 0)), y2 = b.y - sy * (b.h / 2 + gap + (b.labelBelow && sy < 0 ? 74 : 0));
  if (Math.abs(dx) < 2 * c) return `M${a.x} ${y1} L${b.x} ${y2}`;
  const my = (y1 + y2) / 2;
  return `M${a.x} ${y1} L${a.x} ${my - sy * c} L${a.x + sx * c} ${my} L${b.x - sx * c} ${my} L${b.x} ${my + sy * c} L${b.x} ${y2}`;
}
function renderLayers() {
  const stack = $('#eco-stack'); if (!stack) return;
  LAYERS.forEach((layer, li) => {
    const el = document.createElement('article'); el.className = 'layer'; el.style.setProperty('--i', li); el.id = `layer-${li + 1}`;
    el.innerHTML = `<div class="layer-tag"><span class="mono">LAYER</span><span class="numbox">0${li + 1}</span></div>
      <div class="layer-main"><h3>${layer.title}</h3><p class="layer-sub">${layer.sub}</p>
      <div class="diagram-wrap"><div class="diagram" role="group" aria-label="${layer.title} diagram"></div></div></div>`;
    const dia = $('.diagram', el);
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'wires'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<defs><marker id="ah${li}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#8a8aa0" stroke-width="1.4"/></marker>
      <linearGradient id="wg${li}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="#63f0ff"/><stop offset=".5" stop-color="#a86bff"/><stop offset="1" stop-color="#ff5fd2"/></linearGradient></defs>`;
    dia.append(svg);
    const byId = Object.fromEntries(layer.nodes.map((n) => [n.id, n]));
    layer.edges.forEach(([from, to], ei) => {
      const a = { ...rectOf(byId[from]), labelBelow: byId[from].kind !== 'chip' }, b = { ...rectOf(byId[to]), labelBelow: byId[to].kind !== 'chip' };
      const d = route(a, b);
      const base = document.createElementNS(NS, 'path'); base.setAttribute('d', d); base.setAttribute('class', 'wire'); base.setAttribute('pathLength', '1'); base.setAttribute('marker-end', `url(#ah${li})`); base.style.setProperty('--d', `${500 + ei * 110}ms`);
      const pulse = document.createElementNS(NS, 'path'); pulse.setAttribute('d', d); pulse.setAttribute('class', 'pulse'); pulse.setAttribute('pathLength', '1'); pulse.setAttribute('stroke', `url(#wg${li})`); pulse.style.animationDelay = `${-ei * .7}s`;
      svg.append(base, pulse);
    });
    layer.nodes.forEach((n, ni) => {
      const node = document.createElement('div'); node.className = `node ${n.kind ?? 'tile'}${n.big ? ' big' : ''}${n.link ? ' linkout' : ''}`;
      node.style.left = `${n.x}px`; node.style.top = `${n.y}px`; node.style.setProperty('--d', `${120 + ni * 90}ms`);
      if (n.kind === 'chip') {
        node.innerHTML = n.link ? `<a href="${n.link}"><span data-sc>${n.label}</span> <b aria-hidden="true">»</b></a>` : `<span data-sc>${n.label}</span>`;
      } else {
        const chips = (n.chips ?? []).map((c) => `<span data-sc>${c}</span>`).join('');
        node.innerHTML = `<div class="tile-row"><div class="icon">${ICONS[n.icon] ?? ''}</div>${chips ? `<div class="chips">${chips}</div>` : ''}</div>
          <div class="label" data-sc>${n.label}</div>
          ${n.detail ? `<button class="plus" aria-expanded="false" aria-label="About ${n.label}">+</button><div class="detail" hidden>${n.detail}</div>` : ''}`;
      }
      dia.append(node);
    });
    if (li === LAYERS.length - 1) el.classList.add('last');
    stack.append(el);
  });
  // Sticky elements are bounded by the container's content box, so the scroll room must be a real element.
  const tail = document.createElement('div'); tail.className = 'stack-tail'; tail.setAttribute('aria-hidden', 'true'); stack.append(tail);
  // "+" expanders: one open at a time.
  stack.addEventListener('click', (e) => {
    const btn = e.target.closest('.plus'); if (!btn) return;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    $$('.plus[aria-expanded="true"]', stack).forEach((b) => { b.setAttribute('aria-expanded', 'false'); b.textContent = '+'; b.nextElementSibling.hidden = true; b.closest('.node').classList.remove('open'); });
    if (open) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = '−'; btn.nextElementSibling.hidden = false; btn.closest('.node').classList.add('open'); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.plus[aria-expanded="true"]', stack).forEach((b) => b.click()); });
  // Fit the 1200×520 design box to the width, and to the height left under the two pinned header strips.
  const fit = () => {
    // Short screens pin slimmer header strips so the top layer's diagram still fits.
    const step = innerHeight < 860 ? 60 : Math.min(132, innerHeight * .13), room = innerHeight - 66 - 24 - 2 * step - 178;
    stack.style.setProperty('--step', `${step}px`); stack.classList.toggle('slim', step === 60);
    $$('.diagram-wrap', stack).forEach((w) => { const s = Math.max(.62, Math.min(1.15, w.clientWidth / W, room / H)); w.style.setProperty('--s', s); w.style.height = innerWidth > 1100 ? `${H * s}px` : ''; });
  };
  new ResizeObserver(fit).observe(stack); fit();
  // Activate a layer (nodes pop in, wires draw, labels decode) the first time it is well in view.
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('live'); decodeAll(e.target, 250, 60); io.unobserve(e.target); } }), { threshold: .3 });
  $$('.layer', stack).forEach((l) => (reduced ? l.classList.add('live') : io.observe(l)));
}
renderLayers();

// ---------- scroll-driven state ----------
const hero = $('.hero');
const sol = $('.sol-body'), token = $('.token');
const sectionLinks = $$('.rail a').map(link => ({
  link,
  section: document.getElementById(link.dataset.sec),
}));

const stageFigure = $('.sol-stage');
const systemSection = $('#layers');
function onScroll() {
  const vh = innerHeight, wide = innerWidth > 1100;
  const systemTop = systemSection.getBoundingClientRect().top;
  const figureOpacity = clamp((systemTop - vh * .72) / (vh * .28));
  stageFigure.style.opacity = reduced ? String(Number(figureOpacity > 0)) : String(figureOpacity);
  stageFigure.style.visibility = figureOpacity > 0 ? 'visible' : 'hidden';
  // Hero: the globe swells and drifts toward the centre; copy lifts away.
  const hp = clamp(scrollY / (hero.offsetHeight * .9));
  globe?.setLayout({ x: (wide ? 2.3 : 0) - hp * 1.2, y: (wide ? .25 : 1.1) + hp * .9, s: .74 + hp * .5 });
  // Solutions: the row whose centre is nearest the viewport centre is active.
  if (sol) {
    const sr = sol.getBoundingClientRect();
    if (sr.top < vh * .7 && sr.bottom > vh * .3) {
      let best = 0, bd = Infinity; rows.forEach((r, i) => { const b = r.getBoundingClientRect(); const d = Math.abs(b.top + b.height / 2 - vh / 2); if (d < bd) { bd = d; best = i; } });
      setRow(best);
    }
  }
  // Coin turns as its section scrolls through.
  if (token && coin) { const r = token.getBoundingClientRect(); coin.setScroll(clamp((vh - r.top) / (vh + r.height)) * 2 - 1); }
  let current = sectionLinks[0];
  for (const item of sectionLinks) {
    if (item.section.getBoundingClientRect().top <= vh * .4) current = item;
  }
  for (const item of sectionLinks) {
    item.link.classList.toggle('active', item === current);
    if (item === current) item.link.setAttribute('aria-current', 'location');
    else item.link.removeAttribute('aria-current');
  }
}
let ticking = false;
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { onScroll(); ticking = false; }); } }, { passive: true });
addEventListener('resize', onScroll); onScroll();

// Reveal each block once. Content is readable before observation and on anchor jumps.
if (!reduced) {
  document.documentElement.classList.add('motion');
  const blocks = $$('.reveal, .case, .mat, .faq details, .title-wrap, .lab-panel, .sol-left, .scope-examples > *, .token-left, .escrow-inspector, .token-links, .eco-lead');
  const observer = new IntersectionObserver(entries => {
    const destination = document.querySelector(':target');
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const block = entry.target;
      const atDestination = destination && ((destination.contains(block) && block.getBoundingClientRect().top < innerHeight && destination.getBoundingClientRect().top >= -1) || block.contains(destination));
      if (!atDestination && !block.matches(':focus-within')) block.classList.add('scroll-enter');
      if (block.matches('.token-left, .token-links')) decodeAll(block, 150, 110);
      observer.unobserve(block);
    }
  }, { rootMargin: '0px 0px -4% 0px' });
  blocks.forEach(block => observer.observe(block));
}

// Copy the escrow address.
$('#copy-addr')?.addEventListener('click', async (e) => {
  const b = e.currentTarget, label = $('[data-sc]', b);
  try { await navigator.clipboard.writeText(b.dataset.addr); decode(label, 0, 'COPIED'); } catch { decode(label, 0, b.dataset.addr.slice(0, 10) + '…'); }
  setTimeout(() => decode(label, 0, '0x4992…e9c8'), 1600);
});

// ---------- proof lab (simulation only) ----------
const checks = $$('#check-list li');
const COPY = {
  idle: ['Payment stays locked.', 'Pick a delivery and run the checks.', 'WAITING FOR CHECKS'],
  checking: ['Checking the delivery…', 'Comparing the files with the agreed rules.', 'CHECKING'],
  failed: ['Payment stays locked.', 'A failed check stops the payout.', 'FAILED CHECK · NO PAYOUT'],
  released: ['Payment can release.', 'All three sample checks passed.', 'SIMULATED RELEASE'],
};
let gen = 0;
function setLab(state) { document.body.dataset.lab = state; const [t, c, s] = COPY[state]; $('#outcome').textContent = t; $('#outcome-copy').textContent = c; decode($('#status'), 0, s); }
function resetLab() {
  gen++; const v = $('#scenario').value;
  $('#run').disabled = false;
  checks.forEach((r) => { r.className = ''; r.querySelector('.ic').textContent = '○'; r.querySelector('.res').textContent = 'WAITING'; });
  $('#amount').textContent = v === 'tampered' ? '2,001¢' : '2,000¢'; $('#amount').classList.toggle('bad', v === 'tampered');
  $('#report').textContent = v === 'missing' ? 'missing' : 'nonempty'; $('#report').classList.toggle('bad', v === 'missing');
  setLab('idle'); globe?.setOutcome('idle');
}
$('#scenario').addEventListener('change', resetLab);
$('#run').addEventListener('click', () => {
  resetLab(); const token2 = gen, v = $('#scenario').value, res = [true, v !== 'tampered', v !== 'missing'];
  $('#run').disabled = true; setLab('checking');
  checks.forEach((r, i) => setTimeout(() => {
    if (token2 !== gen) return;
    r.className = res[i] ? 'pass' : 'fail'; r.querySelector('.ic').textContent = res[i] ? '✓' : '✕'; decode(r.querySelector('.res'), 0, res[i] ? 'PASS' : 'FAIL');
    if (i === checks.length - 1) { const ok = res.every(Boolean); setLab(ok ? 'released' : 'failed'); globe?.setOutcome(ok ? 'released' : 'failed'); $('#run').disabled = false; }
  }, reduced ? 0 : 450 + i * 380));
});
resetLab();
initRecordedProof();

const presets = $$('.demo-preset-controls button');
function selectPreset(panel) {
  for (const preset of presets) {
    const target = preset.getAttribute('aria-controls');
    const selected = target === panel;
    preset.setAttribute('aria-pressed', String(selected));
    document.getElementById(target).hidden = !selected;
  }
}
presets.forEach(button => button.addEventListener('click', () => selectPreset(button.getAttribute('aria-controls'))));
$$('[data-demo-preset]').forEach(link => link.addEventListener('click', () => selectPreset(link.dataset.demoPreset)));

// Harbor's load and kiln limits come from the checked-in Meridian reference and passing schedule.
const schedule = $('#meridian-scenario');
const capacityResult = $('#meridian-result');
const kilnLimits = { 'K-03': 110, 'K-05': 88 };
const harborLoad = 96;
function updateKilnGauge() {
  const limit = kilnLimits[schedule.value];
  $('.kiln-gauge').style.setProperty('--capacity', `${limit / 120 * 100}%`);
  $('.kiln-gauge').style.setProperty('--load', `${harborLoad / 120 * 100}%`);
  $('.kiln-gauge').classList.toggle('over-capacity', harborLoad > limit);
  $('#kiln-gauge-label').textContent = `${harborLoad} KG LOAD · ${limit} KG CAPACITY`;
}
schedule.addEventListener('change', () => {
  $('#meridian-kiln').textContent = schedule.value;
  updateKilnGauge();
  capacityResult.textContent = 'Run the check to compare Harbor’s 96 kg load with the selected kiln’s capacity.';
  delete capacityResult.dataset.verdict;
});
updateKilnGauge();
$('#meridian-run').addEventListener('click', () => {
  const limit = kilnLimits[schedule.value];
  const passes = harborLoad <= limit;
  capacityResult.dataset.verdict = passes ? 'pass' : 'fail';
  capacityResult.textContent = passes
    ? `Pass. Harbor’s ${harborLoad} kg fits in kiln ${schedule.value}, which holds ${limit} kg.`
    : `Fail. Harbor exceeds kiln ${schedule.value}’s ${limit} kg capacity by ${harborLoad - limit} kg.`;
});

window.siteDiagnostics = () => ({ globe: globe?.diagnostics(), row: activeRow, robot: robot?.label(), layers: $$('.layer').length, live: $$('.layer.live').length, lab: document.body.dataset.lab });
