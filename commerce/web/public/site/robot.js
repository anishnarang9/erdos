import * as THREE from './vendor/three.module.js';
// Original "solver agent" mascot (globe head + orbit ring, echoing the site's Earth). Its pose, face display and
// held object change with the active step. Purely illustrative: it carries no data and moves no money.

function gradientTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 4; const g = c.getContext('2d');
  const lg = g.createLinearGradient(0, 0, 256, 0);
  [[0, '#63f0ff'], [.3, '#7d8cff'], [.6, '#a86bff'], [.85, '#ff5fd2'], [1, '#63f0ff']].forEach(([o, col]) => lg.addColorStop(o, col));
  g.fillStyle = lg; g.fillRect(0, 0, 256, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; return t;
}

/** A tiny studio (soft boxes) baked to an environment map so glossy parts have something to reflect. */
function studioEnv(renderer) {
  const s = new THREE.Scene(); s.background = new THREE.Color(0x05050a);
  const box = (col, i, x, y, z, sx, sy) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(i), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m); };
  box(0xffffff, 6, 0, 8, 2, 10, 6); box(0x63f0ff, 5, -9, 2, 2, 5, 9); box(0xc04dff, 5, 9, 1, -2, 5, 9); box(0xff5fd2, 3, 0, -6, 6, 9, 3); box(0x7d8cff, 2, 0, 2, -10, 14, 8);
  const pm = new THREE.PMREMGenerator(renderer); const env = pm.fromScene(s, .04).texture; pm.dispose(); return env;
}

