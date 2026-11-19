// "Built with" network: every tool we use, wired by circuit traces into the proof-gated escrow.
// Hover or focus a tile: it enlarges with a glowing edge in its brand colour and a pulse runs to the centre.
// While idle, a random tool pings every couple of seconds.
import { TOOLS } from './tool-data.js?v=2';

const ORDER = [
  ['TypeScript', 'Node.js', 'Hono', 'Zod', 'RISC Zero', 'Groth16', 'Rust', 'SQLite', 'Docker', 'GitHub'],
  ['React', 'Three.js', 'Vite', 'Arc', null, 'USDC', 'Solidity', 'Foundry', 'ERC-8183'],
  ['Vitest', 'esbuild', 'pnpm', 'viem', 'Circle', 'Ethereum', 'ethers', 'noble', 'xAI Grok', 'Vercel'],
];
// Brand glow for marks whose official colour is near black.
const GLOW = { Rust: '#f0a070', 'Three.js': '#e5e7eb', 'xAI Grok': '#e5e7eb', Vercel: '#e5e7eb', GitHub: '#c4b5fd', Solidity: '#9ca3af', Ethereum: '#8a92ff', SQLite: '#5fb4e0', ethers: '#6c7cff' };
const SVGNS = 'http://www.w3.org/2000/svg';

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function initToolNetwork(host) {
  if (!host) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const grid = host.querySelector('.tool-grid');
  const caption = host.querySelector('.tool-caption');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.classList.add('tool-traces'); svg.setAttribute('aria-hidden', 'true');
  host.querySelector('.tool-net').prepend(svg);

  const tiles = [];
  ORDER.forEach((row, r) => row.forEach((name, c) => {
    if (!name) {
      const hub = document.createElement('div');
      hub.className = 'tool-hub'; hub.style.gridRow = String(r + 1); hub.style.gridColumn = `${c + 1} / span 2`;
      const logo = document.querySelector('.brand svg')?.cloneNode(true);
      if (logo) { logo.querySelector('linearGradient')?.setAttribute('id', 'lg-tools'); logo.querySelectorAll('[stroke="url(#lg)"]').forEach((n) => n.setAttribute('stroke', 'url(#lg-tools)')); }
      hub.innerHTML = '<span class="hub-disc"></span><span class="hub-label">ERDOS</span>';
      if (logo) hub.querySelector('.hub-disc').append(logo);
      hub.setAttribute('aria-label', 'Erdos, proof-gated escrow');
      grid.append(hub);
      return;
    }
    const t = byName[name];
    const dark = luminance(t.color) < 0.18;
    const glow = GLOW[name] || t.color;
    const col = r === 1 && c > 4 ? c + 2 : c + 1;
    const b = document.createElement('button');
    b.type = 'button'; b.className = `tool${dark ? ' dark' : ''}`;
    b.style.gridRow = String(r + 1); b.style.gridColumn = String(col);
    b.style.setProperty('--c', t.color); b.style.setProperty('--g', glow);
    b.setAttribute('aria-label', `${t.name}: ${t.role}`);
    const glyph = t.path
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.path}"/></svg>`
      : `<b aria-hidden="true" data-len="${t.mono.length}">${t.mono}</b>`;
    b.innerHTML = `<span class="disc">${glyph}</span><span class="tool-name" aria-hidden="true">${t.name}</span>`;
    grid.append(b);
    tiles.push({ el: b, t, glow, row: r, col });
  }));
  const hub = grid.querySelector('.tool-hub');

  // Traces: each tile drops to the bus between its row and the hub row, runs along it, then enters the hub.
  function route(tile, box) {
    const R = 10;
    const tb = tile.el.getBoundingClientRect(), hb = hub.getBoundingClientRect();
    const x = tb.left + tb.width / 2 - box.left;
    const hubL = hb.left - box.left, hubR = hb.right - box.left, hubT = hb.top - box.top, hubB = hb.bottom - box.top;
    if (tile.row === 1) { // same row: straight into the hub's side
      const y = tb.top + tb.height / 2 - box.top;
      return tile.col < 6 ? `M${tb.right - box.left} ${y} H${hubL}` : `M${tb.left - box.left} ${y} H${hubR}`;
    }
    const up = tile.row === 0;
    const y0 = up ? tb.bottom - box.top : tb.top - box.top;
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 16;
    const bus = up ? y0 + gap / 2 : y0 - gap / 2;
    const ex = Math.min(Math.max(x, hubL + 22), hubR - 22);
    const tx = Math.abs(x - ex) < 1 ? x : ex;
    const dir = Math.sign(tx - x);
    const vy = up ? 1 : -1;
    if (!dir) return `M${x} ${y0} V${up ? hubT : hubB}`;
    const r = Math.min(R, Math.abs(tx - x) / 2);
    return `M${x} ${y0} V${bus - vy * r} Q${x} ${bus} ${x + dir * r} ${bus} H${tx - dir * r} Q${tx} ${bus} ${tx} ${bus + vy * r} V${up ? hubT : hubB}`;
  }
  function draw() {
    const tileBox = tiles[0]?.el.getBoundingClientRect();
    if (tileBox && getComputedStyle(svg).display !== "none") { hub.style.width = hub.style.height = `${tileBox.height}px`; } else { hub.style.width = hub.style.height = ""; }
    if (getComputedStyle(svg).display === 'none') return;
    const box = host.querySelector('.tool-net').getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    svg.replaceChildren();
    for (const tile of tiles) {
      const d = route(tile, box);
      const base = document.createElementNS(SVGNS, 'path'); base.setAttribute('d', d); base.classList.add('trace');
      const pulse = document.createElementNS(SVGNS, 'path'); pulse.setAttribute('d', d); pulse.classList.add('pulse');
      pulse.style.stroke = tile.glow;
      svg.append(base, pulse);
      tile.base = base; tile.pulse = pulse; tile.len = pulse.getTotalLength();
      pulse.style.strokeDasharray = `26 ${tile.len + 40}`; pulse.style.strokeDashoffset = '26';
    }
  }
  new ResizeObserver(() => requestAnimationFrame(draw)).observe(host.querySelector('.tool-net'));

  function fire(tile) {
    if (!tile.pulse) return;
    tile.base.classList.add('lit'); tile.base.style.stroke = tile.glow;
    hub.style.setProperty('--hc', tile.glow); hub.classList.remove('hit'); void hub.offsetWidth; hub.classList.add('hit');
    if (reduced) return;
    tile.pulse.animate([{ strokeDashoffset: 26, opacity: 1 }, { strokeDashoffset: -tile.len, opacity: 1 }], { duration: 650 + tile.len * 0.6, easing: 'cubic-bezier(.4,0,.2,1)' });
  }
  function rest(tile) { tile.base?.classList.remove('lit'); if (tile.base) tile.base.style.stroke = ''; }
  const idle = caption.textContent;
  let hovered = null;
  for (const tile of tiles) {
    const on = () => { hovered = tile; fire(tile); caption.innerHTML = `<b>${tile.t.name}</b> · ${tile.t.role}`; caption.style.setProperty('--g', tile.glow); };
    const off = () => { if (hovered === tile) hovered = null; rest(tile); caption.textContent = idle; };
    tile.el.addEventListener('pointerenter', on); tile.el.addEventListener('focus', on);
    tile.el.addEventListener('pointerleave', off); tile.el.addEventListener('blur', off);
  }

  // Idle pings while the section is on screen.
  if (!reduced) {
    let visible = false, last = null;
    new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(host);
    setInterval(() => {
      if (!visible || hovered || document.hidden) return;
      let tile; do { tile = tiles[(Math.random() * tiles.length) | 0]; } while (tile === last);
      last = tile;
      tile.el.classList.add('ping'); fire(tile);
      setTimeout(() => { tile.el.classList.remove('ping'); rest(tile); }, 1100);
    }, 1500);
  }
}
