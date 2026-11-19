// Proof engine: a measured replacement for the solver robot. Same interface as robot.js:
//   initRobot(host, { reduced }) -> { setStep(i) -> label, label() }
// A ring of six stage segments fills as the job advances; the centre shows a line icon for the
// current stage with a small, purposeful motion (scan, tick, deposit, prove, release, unlock).
const NS = 'http://www.w3.org/2000/svg';
const LABEL = ['READING THE BRIEF', 'COMPILING THE CHECKER', 'ESCROW FUNDED', 'PROVING', 'PAID · KEY RELEASED', 'FILES RECOVERED'];
const C = 300, R = 248, GAP = 7;

function arc(r, a0, a1) {
  const p = (a) => [C + r * Math.cos((a - 90) * Math.PI / 180), C + r * Math.sin((a - 90) * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

const GLYPHS = [
  // 0 brief: a document with a scanning bar
  `<g class="gl gl-brief"><rect x="225" y="190" width="150" height="200" rx="14"/><path d="M252 236h96M252 266h96M252 296h70M252 326h84"/>
    <rect class="scan" x="236" y="200" width="128" height="10" rx="5"/></g>`,
  // 1 checker: three rules ticking in turn
  `<g class="gl gl-check"><path d="M230 230h140M230 300h140M230 370h140" class="rule"/>
    <path class="tick t1" d="M236 218l12 12 24-26"/><path class="tick t2" d="M236 288l12 12 24-26"/><path class="tick t3" d="M236 358l12 12 24-26"/></g>`,
  // 2 escrow: a coin dropping into a locked vault
  `<g class="gl gl-escrow"><rect x="220" y="270" width="160" height="120" rx="16"/><path d="M255 270v-34a45 45 0 0 1 90 0v34"/>
    <circle cx="300" cy="330" r="12" class="keyhole"/><g class="coin"><circle cx="300" cy="180" r="26"/><path d="M300 166v28M292 174h14a6 6 0 0 1 0 12h-12"/></g></g>`,
  // 3 proving: a proof hexagon with orbiting particles
  `<g class="gl gl-prove"><path class="hex" d="M300 205l82 47v96l-82 47-82-47v-96z"/><path class="hex2" d="M300 245l47 27v56l-47 27-47-27v-56z"/>
    <g class="orbit"><circle cx="300" cy="170" r="6"/><circle cx="430" cy="300" r="5"/><circle cx="300" cy="430" r="6"/><circle cx="170" cy="300" r="5"/></g></g>`,
  // 4 paid: the lock opens and the coin leaves for the solver
  `<g class="gl gl-paid"><rect x="220" y="270" width="160" height="120" rx="16"/><path class="shackle" d="M255 270v-34a45 45 0 0 1 90 0v8"/>
    <g class="coin out"><circle cx="300" cy="330" r="26"/><path d="M300 316v28M292 324h14a6 6 0 0 1 0 12h-12"/></g></g>`,
  // 5 files: a key unlocks the file
  `<g class="gl gl-files"><path d="M235 190h90l45 45v155a12 12 0 0 1-12 12H235a12 12 0 0 1-12-12V202a12 12 0 0 1 12-12z"/><path d="M325 190v45h45"/>
    <path class="ok" d="M262 318l24 24 48-52"/><g class="key"><circle cx="190" cy="430" r="16"/><path d="M206 430h56M246 430v14M232 430v10"/></g></g>`,
];

export function initRobot(host, { reduced = false } = {}) {
  if (!host) return null;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 600 600');
  svg.setAttribute('class', `engine${reduced ? ' still' : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const seg = 360 / 6;
  const segments = LABEL.map((_, i) => `<path class="seg" data-i="${i}" d="${arc(R, i * seg + GAP / 2, (i + 1) * seg - GAP / 2)}"/>`).join('');
  const nodes = LABEL.map((_, i) => {
    const a = (i * seg + seg / 2 - 90) * Math.PI / 180, x = C + (R + 30) * Math.cos(a), y = C + (R + 30) * Math.sin(a);
    return `<text class="num" data-i="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}">0${i + 1}</text>`;
  }).join('');
  svg.innerHTML = `<circle class="grid" cx="300" cy="300" r="200"/><circle class="grid" cx="300" cy="300" r="150"/>
    <circle class="spin" cx="300" cy="300" r="214"/>
    <g class="segs">${segments}</g><g class="nums">${nodes}</g>
    <g class="glyphs">${GLYPHS.map((g, i) => g.replace('<g class="gl ', `<g data-i="${i}" class="gl `)).join('')}</g>`;
  host.append(svg);

  let step = -1;
  function setStep(i) {
    i = Math.max(0, Math.min(5, Number(i) || 0));
    if (i !== step) {
      step = i;
      svg.dataset.step = String(i);
      svg.querySelectorAll('.seg, .num').forEach((el) => {
        const k = Number(el.dataset.i);
        el.classList.toggle('done', k < i);
        el.classList.toggle('active', k === i);
      });
      svg.querySelectorAll('.gl').forEach((g) => g.classList.toggle('on', Number(g.dataset.i) === i));
    }
    return LABEL[step];
  }
  setStep(0);
  return { setStep, label: () => LABEL[step] };
}
