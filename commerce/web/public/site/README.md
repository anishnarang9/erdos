# Landing site

Static landing page served at `/site/index.html`; the app's root route redirects here and `#/app` opens the live workspace.

- `index.html`, `site.css`, `site-v3.css`: page and styles.
- `site.js`: scroll logic, staggered text decode, hero rotation, layer diagrams, proof lab (simulation only).
- `globe.js`: the Earth with orbital rings and arcs that launch, land and respawn.
- `robot.js`: the solver-agent figure; its pose and held object follow the active Solution step.
- `coin.js`: the escrow coin.
- `layers.js`: content and icons for the three system layers.

The globe network, robot, coin and proof lab are illustrations. Nothing on this page creates a proof or sends a transaction. Real runs are listed under Case Studies with Arc explorer links; figures come from `commerce/evidence/` and `agents/anish/reports/`.

Design references (layout and visual language only; no logos, copy, models or imagery are reused): chaingpt.org, and the Dribbble shot "3D globe | Website header".

Third-party files in `vendor/`: Three.js 0.179.1 (MIT, see `vendor/LICENSE`); Earth day and night textures from the three.js examples (`examples/textures/planets/`).

After editing a script or stylesheet, bump the `?v=` number on the references in `index.html` and in `site.js` imports so browsers do not serve stale copies.
