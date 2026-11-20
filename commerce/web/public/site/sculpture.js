const routes = [
  [[0, .23], [.13, .23], [.24, .14], [.47, .14], [.55, .23], [.73, .23], [.83, .12], [1, .12]],
  [[0, .42], [.14, .42], [.25, .32], [.41, .32], [.50, .41], [.65, .41], [.76, .34], [1, .34]],
  [[0, .58], [.18, .58], [.29, .49], [.41, .49], [.52, .62], [.66, .62], [.78, .52], [.91, .52], [1, .44]],
  [[0, .88], [.14, .88], [.23, .76], [.44, .76], [.54, .86], [.70, .86], [.82, .74], [1, .74]],
  [[.13, .23], [.13, .31], [.20, .37], [.25, .32]],
  [[.26, 1], [.26, .90], [.35, .76], [.35, .63], [.41, .58], [.41, .49]],
  [[.47, .14], [.47, .23], [.55, .30], [.55, .53], [.66, .62]],
  [[.73, 0], [.73, .10], [.65, .17], [.65, .41]],
  [[.91, .52], [.91, .63], [.96, .68], [.96, 1]],
];
const steps = [[-.86, -.24], [0, -.46], [.86, -.68], [-.43, .51], [.43, .29]];
const pulseDuration = .72;
const clamp = (value, max = 1) => Math.max(0, Math.min(max, value));

