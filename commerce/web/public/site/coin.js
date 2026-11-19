import * as THREE from './vendor/three.module.js';
// The escrow coin: an original emblem (our orbit mark) on a reeded disc. It turns with scroll and the pointer.
// Decorative only: it is not a token and represents no balance.

export function initCoin(host, { reduced = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0, 0); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  // Studio environment for the metal.
  { const s = new THREE.Scene(); s.background = new THREE.Color(0x030308);
    const box = (col, i, x, y, z, sx, sy) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(i), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m); };
    box(0xffffff, 5, 0, 9, 3, 12, 5); box(0x63f0ff, 6, -9, 0, 3, 4, 10); box(0xff5fd2, 6, 9, 0, 3, 4, 10); box(0xa86bff, 3, 0, -8, 4, 10, 3);
    const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(s, .03).texture; pm.dispose(); }
  const camera = new THREE.PerspectiveCamera(30, 1, .1, 100); camera.position.set(0, 0, 9.5);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2); keyLight.position.set(2, 4, 6); scene.add(keyLight);

  const gc = document.createElement('canvas'); gc.width = 512; gc.height = 4; const g = gc.getContext('2d'); const lg = g.createLinearGradient(0, 0, 512, 0);
  [[0, '#63f0ff'], [.25, '#6bffd8'], [.45, '#ffe66b'], [.6, '#ffb65c'], [.78, '#ff5fd2'], [.9, '#a86bff'], [1, '#63f0ff']].forEach(([o, c]) => lg.addColorStop(o, c));
  g.fillStyle = lg; g.fillRect(0, 0, 512, 4); const grad = new THREE.CanvasTexture(gc); grad.colorSpace = THREE.SRGBColorSpace; grad.wrapS = THREE.RepeatWrapping;
  const gradMat = new THREE.MeshBasicMaterial({ map: grad, toneMapped: false });
  const metal = new THREE.MeshPhysicalMaterial({ color: 0x101018, roughness: .28, metalness: 1, clearcoat: 1, clearcoatRoughness: .2 });
  const face = new THREE.MeshPhysicalMaterial({ color: 0x07070d, roughness: .5, metalness: .9 });

  const coin = new THREE.Group(); scene.add(coin);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, .42, 128, 1), metal); body.rotation.x = Math.PI / 2; coin.add(body);
  // Reeded edge
  const reedGeo = new THREE.BoxGeometry(.05, .05, .44); const reeds = new THREE.InstancedMesh(reedGeo, metal, 120); const m4 = new THREE.Matrix4();
  for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2; m4.makeRotationZ(a); m4.setPosition(Math.cos(a) * 2.42, Math.sin(a) * 2.42, 0); reeds.setMatrixAt(i, m4); } coin.add(reeds);
  for (const z of [.215, -.215]) {
    const side = new THREE.Group(); side.position.z = z; if (z < 0) side.rotation.y = Math.PI; coin.add(side);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.18, 96), face); disc.position.z = .002; side.add(disc);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(2.24, .07, 12, 160), metal); side.add(rim);
    // circuit texture lines
    const lines = []; let sd = z > 0 ? 7 : 19; const r = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 46; i++) { const a = r() * Math.PI * 2, r0 = .5 + r() * 1.5, len = .2 + r() * .5, horiz = r() < .5; const x = Math.cos(a) * r0, y = Math.sin(a) * r0; lines.push(x, y, .004, x + (horiz ? len : 0), y + (horiz ? 0 : len), .004); }
    side.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)), new THREE.LineBasicMaterial({ color: 0x2a2a3c })));
    // Emblem: the Erdos mark, two robots shaking hands under a gold coin, in the coin's flowing gradient.
    const P = (x, y, z = .12) => new THREE.Vector3((x - 24) / 15, (24 - y) / 15, z);
    const tube = (curve, r) => side.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, r, 10, false), gradMat));
    const poly = (pts) => { const path = new THREE.CurvePath(); for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(P(...pts[i - 1]), P(...pts[i]))); return path; };
    const box = (x, y, w, h) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    tube(box(3, 15, 12, 10), .075); tube(box(33, 15, 12, 10), .075);
    tube(poly([[9, 15], [9, 11.4]]), .065); tube(poly([[39, 15], [39, 11.4]]), .065);
    // Two smiles: an inner one from the robots' inner bottom corners, a wider one from their outer corners.
    const smile = (x0, x1, y0, depth) => {
      const path = new THREE.CurvePath();
      path.add(new THREE.CubicBezierCurve3(P(x0, y0), P(x0 + 1.2, y0 + depth * .75), P(24 - (24 - x0) * .5, y0 + depth), P(24, y0 + depth)));
      path.add(new THREE.CubicBezierCurve3(P(24, y0 + depth), P(24 + (x1 - 24) * .5, y0 + depth), P(x1 - 1.2, y0 + depth * .75), P(x1, y0)));
      return path;
    };
    tube(smile(13, 35, 25, 9.5), .075); tube(smile(4.5, 43.5, 25, 17.5), .06);
    const dot = (x, y, r, color) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), new THREE.MeshBasicMaterial({ color, toneMapped: false })); m.position.copy(P(x, y, .16)); side.add(m); };
    dot(9, 10.4, .11, 0xffffff); dot(39, 10.4, .11, 0xffffff); dot(12, 20, .1, 0xffffff); dot(36, 20, .1, 0xffffff);
    const gold = new THREE.Mesh(new THREE.CylinderGeometry(.42, .42, .08, 40), new THREE.MeshBasicMaterial({ color: 0xffd166, toneMapped: false }));
    gold.rotation.x = Math.PI / 2; gold.position.copy(P(24, 13, .16)); side.add(gold);
    const goldRim = new THREE.Mesh(new THREE.TorusGeometry(.42, .03, 10, 48), new THREE.MeshBasicMaterial({ color: 0xffb65c, toneMapped: false })); goldRim.position.copy(P(24, 13, .2)); side.add(goldRim);
    const ink = new THREE.MeshBasicMaterial({ color: 0x0b0d16 });
    const s = new THREE.CatmullRomCurve3([[26.3, 10.7], [24, 9.6], [21.7, 11.1], [24, 13], [26.3, 14.9], [24, 16.4], [21.7, 15.3]].map(([x, y]) => P(x, y, .21)));
    side.add(new THREE.Mesh(new THREE.TubeGeometry(s, 48, .028, 8, false), ink));
    side.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(P(24, 8.4, .21), P(24, 17.6, .21)), 4, .022, 8, false), ink));
  }

  let scrollT = 0, time = 0, last = performance.now(), visible = true, mx = 0, my = 0, spin = 0;
  addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5; }, { passive: true });
  host.addEventListener('pointerdown', () => { spin += Math.PI * 2; });
  function resize() { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.position.z = w / h < .9 ? 13 : 9.5; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(host); resize();
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(host);
  let ry = -.6;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now; if (!visible || document.hidden) return;
    if (!reduced) time += dt;
    const target = -.55 + scrollT * 1.3 + mx * .9 + Math.sin(time * .6) * .12 + spin;
    ry += (target - ry) * Math.min(1, dt * 3.5);
    coin.rotation.set(-.12 + my * .5 + Math.sin(time * .8) * .04, ry, -.1);
    coin.position.y = Math.sin(time * 1.2) * .08;
    grad.offset.x = (time * .12) % 1;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  return { setScroll(t) { scrollT = t; } };
}
