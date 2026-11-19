import { initGlobe } from './globe.js?v=9';
import { initRobot } from './robot.js?v=17';
import { initDemoLab } from './demo-lab.js?v=1';
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
const motionBtn = $('#motion');
const syncMotion = () => { const p = globe?.isPaused() ?? true; motionBtn.textContent = p ? 'RESUME MOTION' : 'PAUSE MOTION'; motionBtn.setAttribute('aria-pressed', String(p)); };
motionBtn.addEventListener('click', () => { globe?.setPaused(!globe.isPaused()); syncMotion(); }); syncMotion();

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

// Reveals: blocks rise in; marked text decodes with staggered latency.
if (!reduced) {
  document.documentElement.classList.add('motion');
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); if (e.target.matches('.token-grid, .token-links, .hero')) decodeAll(e.target, 150, 110); io.unobserve(e.target); } }), { threshold: .18 });
  $$('.reveal, .case, .mat, .faq details, .title-wrap, .lab-panel, .token-grid, .token-links, .eco-lead, [data-fade]').forEach((el, i) => { el.style.setProperty('--d', `${(i % 4) * 90}ms`); io.observe(el); });
}

// Copy the escrow address.
$('#copy-addr')?.addEventListener('click', async (e) => {
  const b = e.currentTarget, label = $('[data-sc]', b);
  try { await navigator.clipboard.writeText(b.dataset.addr); decode(label, 0, 'COPIED'); } catch { decode(label, 0, b.dataset.addr.slice(0, 10) + '…'); }
  setTimeout(() => decode(label, 0, '0x4992…e9c8'), 1600);
});

// ---------- demo (three samples, proof replays, live Arc feed) ----------
initDemoLab({ onOutcome: (kind) => globe?.setOutcome(kind), setStatus: (text) => decode($('#status'), 0, text) });

window.siteDiagnostics = () => ({ globe: globe?.diagnostics(), row: activeRow, robot: robot?.label(), layers: $$('.layer').length, live: $$('.layer.live').length, lab: document.body.dataset.lab });