export function initSculpture(host, { reduced = false } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);

  const deck = document.createElement('canvas');
  const ink = deck.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let still = reduced;
  let width = 0;
  let height = 0;
  let scale = 1;
  let paths = [];
  let cluster;
  let visible = false;
  let frame = 0;
  let start = null;
  let time = 0;
  const hover = steps.map(() => 0);
  let activeBlock = -1;
  let pointer = null;
  let pendingPulse = false;
  let lastPulse = -Infinity;
  let pulses = [];

  function line(context, points, color, strokeWidth = 1, fill) {
    context.beginPath();
    for (const [x, y] of points) context.lineTo(x, y);
    if (fill) {
      context.closePath();
      context.fillStyle = fill;
      context.fill();
    }
    context.strokeStyle = color;
    context.lineWidth = strokeWidth;
    context.stroke();
  }

  function circle(context, x, y, radius, color) {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  }

  function measurePath(points) {
    const lengthAt = [0];
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i];
      const [lastX, lastY] = points[i - 1];
      lengthAt.push(lengthAt[i - 1] + Math.hypot(x - lastX, y - lastY));
    }
    return { points, lengthAt, length: lengthAt.at(-1) };
  }

  function cacheNetwork() {
    ink.setTransform(scale, 0, 0, scale, 0, 0);
    ink.clearRect(0, 0, width, height);
    ink.lineJoin = 'round';
    for (const [index, route] of routes.entries()) {
      const points = route.map(([x, y]) => [x * width, y * height]);
      const tint = ink.createLinearGradient(0, 0, width, height * .38);
      tint.addColorStop(0, 'rgba(100,205,184,.24)');
      tint.addColorStop(.53, 'rgba(82,181,167,.30)');
      tint.addColorStop(1, 'rgba(121,232,197,.49)');
      line(ink, points, tint, index < 4 ? 1.15 : .8);
      for (const [i, [x, y]] of points.entries()) {
        if (i === 0 || i === points.length - 1 || (index > 3 && i % 2)) continue;
        circle(ink, x, y, index < 4 ? 2.4 : 1.8, 'rgba(132,227,202,.44)');
      }
      paths.push(measurePath(points));
    }
  }

  function pointOn(path, distance) {
    const end = path.lengthAt.findIndex((length) => length > distance);
    if (end < 1) return path.points.at(-1);
    const [x, y] = path.points[end - 1];
    const [nextX, nextY] = path.points[end];
    const fraction = (distance - path.lengthAt[end - 1]) / (path.lengthAt[end] - path.lengthAt[end - 1]);
    return [x + (nextX - x) * fraction, y + (nextY - y) * fraction];
  }

  function nearestLink(x, y, drift) {
    let nearest;
    const groups = [[paths, x, y, false], [cluster.links, x - cluster.x, y - cluster.y - drift, true]];
    for (const [links, px, py, foreground] of groups) {
      for (const path of links) {
        for (let i = 1; i < path.points.length; i++) {
          const [ax, ay] = path.points[i - 1];
          const [bx, by] = path.points[i];
          const dx = bx - ax, dy = by - ay;
          const length = path.lengthAt[i] - path.lengthAt[i - 1];
          const fraction = clamp(((px - ax) * dx + (py - ay) * dy) / (length * length));
          const distance = Math.hypot(px - ax - dx * fraction, py - ay - dy * fraction);
          if (!nearest || distance < nearest.distance) {
            nearest = { path, foreground, distance, offset: path.lengthAt[i - 1] + fraction * length };
          }
        }
      }
    }
    return nearest;
  }

  function drawPulses(seconds, foreground) {
    for (const pulse of pulses) {
      if (pulse.foreground !== foreground) continue;
      const { path, offset } = pulse;
      const age = seconds - pulse.born;
      ctx.save();
      ctx.globalAlpha = still ? .8 : clamp(1 - age / pulseDuration);
      for (const direction of [-1, 1]) {
        const rawHead = offset + direction * (still ? 16 : 6 + age * 235);
        const tail = rawHead - direction * 40;
        if (Math.max(rawHead, tail) < 0 || Math.min(rawHead, tail) > path.length) continue;
        const first = clamp(Math.min(rawHead, tail), path.length);
        const last = clamp(Math.max(rawHead, tail), path.length);
        const points = [pointOn(path, first), ...path.points.filter((_, i) => path.lengthAt[i] > first && path.lengthAt[i] < last), pointOn(path, last)];
        line(ctx, points, 'rgba(117,225,255,.24)', 7);
        line(ctx, points, foreground ? '#b4f5ff' : '#7edde8', 2);
        const [x, y] = pointOn(path, clamp(rawHead, path.length));
        circle(ctx, x, y, 3.1, '#ebffff');
      }
      ctx.restore();
    }
  }

  function blockPose(step) {
    const [x, y] = cluster.tiles[step];
    const amount = still ? 0 : hover[step];
    return { x, y: y - Math.min(10, cluster.blockSize * .06) * amount, size: cluster.blockSize * (1 + amount * .13) };
  }

  function driftAt(seconds) { return Math.sin(seconds * .82) * cluster.unit * .023; }

  function updatePointer(seconds, delta) {
    if (!cluster) return;
    const drift = driftAt(seconds);
    activeBlock = -1;
    if (pointer) {
      for (let i = cluster.tiles.length - 1; i >= 0; i--) {
        const pose = blockPose(i);
        const dx = Math.abs(pointer.x - cluster.x - pose.x);
        const dy = pointer.y - cluster.y - drift - pose.y;
        if (dx <= pose.size / 2 && dy >= dx / 2 - pose.size * .25 && dy <= pose.size * .68 - dx / 2) {
          activeBlock = i;
          break;
        }
      }
    }
    const ease = still ? 1 : 1 - Math.exp(-17 * delta);
    for (let i = 0; i < hover.length; i++) hover[i] += ((i === activeBlock ? 1 : 0) - hover[i]) * ease;
    pulses = still ? [] : pulses.filter((pulse) => seconds - pulse.born < pulseDuration);
    if (!pointer || (!still && (!pendingPulse || seconds - lastPulse < .055))) return;
    const link = nearestLink(pointer.x, pointer.y, drift);
    if (link) pulses.push({ ...link, born: seconds });
    if (pulses.length > 8) pulses.shift();
    lastPulse = seconds;
    pendingPulse = false;
  }

  function drawBlock(x, y, size, kind, light) {
    const half = size / 2;
    const slope = size * .25;
    const depth = size * .43;
    const left = [x - half, y];
    const right = [x + half, y];
    const leftBottom = [x - half, y + depth];
    const rightBottom = [x + half, y + depth];
    const front = [x, y + slope];
    const top = [x, y - slope];
    const frontBottom = [x, y + slope + depth];
    const rim = kind === 2 ? '#91d9eb' : '#73649f';
    line(ctx, [left, front, frontBottom, leftBottom], rim, 1, '#251c46');
    line(ctx, [front, right, rightBottom, frontBottom], rim, 1, '#17132f');
    const tint = ctx.createLinearGradient(x - half, y - slope, x + half, y + slope);
    tint.addColorStop(0, kind === 2 ? '#30647f' : '#534286');
    tint.addColorStop(1, kind === 2 ? '#283354' : '#2c2451');
    line(ctx, [left, top, right, front], rim, 1, tint);

    const edgeLight = kind === 1 || kind === 3 ? '#f5c98c' : kind === 2 ? '#a9efff' : '#b5a5fa';
    ctx.save();
    ctx.beginPath();
    for (const [px, py] of [top, right, rightBottom, frontBottom, leftBottom, left]) ctx.lineTo(px, py);
    ctx.closePath();
    ctx.moveTo(...left);
    ctx.lineTo(...front);
    ctx.lineTo(...right);
    ctx.moveTo(...front);
    ctx.lineTo(...frontBottom);
    ctx.strokeStyle = edgeLight;
    ctx.globalAlpha = .11 + light * .15;
    ctx.lineWidth = 6.5;
    ctx.stroke();
    ctx.globalAlpha = .23 + light * .20;
    ctx.lineWidth = 3.1;
    ctx.stroke();
    ctx.globalAlpha = .63 + light * .35;
    ctx.lineWidth = 1.1 + light * .5;
    ctx.stroke();
    ctx.restore();
    drawSymbol(x, y, size, kind);
  }

  function drawSymbol(x, y, size, step) {
    const color = step === 1 || step === 3 ? '#ffe1ad' : '#b0f4ff';
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 40, size / 56);
    const pen = 1.1;

    function stroke(points) {
      line(ctx, points, color, pen);
    }

    function outline(drawPath) {
      ctx.beginPath();
      drawPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = pen;
      ctx.stroke();
    }

    if (step === 0) {
      for (const row of [-4.5, 0, 4.5]) {
        stroke([[-6.5, row], [-5.1, row + 1.3], [-2.6, row - 1.4]]);
        stroke([[-.2, row], [6.3, row]]);
      }
    } else if (step === 1) {
      outline(() => ctx.roundRect(-5.6, -.6, 11.2, 7.1, 1));
      outline(() => ctx.arc(0, -.8, 3.3, Math.PI, 0));
      stroke([[0, 2], [0, 4]]);
    } else if (step === 2) {
      stroke([[-5.3, 7], [-5.3, -7], [1.5, -7], [5.3, -3.2], [5.3, 7], [-5.3, 7]]);
      stroke([[1.5, -7], [1.5, -3.2], [5.3, -3.2]]);
      stroke([[-2.6, 0], [2.8, 0]]);
      stroke([[-2.6, 3.2], [2.8, 3.2]]);
    } else if (step === 3) {
      outline(() => ctx.arc(0, 0, 6.9, 0, Math.PI * 2));
      outline(() => {
        ctx.moveTo(2.7, -2.9);
        ctx.bezierCurveTo(-4.7, -5, -4.3, -.1, 0, 0);
        ctx.bezierCurveTo(4.3, .1, 4.7, 5, -2.7, 2.9);
      });
      stroke([[0, -4.8], [0, 4.8]]);
    } else {
      outline(() => ctx.arc(-3, -2.7, 3.1, 0, Math.PI * 2));
      stroke([[-.8, -.5], [5.7, 6], [7.2, 4.4]]);
      stroke([[3.3, 3.6], [4.8, 2]]);
    }
    ctx.restore();
  }

  function draw(seconds) {
    if (!width || !height) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(deck, 0, 0, width, height);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const [index, path] of paths.entries()) {
      const speed = index < 4 ? 44 : 29;
      const distance = (seconds * speed + path.length * ((index * .19 + .23) % 1)) % path.length;
      const [x, y] = pointOn(path, distance);
      circle(ctx, x, y, index < 4 ? 7 : 5, 'rgba(131,255,214,.10)');
      circle(ctx, x, y, index < 4 ? 2.8 : 1.9, index === 6 ? '#eed298' : '#adf7d7');
    }

    drawPulses(seconds, false);
    const { x, y, unit, tiles, links } = cluster;
    ctx.save();
    ctx.translate(x, y + driftAt(seconds));
    for (const [index, link] of links.entries()) {
      line(ctx, link.points, 'rgba(151,207,255,.75)', 1.25);
      const packets = index === 2 ? 2 : 1;
      for (let packet = 0; packet < packets; packet++) {
        const phase = (seconds * unit * .46 / link.length + index * .21 + packet / packets) % 1;
        const [dotX, dotY] = pointOn(link, (.22 + phase * .56) * link.length);
        circle(ctx, dotX, dotY, 6.4, 'rgba(147,227,255,.22)');
        circle(ctx, dotX, dotY, 2.65, '#d4f9ff');
      }
    }
    drawPulses(seconds, true);
    const [proofX, proofY] = tiles[2];
    const glow = ctx.createRadialGradient(proofX, proofY, 0, proofX, proofY, unit * .63);
    glow.addColorStop(0, 'rgba(126,215,255,.24)');
    glow.addColorStop(1, 'rgba(126,215,255,0)');
    circle(ctx, proofX, proofY, unit * .63, glow);
    function paintBlock(step) {
      const { x, y, size } = blockPose(step);
      if (hover[step] > .01) {
        const aura = ctx.createRadialGradient(x, y + size * .17, size * .10, x, y + size * .17, size * .78);
        const light = step === 1 || step === 3 ? '255,217,150' : '127,225,255';
        aura.addColorStop(0, `rgba(${light},${hover[step] * .55})`);
        aura.addColorStop(1, `rgba(${light},0)`);
        circle(ctx, x, y + size * .17, size * .83, aura);
      }
      drawBlock(x, y, size, step, hover[step]);
    }
    tiles.forEach((_, step) => { if (step !== activeBlock) paintBlock(step); });
    if (activeBlock >= 0) paintBlock(activeBlock);
    ctx.restore();
  }

  function resize() {
    width = host.clientWidth;
    height = host.clientHeight;
    if (!width || !height) return;
    scale = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = deck.width = Math.round(width * scale);
    canvas.height = deck.height = Math.round(height * scale);
    const compact = matchMedia('(max-width: 900px)').matches;
    const unit = compact ? Math.min(width * .34, 182) : Math.min(width * .202, height * .36, 348);
    const blockSize = unit * (compact ? .76 : .78);
    const tiles = steps.map(([left, top]) => [left * unit, top * unit]);
    const [checks, escrow, proof, payment, delivery] = tiles;
    const bridge = unit * .045;
    const bend = unit * .11;
    const links = [
      [checks, escrow],
      [escrow, proof],
      [proof, [proof[0], bridge - bend], [proof[0] - bend, bridge], [payment[0] + bend, bridge], [payment[0], bridge + bend], payment],
      [payment, delivery],
    ].map(measurePath);
    cluster = {
      x: width * (compact ? .50 : .71),
      y: compact ? Math.min(height * .73, height - unit * .51 - blockSize * .68 - 12) : height * .53,
      unit,
      blockSize,
      tiles,
      links,
    };
    paths = [];
    cacheNetwork();
    pulses = [];
    pendingPulse = pointer !== null;
    if (still) updatePointer(0, 0);
    draw(time);
  }

  function tick(now) {
    start ??= now - time * 1000;
    const previous = time;
    time = (now - start) / 1000;
    updatePointer(time, Math.min(.1, time - previous));
    draw(time);
    frame = requestAnimationFrame(tick);
  }

  function updateMotion() {
    cancelAnimationFrame(frame);
    start = null;
    if (still) {
      time = 0;
      lastPulse = -Infinity;
      updatePointer(0, 0);
      draw(time);
    } else if (visible && !document.hidden) {
      frame = requestAnimationFrame(tick);
    }
  }

  const hero = host.closest('.hero') || host;
  hero.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const bounds = host.getBoundingClientRect();
    const next = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (!pointer || Math.hypot(next.x - pointer.x, next.y - pointer.y) > 1) pendingPulse = true;
    pointer = next;
    if (still) {
      updatePointer(0, 0);
      draw(0);
    }
  }, { passive: true });
  hero.addEventListener('pointerleave', () => {
    pointer = null;
    pendingPulse = false;
    if (still) {
      updatePointer(0, 0);
      draw(0);
    }
  });

  new ResizeObserver(resize).observe(host);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    updateMotion();
  }).observe(host);
  document.addEventListener('visibilitychange', updateMotion);
  motion.addEventListener('change', ({ matches }) => {
    still = matches;
    updateMotion();
  });
  resize();

  return { diagnostics: () => ({ width, height, time, ledgerBlocks: steps.length, paths: paths.length, activeBlock, hover: [...hover], pulses: pulses.length }) };
}
