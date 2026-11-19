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
    { name: 'Saturn', radius: .76, dark: 0x734a47, light: 0xf8ce9b, bands: 18, tilt: -.31, speed: .28, depth: -4.8, x: -.34, y: .32, mobileX: -.34, mobileY: .40 },
    { name: 'Sun', radius: .57, dark: 0xed5208, light: 0xffe99b, bands: -1, tilt: .4, speed: .34, depth: -6.5, x: -.13, y: .375, mobileX: .23, mobileY: .39 },
    { name: 'Mars', radius: .29, dark: 0x713c3c, light: 0xffaa7b, bands: 0, tilt: -.15, speed: .24, depth: -8.8, x: .42, y: -.17, mobileX: .42, mobileY: .005 },
  ];
  const rings = {
    Saturn: { color: 0xf2c498, tilt: 1.23, bands: [[1.27, 1.52, .55], [1.57, 1.85, .38], [1.9, 1.99, .24]] },
  };
  for (const planet of planets) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        dark: { value: new THREE.Color(planet.dark) }, light: { value: new THREE.Color(planet.light) },
        bands: { value: planet.bands },
      },
      vertexShader: `varying vec3 surface; varying vec3 facing;
        void main() { surface = normal; facing = normalMatrix * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform vec3 dark, light; uniform float bands; varying vec3 surface, facing;
        void main() {
          vec3 p = normalize(surface), n = normalize(facing);
          float swirls = sin(p.x * 8. + sin(p.z * 7.)) + .5 * cos(p.z * 11. + p.y * 4.);
          float pattern = bands > 0. ? sin(p.y * bands + swirls * .7) : sin(4. * p.y + swirls * 1.8);
          float mixAmount = .48 + .32 * pattern + .12 * sin(3. * swirls);
          float sun = max(0., dot(n, normalize(vec3(-.65,.6,.5))));
          vec3 col = mix(dark, light, mixAmount) * (.15 + .95 * sun);
          col += light * pow(1. - max(n.z, 0.), 3.) * (.12 + .35 * sun);
          if (bands < 0.) {
            float granules = sin(23. * p.x + swirls) * sin(17. * p.y - 4. * p.z);
            col = mix(dark, light, smoothstep(-1.5, 1.6, swirls + .35 * granules));
            col += vec3(.45,.12,.01) * pow(1. - max(n.z, 0.), 2.);
          }
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

  const [saturn, sun, mars] = planets;
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xff720f, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  corona.position.z = -.35;
  sun.axis.add(corona);
  // Layer two travelling waves around the limb. Their relative phase changes the
  // local spacing and height of the flame tips without restarting a loop.
  const flareMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { clock: { value: 0 }, turn: { value: 0 }, viewShift: { value: 0 } },
    vertexShader: `varying vec2 disc;
      void main() {
        disc = position.xy;
        vec4 center = modelViewMatrix * vec4(0., 0., 0., 1.);
        center.xy += position.xy * length(modelViewMatrix[0].xyz);
        gl_Position = projectionMatrix * center;
      }`,
    fragmentShader: `varying vec2 disc;
      uniform float clock, turn, viewShift;
      void main() {
        float radius = length(disc);
        float angle = atan(disc.y, disc.x) - turn;
        float t = clock + viewShift;
        float drift = sin(2. * angle - .43 * t) + .5 * sin(5. * angle + .67 * t + 1.1);
        float warped = angle + .19 * drift;
        float phase = 1.55 * t + .9 * sin(.71 * t + drift);
        float swell = .5 + .5 * sin(5. * warped - phase + .8 * sin(3. * angle + .8 * t));
        float ripple = .5 + .5 * sin(13. * warped + phase + 2. * swell - 4. * radius);
        float burst = pow(.5 + .5 * sin(3. * angle + .57 * t + 1.4 * drift), 4.);
        float height = .07 + (.21 + .36 * burst) * swell * swell + .14 * ripple;
        float altitude = max(radius - .98, 0.);
        float plume = 1. - smoothstep(.02, height, altitude);
        float filament = .5 + .5 * cos(27. * warped - phase + 9. * altitude + 2. * ripple);
        float strength = smoothstep(.96, 1.01, radius) * plume * (.35 + .65 * filament);
        vec3 color = mix(vec3(1., .12, .012), vec3(1., .66, .13), plume * plume);
        gl_FragColor = vec4(color, .65 * strength);
        #include <colorspace_fragment>
      }`,
  });
  const flareWaves = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 3.5), flareMaterial);
  sun.axis.add(flareWaves);

  // Prominence arcades have paired footpoints on the rotating photosphere.
  // Neighbouring strands rise to different heights and carry moving hot knots.
  const prominenceMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { clock: flareMaterial.uniforms.clock },
    vertexShader: `uniform float clock; varying float along; varying float phase;
      void main() {
        along = uv.x;
        phase = position.y * 2.8 + position.z * 1.6;
        float crest = sin(3.141593 * along);
        float lift = .037 * crest * sin(.84 * clock + phase + along * 4.);
        vec3 displaced = position + normalize(position) * lift;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.);
      }`,
    fragmentShader: `uniform float clock; varying float along; varying float phase;
      void main() {
        float knot = pow(.5 + .5 * cos(8. * along - clock * 1.45 + phase), 3.);
        float feet = pow(abs(2. * along - 1.), 5.);
        vec3 heat = mix(vec3(1., .19, .018), vec3(1., .80, .31), max(knot, feet));
        gl_FragColor = vec4(heat, .52 + .40 * max(knot, feet));
        #include <colorspace_fragment>
      }`,
  });
  const arcades = [
    { longitude: .10, latitude: .32, height: .56 },
    { longitude: 2.97, latitude: -.36, height: .36 },
    { longitude: 1.53, latitude: .68, height: .42 },
    { longitude: 4.70, latitude: -.55, height: .49 },
  ];
  for (const { longitude, latitude, height } of arcades) {
    const arcade = new THREE.Group();
    arcade.rotation.order = 'YXZ';
    arcade.rotation.y = longitude;
    arcade.rotation.z = latitude;
    for (let strand = 0; strand < 3; strand++) {
      const spread = .26 + .045 * strand;
      const foot = Math.sqrt(1 - spread * spread);
      const apex = 1 + height + .08 * strand;
      const curve = new THREE.CubicBezierCurve3(
        new THREE.Vector3(foot, -spread, 0),
        new THREE.Vector3(apex, -spread * 1.8, .12),
        new THREE.Vector3(apex + .09, spread * 1.45, .04 * strand),
        new THREE.Vector3(foot, spread, 0));
      const tube = new THREE.TubeGeometry(curve, 36, strand === 1 ? .023 : .015, 6, false);
      arcade.add(new THREE.Mesh(tube, prominenceMaterial));
    }
    sun.body.add(arcade);
  }

  // Straight dashed paths run between the visible limbs of adjacent bodies.
  const pathShape = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  const links = [[saturn, sun], [sun, mars]].map(([from, to]) => {
    const path = new THREE.Group();
    for (const [radius, opacity] of [[.016, .95], [.042, .16]]) {
      const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: {
          radius: { value: radius }, brightness: { value: opacity },
        },
        vertexShader: `uniform float radius; varying float along;
          void main() {
            along = position.y + .5;
            vec3 p = vec3(position.x * radius, position.y, position.z * radius);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
          }`,
        fragmentShader: `uniform float brightness; varying float along;
          void main() {
            float repeatPos = along * 10.;
            float edge = abs(fract(repeatPos + .5) - .5);
            float aa = clamp(fwidth(repeatPos), .005, .12);
            float dash = 1. - smoothstep(.31 - aa, .31 + aa, edge);
            vec3 color = mix(vec3(.22, .62, 1.), vec3(.74, .36, 1.), along);
            gl_FragColor = vec4(color, dash * brightness);
          }`,
      });
      const mesh = new THREE.Mesh(pathShape, material);
      path.add(mesh);
    }
    scene.add(path);
    return { from, to, path };
  });
  const up = new THREE.Vector3(0, 1, 0);
  const start = new THREE.Vector3(), end = new THREE.Vector3(), direction = new THREE.Vector3();
  const eyeDirection = new THREE.Vector3(), toward = new THREE.Vector3();
  function visibleLimb(body, neighbor, point) {
    const center = body.axis.position, radius = body.axis.scale.x;
    eyeDirection.subVectors(camera.position, center);
    const distance = eyeDirection.length();
    eyeDirection.divideScalar(distance);
    toward.subVectors(neighbor.axis.position, center);
    toward.addScaledVector(eyeDirection, -toward.dot(eyeDirection)).normalize();
    // A tangent from the camera touches the sphere slightly ahead of its equator.
    const cosine = radius / distance;
    point.copy(center).addScaledVector(eyeDirection, radius * cosine)
      .addScaledVector(toward, radius * Math.sqrt(1 - cosine * cosine));
  }
  function placeLinks() {
    for (const { from, to, path } of links) {
      visibleLimb(from, to, start);
      visibleLimb(to, from, end);
      direction.subVectors(end, start);
      path.scale.y = direction.length();
      path.position.lerpVectors(start, end, .5);
      path.quaternion.setFromUnitVectors(up, direction.normalize());
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
      const planetHeight = skyHeight * (camera.position.z - planet.depth) / (camera.position.z + 9);
      const x = w <= 1100 ? planet.mobileX : planet.x;
      const y = w <= 1100 ? planet.mobileY : planet.y;
      planet.axis.position.set(x * planetHeight * camera.aspect, y * planetHeight, planet.depth);
      planet.axis.scale.setScalar(planet.radius * (w < 760 ? .6 : 1));
    }
    flareMaterial.uniforms.viewShift.value = reduced ? 0 : (layout.s - .74) * 3;
    spiralPlane.position.set(-.28 * skyHeight * camera.aspect, .24 * skyHeight, -9);
    spiralPlane.scale.setScalar(w < 760 ? .64 : 1);
    world.position.set(layout.x, layout.y, 0); world.scale.setScalar(layout.s * (w < 760 ? .62 : 1));
    placeLinks();
    dirty = true;
  }
  new ResizeObserver(resize).observe(host); resize();
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; dirty = true; }).observe(host);
  const el = renderer.domElement;
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const owners = new Map([[earth, null]]);
  for (const planet of planets) {
    for (const mesh of planet.axis.children) {
      if (mesh.isMesh && mesh !== flareWaves) owners.set(mesh, planet);
    }
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
    corona.scale.setScalar(4.5 + .18 * Math.sin(time * 1.6));
    flareMaterial.uniforms.clock.value = time;
    flareMaterial.uniforms.turn.value = sun.body.rotation.y + .55 * sun.axis.rotation.x;
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
