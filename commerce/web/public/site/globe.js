import * as THREE from './vendor/three.module.js';
// Luminous orbital Earth (direction: Dribbble "3D globe | Website header"; original WebGL, no footage embedded).
// The network is illustrative: it does not show measured solver geography or live transaction traffic.

export function initGlobe(host, { reduced = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  camera.position.set(0, 0, 11);
  const R = 3.6;
  const world = new THREE.Group(); scene.add(world);
  const spin = new THREE.Group(); world.add(spin); spin.rotation.set(0.32, 3.0, -0.18);

  let seed = 1874; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const loader = new THREE.TextureLoader();
  let dirty = true, texturesLoaded = 0;
  const tex = (p) => loader.load(p, () => { texturesLoaded++; dirty = true; });
  const day = tex('./vendor/earth-day.jpg'), night = tex('./vendor/earth-night.png');

  const vert = `varying vec2 vUv;varying vec3 vN;varying vec3 vV;void main(){vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`;

  // Earth: deep navy oceans, faint land, magenta/cyan city lights, a crisp bright limb.
  const earth = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), new THREE.ShaderMaterial({
    uniforms: { dayMap: { value: day }, nightMap: { value: night }, pulse: { value: new THREE.Color(0, 0, 0) } },
    vertexShader: vert,
    fragmentShader: `uniform sampler2D dayMap;uniform sampler2D nightMap;uniform vec3 pulse;varying vec2 vUv;varying vec3 vN;varying vec3 vV;
    void main(){vec3 n=normalize(vN);float lum=dot(texture2D(dayMap,vUv).rgb,vec3(.299,.587,.114));
    float light=.3+.7*max(dot(n,normalize(vec3(-.5,.7,1.))),0.);
    vec3 col=mix(vec3(.0015,.003,.012),vec3(.006,.012,.04),smoothstep(.12,.5,lum))*light;
    float city=dot(texture2D(nightMap,vUv).rgb,vec3(.3,.5,.2));
    vec3 cityCol=mix(vec3(.25,.85,1.),vec3(1.,.2,.78),smoothstep(.3,.7,vUv.y+.1*sin(vUv.x*30.)));
    col+=pow(city,1.5)*cityCol*2.4;
    float f=1.-max(dot(n,normalize(vV)),0.);
    col+=mix(vec3(.45,.2,1.),vec3(.35,.95,1.),smoothstep(-.4,.5,n.y))*pow(f,4.5)*.9;
    col+=pulse*pow(f,1.6);
    gl_FragColor=vec4(col,1.);
    #include <colorspace_fragment>
    }`,
  }));
  spin.add(earth);

  // Thin hot limb + wide soft atmosphere (additive).
  const limb = new THREE.Mesh(new THREE.SphereGeometry(R * 1.012, 96, 64), new THREE.ShaderMaterial({
    vertexShader: vert, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    fragmentShader: `varying vec3 vN;varying vec3 vV;void main(){float r=1.-abs(dot(normalize(vN),normalize(vV)));
    vec3 c=mix(vec3(.55,.3,1.),vec3(.6,1.,1.),smoothstep(-.6,.3,vN.y));gl_FragColor=vec4(c,pow(r,5.)*1.5);}`,
  }));
  world.add(limb);
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.2, 96, 64), new THREE.ShaderMaterial({
    vertexShader: vert, transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    fragmentShader: `varying vec3 vN;varying vec3 vV;void main(){float f=abs(dot(normalize(vN),normalize(vV)));
    float i=pow(f,3.2)*.95;vec3 c=mix(vec3(.42,.12,.95),vec3(.1,.85,1.),smoothstep(-.5,.5,vN.y));gl_FragColor=vec4(c,i);}`,
  }));
  world.add(atmo);

  // Canvas sprites: soft glow, hexagon dot.
  function canvasTex(draw) { const c = document.createElement('canvas'); c.width = c.height = 128; draw(c.getContext('2d')); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
  const glowTex = canvasTex((g) => { const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.25, 'rgba(255,255,255,.45)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); });
  const hexTex = canvasTex((g) => { g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i + Math.PI / 6; g[i ? 'lineTo' : 'moveTo'](64 + 40 * Math.cos(a), 64 + 40 * Math.sin(a)); } g.closePath(); g.fillStyle = 'rgba(255,255,255,.35)'; g.fill(); g.lineWidth = 9; g.strokeStyle = 'rgba(255,255,255,1)'; g.stroke(); });

  // Halo behind the globe.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x4fb8ff, transparent: true, opacity: .35, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(R * 3.6); halo.position.z = -1.5; world.add(halo);

  // Surface lattice and route arcs with packet trails.
  const ico = new THREE.IcosahedronGeometry(R * 1.015, 4), pos = ico.attributes.position, nodes = [], seen = new Map(), faces = [];
  for (let i = 0; i < pos.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pos, i), k = [v.x, v.y, v.z].map((n) => n.toFixed(4)).join(); if (!seen.has(k)) { seen.set(k, nodes.length); nodes.push(v); } faces.push(seen.get(k)); }
  const edges = new Set(), seg = [];
  for (let i = 0; i < faces.length; i += 3) for (const [a, b] of [[faces[i], faces[i + 1]], [faces[i + 1], faces[i + 2]], [faces[i + 2], faces[i]]]) { const k = a < b ? `${a},${b}` : `${b},${a}`; if (!edges.has(k)) { edges.add(k); seg.push(...nodes[a].toArray(), ...nodes[b].toArray()); } }
  const latGeo = new THREE.BufferGeometry(); latGeo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  spin.add(new THREE.LineSegments(latGeo, new THREE.LineBasicMaterial({ color: 0x6f86ff, transparent: true, opacity: .1, depthWrite: false })));
  const nodeGeo = new THREE.BufferGeometry().setFromPoints(nodes.filter(() => rnd() < .45));
  spin.add(new THREE.Points(nodeGeo, new THREE.PointsMaterial({ color: 0xc9a2ff, map: glowTex, size: .12, transparent: true, opacity: .8, depthWrite: false, blending: THREE.AdditiveBlending })));

  // Dynamic arcs: each one launches, travels, lands with a ripple, fades and respawns somewhere else.
  const ARCS = 26, SEG = 64, arcs = [];
  const headPos = new Float32Array(ARCS * 3), headCol = new Float32Array(ARCS * 3), headSize = new Float32Array(ARCS);
  const cA = new THREE.Color(0x63f0ff), cB = new THREE.Color(0xff5fd2), cC = new THREE.Color(0xa86bff);
  const rippleGeo = new THREE.RingGeometry(.92, 1, 48);
  function respawn(arc, now) {
    const s = nodes[Math.floor(rnd() * nodes.length)].clone().normalize(); let e = nodes[Math.floor(rnd() * nodes.length)].clone().normalize();
    let ang = Math.acos(THREE.MathUtils.clamp(s.dot(e), -.999, .999));
    if (ang < .35 || ang > 2.4) { e = s.clone().applyAxisAngle(new THREE.Vector3(rnd() - .5, rnd() - .5, rnd() - .5).normalize(), .6 + rnd() * 1.1).normalize(); ang = Math.acos(THREE.MathUtils.clamp(s.dot(e), -.999, .999)); }
    const arr = arc.line.geometry.attributes.position.array;
    for (let j = 0; j <= SEG; j++) { const t = j / SEG; const p = s.clone().multiplyScalar(Math.sin((1 - t) * ang)).add(e.clone().multiplyScalar(Math.sin(t * ang))).divideScalar(Math.sin(ang)).normalize().multiplyScalar(R * 1.02 + Math.sin(t * Math.PI) * (.12 + ang * .5)); p.toArray(arr, j * 3); }
    arc.line.geometry.attributes.position.needsUpdate = true;
    arc.born = now + rnd() * 2.5; arc.dur = 3.2 + rnd() * 3.4; arc.landed = false;
    arc.color = [cA, cB, cC][Math.floor(rnd() * 3)]; arc.line.material.color.copy(arc.color);
    arc.end.copy(e).multiplyScalar(R * 1.022); arc.ripple.position.copy(arc.end); arc.ripple.lookAt(e.clone().multiplyScalar(R * 3)); arc.ripple.material.color.copy(arc.color);
  }
  for (let i = 0; i < ARCS; i++) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ transparent: true, opacity: .9, depthWrite: false, blending: THREE.AdditiveBlending })); line.frustumCulled = false;
    const ripple = new THREE.Mesh(rippleGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    spin.add(line); spin.add(ripple);
    const arc = { line, ripple, end: new THREE.Vector3(), born: 0, dur: 4, landed: false, color: cA, rippleT: 9 }; arcs.push(arc); respawn(arc, -rnd() * 4);
  }
  const headGeo = new THREE.BufferGeometry(); headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3)); headGeo.setAttribute('color', new THREE.BufferAttribute(headCol, 3));
  const heads = new THREE.Points(headGeo, new THREE.PointsMaterial({ map: glowTex, vertexColors: true, size: .34, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); heads.frustumCulled = false; spin.add(heads);
  const tint = new THREE.Color();

  // Orbital system: one dominant dotted ring + two fine tilted rings with satellites.
  const orbit = new THREE.Group(); world.add(orbit);
  const bands = [], ringDots = [];
  const ringSpec = [
    { r: 1.32, tilt: [1.32, .08, .22], color: 0x8fe9ff, dots: 360, dotSize: .05, line: .14 },
    { r: 1.5, tilt: [1.05, -.35, -.5], color: 0xa875ff, dots: 220, dotSize: .035, line: .22 },
    { r: 1.7, tilt: [1.6, .45, .9], color: 0x5fd8ff, dots: 160, dotSize: .03, line: .12 },
  ];
  ringSpec.forEach((s, i) => {
    const plane = new THREE.Group(); plane.rotation.set(...s.tilt); orbit.add(plane);
    const rr = R * s.r;
    const circ = Array.from({ length: 257 }, (_, j) => new THREE.Vector3(Math.cos(j / 256 * Math.PI * 2) * rr, Math.sin(j / 256 * Math.PI * 2) * rr, 0));
    plane.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circ), new THREE.LineBasicMaterial({ color: s.color, transparent: true, opacity: s.line, depthWrite: false, blending: THREE.AdditiveBlending })));
    const dots = Array.from({ length: s.dots }, (_, j) => new THREE.Vector3(Math.cos(j / s.dots * Math.PI * 2) * rr, Math.sin(j / s.dots * Math.PI * 2) * rr, 0));
    const dotPts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(dots), new THREE.PointsMaterial({ color: s.color, size: s.dotSize, transparent: true, opacity: .75, depthWrite: false, blending: THREE.AdditiveBlending })); plane.add(dotPts); ringDots.push(dotPts);
    const sweep = new THREE.Group(); plane.add(sweep);
    const arc = Array.from({ length: 41 }, (_, j) => new THREE.Vector3(Math.cos(j / 40 * .5) * rr, Math.sin(j / 40 * .5) * rr, 0));
    sweep.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .75, depthWrite: false, blending: THREE.AdditiveBlending })));
    const sat = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: s.color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); sat.scale.setScalar(.45); sat.position.set(rr, 0, 0); sweep.add(sat);
    bands.push({ sweep, speed: (i % 2 ? -1 : 1) * (.09 + i * .02), phase: i * 2.2 });
  });

  // Hexagon particle field and radial light streaks.
  const field = new THREE.Group(); world.add(field);
  const hp = [], hc = [], streak = [], streakCol = [];
  const palette = [new THREE.Color(0x63f0ff), new THREE.Color(0xa86bff), new THREE.Color(0xff5fd2), new THREE.Color(0x7d8cff)];
  for (let i = 0; i < 520; i++) {
    const th = rnd() * Math.PI * 2, z = rnd() * 2 - 1, rad = Math.sqrt(1 - z * z);
    const dir = new THREE.Vector3(rad * Math.cos(th), z, rad * Math.sin(th));
    const d = R * (1.08 + Math.pow(rnd(), 1.6) * 1.3);
    hp.push(...dir.clone().multiplyScalar(d).toArray());
    const c = palette[i % palette.length]; hc.push(c.r, c.g, c.b);
    if (i % 6 === 0) { const a = dir.clone().multiplyScalar(R * 1.03), b = dir.clone().multiplyScalar(d + .4 + rnd() * .8); streak.push(...a.toArray(), ...b.toArray()); streakCol.push(c.r, c.g, c.b, 0, 0, 0); }
  }
  const hGeo = new THREE.BufferGeometry(); hGeo.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3)); hGeo.setAttribute('color', new THREE.Float32BufferAttribute(hc, 3));
  field.add(new THREE.Points(hGeo, new THREE.PointsMaterial({ map: hexTex, vertexColors: true, size: .1, transparent: true, opacity: .9, depthWrite: false, blending: THREE.AdditiveBlending })));
  const sGeo = new THREE.BufferGeometry(); sGeo.setAttribute('position', new THREE.Float32BufferAttribute(streak, 3)); sGeo.setAttribute('color', new THREE.Float32BufferAttribute(streakCol, 3));
  field.add(new THREE.LineSegments(sGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .8, depthWrite: false, blending: THREE.AdditiveBlending })));

  // Distant stars.
  const st = []; for (let i = 0; i < 900; i++) st.push((rnd() - .5) * 80, (rnd() - .5) * 50, -20 - rnd() * 30);
  const stGeo = new THREE.BufferGeometry(); stGeo.setAttribute('position', new THREE.Float32BufferAttribute(st, 3));
  scene.add(new THREE.Points(stGeo, new THREE.PointsMaterial({ color: 0x7c86c8, size: .05, transparent: true, opacity: .5, depthWrite: false })));

  // State feedback from the (simulated) experiment: cyan pulse on pass, magenta-red on fail.
  let pulseColor = new THREE.Color(0, 0, 0), pulseAmt = 0, tintMix = 0;
  const pass = new THREE.Color(0x52ffd9), fail = new THREE.Color(0xff3d6e);
  function setOutcome(kind) { if (kind === 'released') { pulseColor.copy(pass); pulseAmt = 1.6; } else if (kind === 'failed') { pulseColor.copy(fail); pulseAmt = 1.6; } else { pulseAmt = 0; } dirty = true; }

  let paused = reduced, visible = true, time = 0, last = performance.now(), mx = 0, my = 0, vx = 0, vy = 0, drag = false, lx = 0, ly = 0, yaw = 0, pitch = 0, yawVel = 0, pitchVel = 0;
  let layout = { x: 0, y: 0, s: 1 };
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    world.position.set(layout.x, layout.y, 0); world.scale.setScalar(layout.s * (w < 760 ? .62 : 1));
    dirty = true;
  }
  new ResizeObserver(resize).observe(host); resize();
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; dirty = true; }).observe(host);
  const el = renderer.domElement;
  el.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' || reduced) return; const b = el.getBoundingClientRect(); mx = ((e.clientX - b.left) / b.width - .5) * .16; my = ((e.clientY - b.top) / b.height - .5) * .08; if (drag) { const dx = (e.clientX - lx) * .005, dy = (e.clientY - ly) * .004; yaw += dx; pitch = THREE.MathUtils.clamp(pitch + dy, -.6, .6); yawVel = dx * 40; pitchVel = dy * 40; lx = e.clientX; ly = e.clientY; dirty = true; } });
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') return; drag = true; lx = e.clientX; ly = e.clientY; yawVel = pitchVel = 0; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
  el.style.cursor = 'grab'; el.addEventListener('pointerup', () => { drag = false; el.style.cursor = 'grab'; }); el.addEventListener('pointercancel', () => (drag = false));

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!visible || document.hidden) return;
    if (!paused) { time += dt; dirty = true; }
    if (!dirty) return;
    vx += (mx - vx) * Math.min(1, dt * 3); vy += (my - vy) * Math.min(1, dt * 3);
    spin.rotation.y = 3.0 + time * .03 + yaw;
    world.rotation.set(vy, vx, 0);
    orbit.rotation.y = time * .015; field.rotation.y = time * .01; field.rotation.x = Math.sin(time * .05) * .05;
    bands.forEach((b) => (b.sweep.rotation.z = b.phase + time * b.speed));
    halo.material.opacity = .3 + Math.sin(time * .8) * .05 + pulseAmt * .12;
    pulseAmt = Math.max(0, pulseAmt - dt * .9);
    earth.material.uniforms.pulse.value.copy(pulseColor).multiplyScalar(pulseAmt);
    tintMix += ((pulseAmt > .05 ? .75 : 0) - tintMix) * Math.min(1, dt * 4);
    arcs.forEach((arc, i) => {
      let u = (time - arc.born) / arc.dur;
      if (u > 1.25) { respawn(arc, time); u = -1; }
      const head = THREE.MathUtils.clamp(u / .55, 0, 1), tail = THREE.MathUtils.clamp((u - .45) / .55, 0, 1);
      const a0 = Math.floor(tail * SEG), a1 = Math.floor(head * SEG);
      arc.line.geometry.setDrawRange(a0, Math.max(0, a1 - a0 + 1)); arc.line.visible = u > 0 && a1 > a0;
      tint.copy(arc.color).lerp(pulseColor, tintMix); arc.line.material.color.copy(tint);
      const arr = arc.line.geometry.attributes.position.array, h = Math.min(SEG, a1) * 3;
      headPos[i * 3] = arr[h]; headPos[i * 3 + 1] = arr[h + 1]; headPos[i * 3 + 2] = arr[h + 2];
      const on = u > 0 && head < 1 ? 1 : 0; headCol[i * 3] = tint.r * on; headCol[i * 3 + 1] = tint.g * on; headCol[i * 3 + 2] = tint.b * on;
      if (head >= 1 && !arc.landed) { arc.landed = true; arc.rippleT = 0; }
      arc.rippleT += dt; const rt = arc.rippleT / 1.4;
      arc.ripple.visible = rt < 1; if (rt < 1) { arc.ripple.scale.setScalar(.05 + rt * .55); arc.ripple.material.opacity = (1 - rt) * .9; }
    });
    headGeo.attributes.position.needsUpdate = true; headGeo.attributes.color.needsUpdate = true;
    ringDots.forEach((d, i) => (d.rotation.z = time * (i % 2 ? -.05 : .04)));
    if (!drag) { yaw += yawVel * dt; pitch = THREE.MathUtils.clamp(pitch + pitchVel * dt, -.6, .6); yawVel *= Math.pow(.2, dt); pitchVel *= Math.pow(.2, dt); }
    spin.rotation.x = .32 + pitch;
    renderer.render(scene, camera);
    dirty = paused && pulseAmt > 0;
  }
  requestAnimationFrame(frame);
  el.addEventListener('webglcontextlost', (e) => e.preventDefault());

  return {
    setPaused(p) { paused = p; dirty = true; },
    isPaused: () => paused,
    setLayout(l) { layout = { ...layout, ...l }; resize(); },
    setOutcome,
    diagnostics: () => ({ texturesLoaded, arcs: arcs.length, rings: bands.length, drawCalls: renderer.info.render.calls, time, paused }),
  };
}
