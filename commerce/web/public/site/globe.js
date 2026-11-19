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

  // A loose spiral occupies the open sky above the headline.
  const spiralPositions = [], spiralColors = [];
  const starPalette = [0x98d9ff, 0xb1a4ff, 0xe0f6ff].map(hex => new THREE.Color(hex));
  for (let i = 0; i < 420; i++) {
    const radius = Math.sqrt(rnd()) * 6.5;
    const angle = (i % 3) * Math.PI * 2 / 3 + radius * .48 + (rnd() - .5) * 1.45;
    spiralPositions.push(radius * Math.cos(angle), radius * Math.sin(angle), -rnd());
    const color = starPalette[i % starPalette.length];
    spiralColors.push(color.r, color.g, color.b);
  }
  const spiralGeometry = new THREE.BufferGeometry();
  spiralGeometry.setAttribute('position', new THREE.Float32BufferAttribute(spiralPositions, 3));
  spiralGeometry.setAttribute('color', new THREE.Float32BufferAttribute(spiralColors, 3));
  const spiral = new THREE.Points(spiralGeometry, new THREE.PointsMaterial({
    map: glowTex, vertexColors: true, size: .26, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const spiralPlane = new THREE.Group();
  spiralPlane.rotation.set(.82, -.12, .24);
  spiralPlane.add(spiral);
  scene.add(spiralPlane);

  // Secondary planets sit between the star spiral and Earth.
  const planetSphere = new THREE.SphereGeometry(1, 48, 32);
  const planets = [
    { name: 'Saturn', radius: .55, depth: -5, dark: 0x734a47, light: 0xf8ce9b, bands: 18, tilt: -.31, speed: .10, x: -.36, y: .40, mobileX: -.34, mobileY: .40 },
    { name: 'Sun', radius: 1.5, depth: -24, sun: true, tilt: -.2, speed: .03, x: -.12, y: .40, mobileX: .23, mobileY: .41 },
    { name: 'Mars', radius: .2, depth: -7, dark: 0x5a2014, light: 0xe0703f, bands: 0, cap: 1, tilt: -.15, speed: .085, x: .42, y: -.17, mobileX: .42, mobileY: .005 },
  ];
  const rings = {
    Saturn: { color: 0xf2c498, tilt: 1.23, bands: [[1.27, 1.52, .55], [1.57, 1.85, .38], [1.9, 1.99, .24]] },
  };
  const sunTime = { value: 0 };
  const sunMaterial = new THREE.ShaderMaterial({
    uniforms: { t: sunTime },
    vertexShader: `varying vec3 surface; varying vec3 facing;
      void main() { surface = normal; facing = normalMatrix * normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform float t; varying vec3 surface, facing;
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float n3(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z); }
      void main() {
        vec3 p = normalize(surface), n = normalize(facing);
        float g = n3(p * 9. + t * .35) * .55 + n3(p * 23. - t * .6) * .3 + n3(p * 51. + t) * .15;
        float spots = smoothstep(.72, .8, n3(p * 4. + vec3(0., t * .05, 0.)));
        vec3 col = mix(vec3(.95, .3, .02), vec3(1., .72, .22), smoothstep(.25, .85, g));
        col = mix(col, vec3(.55, .14, .02), spots * .55);
        float limb = pow(max(n.z, 0.), .45);
        col *= .55 + .65 * limb;
        col += vec3(1., .55, .15) * pow(1. - max(n.z, 0.), 2.5) * .9;
        gl_FragColor = vec4(col * .95, 1.);
        #include <colorspace_fragment>
      }`,
  });
  // Soft corona sprite.
  const coronaCanvas = document.createElement('canvas'); coronaCanvas.width = coronaCanvas.height = 256;
  { const c = coronaCanvas.getContext('2d'), gr = c.createRadialGradient(128, 128, 30, 128, 128, 128);
    gr.addColorStop(0, 'rgba(255,200,120,.95)'); gr.addColorStop(.32, 'rgba(255,140,40,.45)'); gr.addColorStop(.6, 'rgba(255,90,20,.12)'); gr.addColorStop(1, 'rgba(255,60,0,0)');
    c.fillStyle = gr; c.fillRect(0, 0, 256, 256); }
  const coronaTex = new THREE.CanvasTexture(coronaCanvas);
  // Solar flares: arcs that grow out of the limb and fade, each re-erupting after an irregular pause.
  const flares = [];
  const flareMat = () => new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  function spawnFlare(f, now) {
    const theta = Math.random() * Math.PI * 2, spread = .07 + Math.random() * .16, height = 1.08 + Math.random() * (Math.random() < .15 ? .32 : .16);
    const at = (a, r) => new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, .25);
    const curve = new THREE.CubicBezierCurve3(at(theta - spread, .98), at(theta - spread * .55, height), at(theta + spread * .55, height), at(theta + spread, .98));
    f.mesh.geometry.dispose();
    f.mesh.geometry = new THREE.TubeGeometry(curve, 48, .012 + Math.random() * .014, 5, false);
    f.count = f.mesh.geometry.index.count;
    f.born = now; f.dur = 5 + Math.random() * 6; f.peak = .16 + Math.random() * .2;
    f.mesh.material.color.setHSL(.025 + Math.random() * .035, 1, .5 + Math.random() * .08);
  }

  for (const planet of planets) {
    if (planet.sun) {
      planet.yaw = 0;
      planet.axis = new THREE.Group(); planet.axis.rotation.z = planet.tilt;
      planet.body = new THREE.Mesh(planetSphere, sunMaterial);
      const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: coronaTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      corona.scale.setScalar(5.2); planet.corona = corona;
      planet.axis.add(corona, planet.body);
      for (let i = 0; i < 4; i++) {
        const f = { mesh: new THREE.Mesh(new THREE.BufferGeometry(), flareMat()), born: -10, dur: 0, next: Math.random() * 2.5 };
        f.mesh.visible = false;
        planet.axis.add(f.mesh); flares.push(f);
      }
      scene.add(planet.axis);
      continue;
    }
    const material = new THREE.ShaderMaterial({
      uniforms: {
        dark: { value: new THREE.Color(planet.dark) }, light: { value: new THREE.Color(planet.light) },
        bands: { value: planet.bands }, cap: { value: planet.cap || 0 },
      },
      vertexShader: `varying vec3 surface; varying vec3 facing;
        void main() { surface = normal; facing = normalMatrix * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform vec3 dark, light; uniform float bands, cap; varying vec3 surface, facing;
        void main() {
          vec3 p = normalize(surface), n = normalize(facing);
          float swirls = sin(p.x * 8. + sin(p.z * 7.)) + .5 * cos(p.z * 11. + p.y * 4.);
          float pattern = bands > 0. ? sin(p.y * bands + swirls * .7) : sin(4. * p.y + swirls * 1.8);
          float mixAmount = .48 + .32 * pattern + .12 * sin(3. * swirls);
          float sun = max(0., dot(n, normalize(vec3(-.65,.6,.5))));
          vec3 col = mix(dark, light, mixAmount) * (.15 + .95 * sun);
          col += light * pow(1. - max(n.z, 0.), 3.) * (.12 + .35 * sun);
          col = mix(col, vec3(.95, .93, .9) * (.3 + .8 * sun), cap * smoothstep(.8, .9, abs(p.y)));
          gl_FragColor = vec4(col, 1.);
          #include <colorspace_fragment>
        }`,
    });
    planet.yaw = 0;
    planet.axis = new THREE.Group();
    planet.axis.rotation.z = planet.tilt;
    planet.body = new THREE.Mesh(planetSphere, material);
    planet.axis.add(planet.body);
    scene.add(planet.axis);
    const ringSystem = rings[planet.name];
    if (ringSystem) {
      for (const [inner, outer, opacity] of ringSystem.bands) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 96),
          new THREE.MeshBasicMaterial({ color: ringSystem.color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
        ring.rotation.x = ringSystem.tilt;
        planet.axis.add(ring);
      }
    }
  }

  // Constellation links: dotted trails Sun -> Neptune -> Mars with light packets travelling along them.
  const linkGroup = new THREE.Group(); scene.add(linkGroup);
  const links = [];
  const dotMat = new THREE.PointsMaterial({ color: 0xffd9a0, size: .085, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const packetGeo = new THREE.BufferGeometry(); const packetPos = new Float32Array(9 * 3);
  packetGeo.setAttribute('position', new THREE.BufferAttribute(packetPos, 3));
  const packets = new THREE.Points(packetGeo, new THREE.PointsMaterial({ color: 0xfff1c8, size: .24, transparent: true, opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  packets.frustumCulled = false;
  linkGroup.add(packets);
  // Spokes from the Sun to each planet, drawn on one plane so they meet the planets on screen, stopping at
  // each body's edge and bowing away from Earth.
  function buildLinks() {
    linkGroup.children.filter((c) => c !== packets).forEach((c) => { c.geometry.dispose(); linkGroup.remove(c); });
    links.length = 0;
    const Z = -8, cz = camera.position.z;
    const flat = (pos) => { const k = (cz - Z) / (cz - pos.z); return new THREE.Vector3(pos.x * k, pos.y * k, Z); };
    const reach = (p) => p.axis.scale.x * (cz - Z) / (cz - p.axis.position.z) * (p.sun ? 1.55 : p.name === 'Saturn' ? 2.2 : 1.6);
    // Chain: Saturn -> Sun -> Earth -> Mars. Each link stops at both bodies' edges, so none crosses the globe.
    const body = (p) => ({ at: flat(p.axis.position), r: reach(p) });
    const byName = Object.fromEntries(planets.map((p) => [p.name, p]));
    const earth = { at: flat(world.position), r: R * world.scale.x * (cz - Z) / cz * 1.08 };
    const chain = [body(byName.Saturn), body(byName.Sun), earth, body(byName.Mars)];
    for (let i = 0; i < chain.length - 1; i++) {
      const A = chain[i], B = chain[i + 1], dir = B.at.clone().sub(A.at).normalize();
      const a = A.at.clone().addScaledVector(dir, A.r), b = B.at.clone().addScaledVector(dir, -B.r);
      if (a.distanceTo(b) < .5) continue;
      const mid = a.clone().add(b).multiplyScalar(.5), normal = new THREE.Vector3(-dir.y, dir.x, 0);
      if (normal.y < 0) normal.negate();
      const curve = new THREE.QuadraticBezierCurve3(a, mid.addScaledVector(normal, a.distanceTo(b) * .1), b);
      const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(curve.getSpacedPoints(Math.max(10, Math.round(curve.getLength() * 4.5)))), dotMat);
      linkGroup.add(dots); links.push(curve);
    }
  }

  // State feedback from the (simulated) experiment: cyan pulse on pass, magenta-red on fail.
  let pulseColor = new THREE.Color(0, 0, 0), pulseAmt = 0, tintMix = 0;
  const pass = new THREE.Color(0x52ffd9), fail = new THREE.Color(0xff3d6e);
  function setOutcome(kind) { if (kind === 'released') { pulseColor.copy(pass); pulseAmt = 1.6; } else if (kind === 'failed') { pulseColor.copy(fail); pulseAmt = 1.6; } else { pulseAmt = 0; } dirty = true; }

  let visible = true, time = 0, last = performance.now(), mx = 0, my = 0, vx = 0, vy = 0, drag = false, lx = 0, ly = 0, yaw = 0, pitch = 0, yawVel = 0, pitchVel = 0;
  let layout = { x: 0, y: 0, s: 1 };
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    const skyHeight = 2 * (camera.position.z + 9) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    for (const planet of planets) {
      const x = w <= 1100 ? planet.mobileX : planet.x;
      const y = w <= 1100 ? planet.mobileY : planet.y;
      const planetHeight = skyHeight * (camera.position.z - planet.depth) / (camera.position.z + 9);
      planet.axis.position.set(x * planetHeight * camera.aspect, y * planetHeight, planet.depth);
      planet.axis.scale.setScalar(planet.radius * (w < 760 ? .6 : 1));
    }
    spiralPlane.position.set(-.28 * skyHeight * camera.aspect, .24 * skyHeight, -9);
    spiralPlane.scale.setScalar(w < 760 ? .64 : 1);
    world.position.set(layout.x, layout.y, 0); world.scale.setScalar(layout.s * (w < 760 ? .62 : 1));
    buildLinks();
    dirty = true;
  }
  new ResizeObserver(resize).observe(host); resize();
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; dirty = true; }).observe(host);
  const el = renderer.domElement;
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const owners = new Map([[earth, null]]);
  for (const planet of planets) {
    for (const mesh of planet.axis.children) owners.set(mesh, planet);
  }
  const targets = Array.from(owners.keys());
  let draggedPlanet = null;
  function pick(event) {
    const bounds = el.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1,
      1 - (event.clientY - bounds.top) / bounds.height * 2);
    ray.setFromCamera(pointer, camera);
    return ray.intersectObjects(targets, false)[0]?.object;
  }
  el.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const mesh = pick(event);
    if (!mesh) return;
    draggedPlanet = owners.get(mesh);
    drag = true;
    lx = event.clientX;
    ly = event.clientY;
    yawVel = pitchVel = 0;
    el.setPointerCapture(event.pointerId);
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    if (!drag) {
      el.style.cursor = pick(event) ? 'grab' : 'default';
      if (!reduced) { mx = pointer.x * .08; my = -pointer.y * .04; }
      return;
    }
    const dx = event.clientX - lx, dy = event.clientY - ly;
    if (draggedPlanet) {
      draggedPlanet.yaw += dx * .022;
      draggedPlanet.axis.rotation.x = THREE.MathUtils.clamp(draggedPlanet.axis.rotation.x + dy * .015, -1.3, 1.3);
    } else {
      yaw += dx * .005;
      pitch = THREE.MathUtils.clamp(pitch + dy * .004, -.6, .6);
      yawVel = reduced ? 0 : dx * .2;
      pitchVel = reduced ? 0 : dy * .16;
    }
    lx = event.clientX;
    ly = event.clientY;
    dirty = true;
  });
  el.addEventListener('lostpointercapture', event => {
    drag = false;
    draggedPlanet = null;
    el.style.cursor = pick(event) ? 'grab' : 'default';
  });

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!visible || document.hidden) return;
    if (!reduced) { time += dt; dirty = true; }
    if (!dirty) return;
    vx += (mx - vx) * Math.min(1, dt * 3); vy += (my - vy) * Math.min(1, dt * 3);
    for (const planet of planets) planet.body.rotation.y = planet.yaw + time * planet.speed;
    sunTime.value = time;
    const sun = planets.find((p) => p.sun);
    let flareGlow = 0;
    for (const f of flares) {
      if (time >= f.next && time - f.born > f.dur) { spawnFlare(f, time); f.next = time + f.dur + 1 + Math.random() * Math.random() * 9; }
      const u = f.dur ? (time - f.born) / f.dur : 2;
      if (u < 0 || u > 1) { f.mesh.visible = false; continue; }
      f.mesh.visible = true;
      const grow = Math.min(1, u / .45);
      f.mesh.geometry.setDrawRange(0, Math.floor(f.count * grow / 6) * 6);
      const o = Math.sin(Math.PI * Math.min(1, u)) ** 1.5 * f.peak;
      f.mesh.material.opacity = o; flareGlow = Math.max(flareGlow, o);
    }
    sun.corona.material.opacity = .72 + .06 * Math.sin(time * .7) + flareGlow * .08;
    sun.corona.scale.setScalar(5.2 + .12 * Math.sin(time * .5));
    links.forEach((curve, i) => {
      for (let k = 0; k < 3; k++) {
        const u = (time * .07 + k / 3 + i * .33) % 1, pt = curve.getPoint(u), j = (i * 3 + k) * 3;
        packetPos[j] = pt.x; packetPos[j + 1] = pt.y; packetPos[j + 2] = pt.z;
      }
    });
    packetGeo.attributes.position.needsUpdate = true;
    spiral.rotation.z = time * .045;
    spiral.material.opacity = .85 + .1 * Math.sin(time * .65);
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
    dirty = reduced && pulseAmt > 0;
  }
  requestAnimationFrame(frame);
  el.addEventListener('webglcontextlost', (e) => e.preventDefault());

  return {
    setLayout(l) { layout = { ...layout, ...l }; resize(); },
    setOutcome,
    diagnostics: () => ({ texturesLoaded, arcs: arcs.length, rings: bands.length, drawCalls: renderer.info.render.calls, time, paused: reduced }),
  };
}
