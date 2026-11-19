// Scope map: marketplaces on the left feed the proof-gated escrow hub, which pays out on verified services on the right.
// When the section scrolls into view, nodes fade in one by one, their wires draw, then pulses keep flowing.
const NS = 'http://www.w3.org/2000/svg';

export function initScopeMap(root) {
  const map = root?.querySelector('.scope-map');
  if (!map) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const svg = map.querySelector('.scope-wires');
  const hub = map.querySelector('.scope-hub');
  const ins = [...map.querySelectorAll('.scope-in .node')];
  const outs = [...map.querySelectorAll('.scope-out .node')];
  let wires = [];

  function draw() {
    const box = map.getBoundingClientRect();
    if (getComputedStyle(svg).display === 'none' || !box.width) return;
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    svg.replaceChildren();
    const h = hub.querySelector('.hub-ring').getBoundingClientRect();
    const hx = h.left + h.width / 2 - box.left, hy = h.top + h.height / 2 - box.top, hr = h.width / 2;
    wires = [];
    const make = (node, side, i) => {
      const r = node.getBoundingClientRect();
      const y = r.top + r.height / 2 - box.top;
      const x = side === 'in' ? r.right - box.left : r.left - box.left;
      const ex = side === 'in' ? hx - hr : hx + hr;
      const ey = hy + (y - hy) * .18;
      const mx = (x + ex) / 2;
      const d = side === 'in' ? `M${x} ${y} C${mx} ${y} ${mx} ${ey} ${ex} ${ey}` : `M${ex} ${ey} C${mx} ${ey} ${mx} ${y} ${x} ${y}`;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d); path.classList.add('wire', side); path.style.setProperty('--i', i);
      svg.append(path);
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`; path.style.strokeDashoffset = map.dataset.stage === 'done' ? '0' : `${len}`;
      if (!reduced) {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('r', '3.2'); dot.classList.add('spark', side);
        const motion = document.createElementNS(NS, 'animateMotion');
        motion.setAttribute('dur', `${2.4 + (i % 3) * .5}s`); motion.setAttribute('repeatCount', 'indefinite');
        motion.setAttribute('begin', `${(i * .37) % 2}s`); motion.setAttribute('path', d);
        dot.append(motion); svg.append(dot);
      }
      wires.push({ path, len, side, i });
    };
    ins.forEach((n, i) => make(n, 'in', i));
    outs.forEach((n, i) => make(n, 'out', i));
  }

  const STEP = 260;
  function play() {
    map.dataset.stage = 'playing';
    const reveal = (el, at) => setTimeout(() => el.classList.add('on'), at);
    const wire = (w, at) => setTimeout(() => { w.path.style.transition = 'stroke-dashoffset .7s cubic-bezier(.4,0,.2,1)'; w.path.style.strokeDashoffset = '0'; }, at);
    ins.forEach((n, i) => { reveal(n, i * STEP); const w = wires.find((x) => x.side === 'in' && x.i === i); if (w) wire(w, i * STEP + 120); });
    const hubAt = ins.length * STEP + 250;
    reveal(hub, hubAt);
    outs.forEach((n, i) => { const at = hubAt + 450 + i * STEP; const w = wires.find((x) => x.side === 'out' && x.i === i); if (w) wire(w, at - 120); reveal(n, at); });
    setTimeout(() => { map.dataset.stage = 'done'; }, hubAt + 450 + outs.length * STEP + 600);
  }

  new ResizeObserver(() => requestAnimationFrame(draw)).observe(map);
  draw();
  if (reduced) { [...ins, hub, ...outs].forEach((n) => n.classList.add('on')); map.dataset.stage = 'done'; draw(); return; }
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect(); draw(); play();
  }, { threshold: .3 });
  io.observe(map);
}