export function initRobot(host, { reduced = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0, 0); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene(); scene.environment = studioEnv(renderer);
  const camera = new THREE.PerspectiveCamera(28, 1, .1, 100); camera.position.set(0, 1.5, 14); camera.lookAt(0, 1.25, 0);
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 8, 6); scene.add(key);
  const rimC = new THREE.PointLight(0x4fe8ff, 60, 22); rimC.position.set(-5, 3, -2); scene.add(rimC);
  const rimM = new THREE.PointLight(0xd04dff, 60, 22); rimM.position.set(5, 1.5, -3); scene.add(rimM);

  const grad = gradientTexture();
  const shell = new THREE.MeshPhysicalMaterial({ color: 0xc9c5cf, roughness: .32, metalness: .1, clearcoat: 1, clearcoatRoughness: .18 });
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x15141d, roughness: .4, metalness: .6, clearcoat: .6 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x04040a, roughness: .04, metalness: .9, clearcoat: 1, envMapIntensity: 1.6 });
  const glow = (col) => new THREE.MeshBasicMaterial({ color: col, toneMapped: false });
  const gradMat = new THREE.MeshBasicMaterial({ map: grad, toneMapped: false });
  const M = (geo, mat, x = 0, y = 0, z = 0, parent) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); (parent ?? bot).add(m); return m; };

  const rig = new THREE.Group(); scene.add(rig);
  const bot = new THREE.Group(); rig.add(bot);

  // Plinth with two gradient rings
  M(new THREE.CylinderGeometry(2.1, 2.35, .4, 72), dark, 0, -1.35, 0, rig);
  const pr1 = M(new THREE.TorusGeometry(2.14, .03, 8, 160), gradMat, 0, -1.14, 0, rig); pr1.rotation.x = Math.PI / 2;
  const pr2 = M(new THREE.TorusGeometry(2.6, .012, 8, 160), new THREE.MeshBasicMaterial({ color: 0x3a3a52 }), 0, -1.5, 0, rig); pr2.rotation.x = Math.PI / 2;

  // Legs, hips, torso
  for (const x of [-.46, .46]) {
    M(new THREE.CapsuleGeometry(.24, .62, 10, 20), shell, x, -.42, 0);
    M(new THREE.SphereGeometry(.2, 20, 20), dark, x, -.02, 0);
    const foot = M(new THREE.CapsuleGeometry(.24, .34, 8, 16), dark, x, -.98, .12); foot.rotation.x = Math.PI / 2;
    M(new THREE.TorusGeometry(.25, .018, 8, 40), gradMat, x, -.86, .12).rotation.x = Math.PI / 2;
  }
  const torso = M(new THREE.CapsuleGeometry(.92, .62, 16, 40), shell, 0, .82, 0); torso.scale.set(1, 1, .82);
  M(new THREE.TorusGeometry(.78, .05, 10, 64), dark, 0, .2, 0).rotation.x = Math.PI / 2;
  const chestPlate = M(new THREE.CylinderGeometry(.42, .42, .08, 6), glass, 0, .98, .73); chestPlate.rotation.x = Math.PI / 2;
  const chestRing = M(new THREE.TorusGeometry(.3, .035, 6, 6), gradMat, 0, .98, .79);
  const core = M(new THREE.SphereGeometry(.1, 20, 20), glow(0x63f0ff), 0, .98, .8);
  const leds = [0x63f0ff, 0xa86bff, 0xff5fd2].map((c, i) => M(new THREE.SphereGeometry(.055, 12, 12), glow(c), -.17 + i * .17, .42, .72));
  M(new THREE.CylinderGeometry(.24, .34, .34, 28), dark, 0, 1.92, 0);
  M(new THREE.TorusGeometry(.3, .03, 8, 48), gradMat, 0, 1.8, 0).rotation.x = Math.PI / 2;

  // Arms: shoulder → upper → elbow → forearm → hand
  const arms = [-1, 1].map((side) => {
    const shoulder = new THREE.Group(); shoulder.position.set(side * 1.08, 1.32, 0); bot.add(shoulder);
    M(new THREE.SphereGeometry(.27, 24, 24), dark, 0, 0, 0, shoulder);
    M(new THREE.CapsuleGeometry(.17, .42, 8, 16), shell, 0, -.42, 0, shoulder);
    const elbow = new THREE.Group(); elbow.position.y = -.78; shoulder.add(elbow);
    M(new THREE.SphereGeometry(.18, 20, 20), dark, 0, 0, 0, elbow);
    M(new THREE.CapsuleGeometry(.15, .36, 8, 16), shell, 0, -.36, 0, elbow);
    const hand = M(new THREE.SphereGeometry(.23, 24, 24), dark, 0, -.74, 0, elbow);
    M(new THREE.TorusGeometry(.17, .02, 8, 32), gradMat, 0, -.56, 0, elbow).rotation.x = Math.PI / 2;
    return { shoulder, elbow, hand };
  });

  // Head: glass globe, lit limb, lattice, face display, ear pods, orbit ring, antenna
  const head = new THREE.Group(); head.position.y = 2.72; bot.add(head);
  M(new THREE.SphereGeometry(1.1, 72, 56), glass, 0, 0, 0, head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(1.125, 64, 48), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec3 n;varying vec3 v;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'varying vec3 n;varying vec3 v;void main(){float r=1.-abs(dot(n,v));vec3 c=mix(vec3(.7,.4,1.),vec3(.4,.95,1.),smoothstep(-.5,.5,n.y));gl_FragColor=vec4(c,pow(r,3.2)*1.7);}',
  })));
  const lattice = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.115, 2)), new THREE.LineBasicMaterial({ color: 0x7d8cff, transparent: true, opacity: .13, depthWrite: false })); head.add(lattice);
  const eyes = [-.34, .34].map((x) => { const e = M(new THREE.CapsuleGeometry(.105, .2, 8, 16), glow(0xffffff), x, .06, 1.03, head); e.rotation.x = -.06; return e; });
  const mouth = M(new THREE.TorusGeometry(.16, .022, 8, 24, Math.PI), glow(0xffffff), 0, -.3, 1.02, head); mouth.rotation.z = Math.PI;
  for (const x of [-1.12, 1.12]) { M(new THREE.CylinderGeometry(.2, .2, .16, 24), dark, x, 0, 0, head).rotation.z = Math.PI / 2; M(new THREE.TorusGeometry(.2, .02, 8, 32), gradMat, x * 1.07, 0, 0, head).rotation.y = Math.PI / 2; }
  const ringPivot = new THREE.Group(); ringPivot.rotation.set(1.22, 0, .32); head.add(ringPivot);
  const ring = M(new THREE.TorusGeometry(1.52, .05, 14, 200), gradMat, 0, 0, 0, ringPivot);
  const ringThin = M(new THREE.TorusGeometry(1.72, .008, 6, 200), new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: .6 }), 0, 0, 0, ringPivot);
  const moon = M(new THREE.SphereGeometry(.1, 20, 20), glow(0xffffff), 0, 0, 0, ringPivot);
  const moon2 = M(new THREE.SphereGeometry(.055, 16, 16), glow(0xff5fd2), 0, 0, 0, ringPivot);
  M(new THREE.CylinderGeometry(.028, .028, .5, 8), dark, 0, 1.32, 0, head);
  const spark = M(new THREE.SphereGeometry(.1, 20, 20), glow(0x63f0ff), 0, 1.62, 0, head);

  // Held objects, one per step, floating over the right hand.
  const props = new THREE.Group(); props.position.set(1.75, 1.15, 1.05); bot.add(props);
  const P = () => { const g = new THREE.Group(); g.scale.setScalar(.001); props.add(g); return g; };
  const card = (parent, w, h, lines, x = 0, y = 0, rot = 0) => {
    const g = new THREE.Group(); g.position.set(x, y, 0); g.rotation.z = rot; parent.add(g);
    M(new THREE.BoxGeometry(w, h, .05), new THREE.MeshPhysicalMaterial({ color: 0x1a1926, roughness: .3, metalness: .5, clearcoat: 1 }), 0, 0, 0, g);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, .05)), new THREE.LineBasicMaterial({ color: 0x63f0ff })); g.add(edge);
    for (let i = 0; i < lines; i++) M(new THREE.BoxGeometry(w * (.7 - (i % 3) * .14), .045, .012), glow(i % 2 ? 0xa86bff : 0xe8e6f0), -w * .08 - (i % 3) * w * .07, h * .32 - i * .15, .035, g);
    return g;
  };
  const p0 = P(); card(p0, .95, 1.25, 6);                                              // 01 draft: the brief
  const p1 = P(); const hex = M(new THREE.CylinderGeometry(.55, .55, .22, 6), glass, 0, 0, 0, p1); hex.rotation.x = Math.PI / 2; // 02 compile: image id
  M(new THREE.TorusGeometry(.56, .035, 6, 6), gradMat, 0, 0, .12, p1).rotation.z = Math.PI / 6; M(new THREE.TorusGeometry(.26, .03, 6, 6), glow(0x63f0ff), 0, 0, .13, p1).rotation.z = Math.PI / 6;
  const coinOf = (parent) => { const g = new THREE.Group(); parent.add(g); const b = M(new THREE.CylinderGeometry(.55, .55, .1, 64), dark, 0, 0, 0, g); b.rotation.x = Math.PI / 2; M(new THREE.TorusGeometry(.55, .03, 10, 96), gradMat, 0, 0, 0, g); M(new THREE.TorusGeometry(.3, .028, 8, 48), glow(0x63f0ff), 0, 0, .06, g); M(new THREE.BoxGeometry(.05, .42, .02), glow(0x63f0ff), 0, 0, .06, g); return g; };
  const p2 = P(); coinOf(p2); const lock = M(new THREE.TorusGeometry(.2, .04, 8, 32, Math.PI), glow(0xffb65c), 0, .68, 0, p2); M(new THREE.BoxGeometry(.52, .34, .12), glow(0xffb65c), 0, .52, 0, p2).scale.set(1, 1, 1); lock.position.y = .7; // 03 fund: locked coin
  const p3 = P(); const chipRings = [0, 1, 2].map((i) => { const t = M(new THREE.TorusGeometry(.34 + i * .15, .022, 8, 80), i === 1 ? gradMat : glow(i ? 0xa86bff : 0x63f0ff), 0, 0, 0, p3); t.rotation.set(i * .9, i * .6, 0); return t; }); M(new THREE.IcosahedronGeometry(.2, 0), glow(0xffffff), 0, 0, 0, p3); // 04 prove
  const p4 = P(); coinOf(p4); const keyG = new THREE.Group(); keyG.position.set(.75, .45, 0); keyG.rotation.z = -.6; p4.add(keyG); M(new THREE.TorusGeometry(.14, .04, 8, 32), glow(0x6bffd8), 0, 0, 0, keyG); M(new THREE.BoxGeometry(.05, .46, .05), glow(0x6bffd8), 0, -.36, 0, keyG); M(new THREE.BoxGeometry(.16, .05, .05), glow(0x6bffd8), .08, -.5, 0, keyG); // 05 settle: coin + key
  const p5 = P(); card(p5, .78, 1.0, 4, -.3, .05, .16); card(p5, .78, 1.0, 4, .32, -.08, -.12);          // 06 recover: two files
  const propList = [p0, p1, p2, p3, p4, p5];

  // Dust
  const pts = []; for (let i = 0; i < 220; i++) { const a = Math.random() * Math.PI * 2, r = 2.8 + Math.random() * 2.4; pts.push(Math.cos(a) * r, -1.2 + Math.random() * 6, Math.sin(a) * r); }
  const dust = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), new THREE.PointsMaterial({ color: 0x9aa4ff, size: .04, transparent: true, opacity: .7, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(dust);

  // Poses per step: [bodyYaw, headYaw, headPitch, L shoulder z, L elbow z, R shoulder z, R shoulder x, R elbow z, eyeScaleY, eyeColor]
  const POSE = [
    [-.35, .25, .12, -.25, -.2, .55, -.9, .9, 1, 0xffffff],      // reading the brief
    [-.15, -.1, .05, -.35, -.9, .5, -.8, 1.0, .8, 0xbfe9ff],     // compiling
    [.1, 0, -.02, -.3, -.3, .5, -.9, .8, 1, 0xffd9a0],           // funded, locked
    [.2, .1, .14, -.9, -1.5, .6, -1.0, 1.1, .4, 0xd7b8ff],       // proving (squint)
    [.05, 0, -.1, -2.6, -.3, 1.2, -1.2, .5, 1.15, 0x7dfff0],     // settled (cheer)
    [-.2, -.2, -.05, -2.4, -.5, 2.3, -.2, .4, 1.1, 0x7dfff0],    // files recovered
  ];
  const LABEL = ['READING THE BRIEF', 'COMPILING THE CHECKER', 'ESCROW FUNDED', 'PROVING', 'PAID · KEY RELEASED', 'FILES RECOVERED'];
  let step = 0, time = 0, last = performance.now(), visible = true, mx = 0, my = 0, bounce = 0;
  const eyeCol = new THREE.Color(0xffffff), want = new THREE.Color();
  addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5; }, { passive: true });
  function resize() { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.position.z = w / h < .8 ? 19 : 14; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(host); resize();
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(host);
  const L = THREE.MathUtils.lerp;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!visible || document.hidden) return;
    if (!reduced) time += dt;
    const k = Math.min(1, dt * 5), p = POSE[step];
    bounce = Math.max(0, bounce - dt * 2.2);
    rig.rotation.y = L(rig.rotation.y, p[0] + mx * .5, k);
    bot.position.y = Math.sin(time * 1.5) * .07 + Math.sin(bounce * Math.PI) * .35;
    bot.rotation.z = Math.sin(time * .9) * .015;
    head.rotation.y = L(head.rotation.y, p[1] + mx * .7, k); head.rotation.x = L(head.rotation.x, p[2] + my * .35, k);
    const wave = step === 4 ? Math.sin(time * 9) * .25 : 0;
    arms[0].shoulder.rotation.z = L(arms[0].shoulder.rotation.z, p[3] + wave, k); arms[0].elbow.rotation.z = L(arms[0].elbow.rotation.z, p[4], k);
    arms[1].shoulder.rotation.z = L(arms[1].shoulder.rotation.z, p[5], k); arms[1].shoulder.rotation.x = L(arms[1].shoulder.rotation.x, p[6], k); arms[1].elbow.rotation.x = L(arms[1].elbow.rotation.x, -p[7], k);
    // Held object: only the active one is visible; each has its own motion.
    propList.forEach((g, i) => { g.scale.setScalar(L(g.scale.x, i === step ? 1 : .001, Math.min(1, dt * 7))); g.visible = g.scale.x > .01; });
    props.position.y = 1.15 + Math.sin(time * 2) * .08;
    p0.rotation.y = Math.sin(time * .8) * .35 - .3; p1.rotation.y = time * 1.2; p2.rotation.y = Math.sin(time) * .5;
    chipRings.forEach((t, i) => { t.rotation.x += dt * (2.2 + i); t.rotation.y += dt * (1.4 + i * .7); });
    p4.rotation.y = time * 2.2; p5.rotation.y = Math.sin(time * 1.1) * .4;
    // Head ring, moons, gradient flow
    const fast = step === 3 ? 3.2 : 1;
    ring.rotation.z += dt * .5 * fast; ringThin.rotation.z -= dt * .2 * fast;
    const a = time * 1.1 * fast; moon.position.set(Math.cos(a) * 1.52, Math.sin(a) * 1.52, 0); moon2.position.set(Math.cos(-a * .7) * 1.72, Math.sin(-a * .7) * 1.72, 0);
    grad.offset.x = (time * .1) % 1; lattice.rotation.y = time * .15;
    // Face
    const blink = Math.sin(time * 2.1) > .988 ? .12 : 1;
    eyes.forEach((e) => (e.scale.y = L(e.scale.y, p[8] * blink, Math.min(1, dt * 16))));
    want.set(p[9]); eyeCol.lerp(want, Math.min(1, dt * 4)); eyes.forEach((e) => e.material.color.copy(eyeCol)); mouth.material.color.copy(eyeCol);
    mouth.scale.setScalar(L(mouth.scale.x, step >= 4 ? 1.25 : step === 3 ? .5 : .85, k));
    spark.material.color.copy(eyeCol); spark.scale.setScalar(1 + Math.sin(time * (step === 3 ? 14 : 4)) * .3);
    core.material.color.copy(eyeCol); core.scale.setScalar(1 + Math.sin(time * 3) * .2); chestRing.rotation.z += dt * (step === 3 ? 4 : .5);
    leds.forEach((l, i) => l.scale.setScalar(.7 + .6 * Math.max(0, Math.sin(time * (step === 3 ? 12 : 4) - i * 1.2))));
    pr1.rotation.z = time * .2; dust.rotation.y += dt * .04;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  return {
    setStep(i) { i = Math.max(0, Math.min(5, i)); if (i !== step) { step = i; bounce = 1; } return LABEL[step]; },
    label: () => LABEL[step],
  };
}
