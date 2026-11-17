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
    // Emblem: planet ring, tilted orbit, two eyes (the site mark), in a flowing gradient
    const planet = new THREE.Mesh(new THREE.TorusGeometry(1.05, .13, 16, 96), gradMat); planet.position.z = .1; side.add(planet);
    const planetIn = new THREE.Mesh(new THREE.TorusGeometry(.78, .035, 12, 96), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: .8 })); planetIn.position.z = .1; side.add(planetIn);
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.75, .075, 12, 160), gradMat); orbit.scale.y = .34; orbit.rotation.z = -.32; orbit.position.z = .14; side.add(orbit);
    for (const x of [-.3, .3]) { const e = new THREE.Mesh(new THREE.CapsuleGeometry(.1, .16, 8, 16), new THREE.MeshBasicMaterial({ color: x < 0 ? 0xffffff : 0xffb0d8, toneMapped: false })); e.position.set(x, .02, .12); side.add(e); }
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
