# Landing site

Static landing page served at `/site/index.html`; the app's root route redirects here and `#/app` opens the live workspace.

- `index.html`, `site.css`, `site-v3.css`: page and styles.
- `site.js`: scroll logic, staggered text decode, hero rotation, and layer diagrams.
- `globe.js`: the Earth with orbital rings and arcs that launch, land and respawn.
- `robot.js`: the solver-agent figure; its pose and held object follow the active Solution step.
- `coin.js`: the escrow coin.
- `layers.js`: content and icons for the three system layers.

The globe network, robot, and coin illustrate the service. Marketplace reads live Arc Testnet and API data. For Agents gives buyer and solver instructions. Supply the task in chat.

Design references (layout and visual language only; no logos, copy, models or imagery are reused): chaingpt.org, and the Dribbble shot "3D globe | Website header".

Third-party files in `vendor/`: Three.js 0.179.1 (MIT, see `vendor/LICENSE`); Earth day and night textures from the three.js examples (`examples/textures/planets/`).

After editing a script or stylesheet, bump the `?v=` number on the references in `index.html` and in `site.js` imports so browsers do not serve stale copies.

## Deploying on Vercel

The Vercel project links to `anishnarang9/UBC-26`. Use `commerce/web` as the root directory and Other as the framework preset. Enable source files outside the root for the pnpm workspace and SDK. The checked-in commands install from `commerce/` and build into `commerce/web/dist`.

Push a branch to request a preview. Vercel redeploys production when a change reaches `main`. Use Git deployments so Vercel builds tracked files from the reviewed commit.

- Open `/` for the landing page or `/#/app` for the public workspace.
- Open `/#/job/<id>` for a live, read-only Arc open bounty.
- Vercel forwards `/rpc` to Arc testnet and forwards `/healthz` and the public open-bounty routes to the hosted API.
- Use the local workspace for legacy drafting, quote selection and funding. The public workspace has no signing controls or API token field.
