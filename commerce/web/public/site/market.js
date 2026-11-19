// Marketplace app. Live jobs are read straight from the Arc testnet escrow (jobCounter + getJob over /rpc) and
// refreshed every 10 s; open jobs from the hosted API (GET /v1/open-jobs) are merged in when reachable; sample
// listings (same shape) fill out the categories and are labelled as samples.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EXPLORER = 'https://explorer.testnet.arc.io';
const RPCS = ['/rpc', 'https://rpc.testnet.arc.io'];
const CORE = '0x4992b29bc494a6d9A33D153850C0E40F15F0e9c8';
const ADAPTER = '0x1fed5e532a1405facd45b4096ad1abf25bba0cb8';
const USDC = '0x3600000000000000000000000000000000000000';
const CHAIN_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];
const KNOWN = { // what the recorded runs were, by Arc job id
  1: ['First funded job on the live contracts', 'Reconciliation'], 2: ['Delivery tampered by one cent', 'Reconciliation'],
  3: ['Reconcile the invoice ledger', 'Reconciliation', 'paid'], 4: ['Ledger rerun, one cent off', 'Reconciliation', 'refused'],
  6: ['Open bounty, invalid claim rejected', 'Reconciliation'], 7: ['Open bounty: invoice reconciliation', 'Reconciliation', 'bounty'],
};

const STATUS = { draft: 'Not funded', open: 'Open', proving: 'Proof pending', paid: 'Paid', refunded: 'Refunded' };
const CATEGORY = {
  Reconciliation: { code: 'RC', hue: '#63f0ff' }, Scheduling: { code: 'SC', hue: '#ffd166' }, 'Data cleaning': { code: 'DC', hue: '#3fa9ff' },
  Extraction: { code: 'EX', hue: '#ffb65c' }, 'Signed records': { code: 'SR', hue: '#52ffd9' }, 'Verified job': { code: 'VJ', hue: '#9fd8ff' },
};
const outcomeOf = (job) => {
  if (job.demo?.outcome) return job.demo.outcome;
  return { Open: 'draft', Funded: 'open', Submitted: 'proving', Completed: 'paid', Rejected: 'refunded', Expired: 'refunded' }[job.status] || 'open';
};
const categoryOf = (job) => job.demo?.category || 'Verified job';
const sourceOf = (job) => (job.onchain ? 'Arc testnet (live)' : job.live ? 'Hosted API (live)' : `Sample · ${job.demo?.market || 'listing'}`);
const usdc = (base) => (Number(base) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const daysLeft = (job) => (job.expiry ? Math.round((Number(job.expiry) * 1000 - Date.now()) / 864e5) : null);

async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const json = await res.json();
      if (json.result !== undefined) return json.result;
    } catch { /* try the next endpoint */ }
  }
  throw new Error('Arc RPC unavailable');
}
const call = (data) => rpc('eth_call', [{ to: CORE, data }, 'latest']);
/** Decode getJob(uint256) -> (id, client, provider, evaluator, string description, budget, expiredAt, status, hook). */
function decodeJob(hex) {
  const w = (i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1));
  const addr = (i) => `0x${w(i).slice(24)}`;
  const big = (i) => BigInt(`0x${w(i)}`);
  const base = Number(big(0)) / 32; // tuple offset in words
  const descWord = base + Number(big(base + 4)) / 32;
  const len = Number(big(descWord));
  const bytes = hex.slice(2 + 64 * (descWord + 1), 2 + 64 * (descWord + 1) + len * 2);
  let description = '';
  try { description = decodeURIComponent(bytes.replace(/../g, '%$&')); } catch { /* not UTF-8 */ }
  return { id: Number(big(base)), client: addr(base + 1), provider: addr(base + 2), description, budget: big(base + 5).toString(),
    expiry: big(base + 6).toString(), status: CHAIN_STATUS[Number(big(base + 7))] || 'Open', hook: addr(base + 8) };
}
async function readChain() {
  const count = Number(BigInt(await call('0x50355d76')));
  const ids = Array.from({ length: count }, (_, i) => count - i);
  const rows = await Promise.all(ids.map((id) => call(`0xbf22c457${id.toString(16).padStart(64, '0')}`).then(decodeJob).catch(() => null)));
  const block = Number(BigInt(await rpc('eth_blockNumber', [])));
  return { block, jobs: rows.filter(Boolean).map((j) => {
    const [title, category, replay] = KNOWN[j.id] || [`Arc job #${j.id}`, 'Verified job'];
    const openClaim = j.hook.toLowerCase() === ADAPTER || j.provider.toLowerCase() === ADAPTER;
    return { ...j, jobId: `arc-${j.id}`, chainJobId: String(j.id), onchain: true,
      publicBrief: openClaim ? 'Open claim: any agent may claim it with a valid proof.' : 'Selected solver: paid only when the proof passes.',
      demo: { title, category, replay, market: openClaim ? 'Open bounty' : 'Selected solver' } };
  }) };
}
async function getJson(url, ms = 6000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error(String(res.status));
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function initMarket(root, { onReplay } = {}) {
  if (!root) return;
  const side = $('.mk-side', root), list = $('.mk-list', root), detail = $('.mk-detail', root), status = $('.market-status', root);
  status.innerHTML = '<span class="dot"></span>Reading jobs from Arc testnet…';
  let chain = [], api = [], samples = [], prev = new Map(), changed = new Set();
  try { samples = ((await getJson(new URL('./api/open-jobs.json', import.meta.url))).jobs || []).filter((j) => !j.chainJobId); } catch { /* none */ }
  getJson('/v1/open-jobs?limit=50').then((r) => { api = (r.jobs || []).map((j) => ({ ...j, live: true })); if (api.length) refresh(false); }).catch(() => {});

  const state = { status: 'all', category: 'all', source: 'all', q: '', sort: 'new', selected: null };
  const all = () => [...chain, ...api, ...samples];

  function renderSide() {
    const jobs = all();
    const groups = [
      ['status', 'Status', Object.keys(STATUS).filter((k) => jobs.some((j) => outcomeOf(j) === k)), (k) => STATUS[k], outcomeOf],
      ['category', 'Category', [...new Set(jobs.map(categoryOf))], (k) => k, categoryOf],
      ['source', 'Source', [...new Set(jobs.map(sourceOf))], (k) => k, sourceOf],
    ];
    side.innerHTML = `<label class="mk-search"><span class="sr-only">Search jobs</span><input type="search" placeholder="Search jobs" autocomplete="off" value="${esc(state.q)}"></label>` +
      groups.map(([key, title, values, label, of]) => `<div class="mk-group" data-key="${key}"><p>${title}</p>
        <button type="button" data-value="all" aria-pressed="${state[key] === 'all'}"><span>All</span><em>${jobs.length}</em></button>
        ${values.map((v) => `<button type="button" data-value="${esc(v)}" aria-pressed="${state[key] === v}">${key === 'category' ? `<i style="--h:${(CATEGORY[v] || CATEGORY['Verified job']).hue}"></i>` : ''}<span>${esc(label(v))}</span><em>${jobs.filter((j) => of(j) === v).length}</em></button>`).join('')}
      </div>`).join('') +
      `<div class="mk-fund"><p>Fund a test job</p>
        <a class="cta" href="https://faucet.circle.com" target="_blank" rel="noreferrer">Get test USDC ↗</a>
        <span>On the faucet, pick <b>Arc Testnet</b> and paste your wallet address.</span>
        <button type="button" class="mk-copy" data-copy="${USDC}">USDC <code>${short(USDC)}</code></button>
        <button type="button" class="mk-copy" data-copy="${CORE}">Escrow <code>${short(CORE)}</code></button>
        <span class="mono">Chain ID 5042002</span></div>`;
  }
  function visible() {
    const q = state.q.trim().toLowerCase();
    const shown = all().filter((j) => (state.status === 'all' || outcomeOf(j) === state.status)
      && (state.category === 'all' || categoryOf(j) === state.category)
      && (state.source === 'all' || sourceOf(j) === state.source)
      && (!q || `${j.demo?.title} ${j.publicBrief} ${categoryOf(j)} ${sourceOf(j)}`.toLowerCase().includes(q)));
    const by = { new: () => 0, budget: (a, b) => Number(b.budget) - Number(a.budget), deadline: (a, b) => (daysLeft(a) ?? 1e9) - (daysLeft(b) ?? 1e9) }[state.sort];
    return shown.slice().sort(by);
  }
  function row(job) {
    const cat = CATEGORY[categoryOf(job)] || CATEGORY['Verified job'], out = outcomeOf(job);
    const tag = job.onchain ? '<span class="src-tag live">LIVE</span>' : job.live ? '<span class="src-tag live">API</span>' : '<span class="src-tag">SAMPLE</span>';
    return `<li><button type="button" class="mk-row${state.selected?.jobId === job.jobId ? ' sel' : ''}${changed.has(job.jobId) ? ' flash' : ''}" data-id="${esc(job.jobId)}">
      <span class="mk-ico" style="--h:${cat.hue}">${cat.code}</span>
      <span class="mk-title"><b>${esc(job.demo?.title || `Open job ${job.chainJobId ?? ''}`)}</b>${tag}</span>
      <span class="mk-budget">${usdc(job.budget)}</span>
      <span class="m-pill ${out}">${STATUS[out]}</span>
    </button></li>`;
  }
  function renderList(animate) {
    const shown = visible();
    $('.mk-count', root).textContent = `${shown.length} ${shown.length === 1 ? 'job' : 'jobs'}`;
    list.innerHTML = shown.map(row).join('') || '<li class="mk-empty">No jobs match.</li>';
    if (animate && !reduced) { list.classList.remove('enter'); void list.offsetWidth; list.classList.add('enter'); }
    const keep = state.selected && shown.find((j) => j.jobId === state.selected.jobId);
    select(keep || shown[0] || null, animate);
  }
  function select(job, animate = true) {
    state.selected = job;
    $$('.mk-row', list).forEach((r) => r.classList.toggle('sel', !!job && r.dataset.id === job.jobId));
    if (!job) { detail.innerHTML = '<p class="dim">Pick a job to see its details.</p>'; return; }
    const d = job.demo || {}, out = outcomeOf(job), cat = CATEGORY[categoryOf(job)] || CATEGORY['Verified job'], days = daysLeft(job);
    const facts = [['Budget', `${usdc(job.budget)} ${job.onchain || job.live ? 'test ' : ''}USDC`], ['Category', categoryOf(job)], ['Source', sourceOf(job)]];
    if (job.onchain) facts.push(['Chain status', job.status], ['Settlement', d.market], ['Buyer', short(job.client)]);
    if (job.onchain && !/^0x0{40}$/.test(job.provider)) facts.push([job.provider.toLowerCase() === ADAPTER ? 'Claimed via' : 'Solver', job.provider.toLowerCase() === ADAPTER ? 'Open-claim adapter' : short(job.provider)]);
    if (d.checks) facts.push(['Checks', `${d.checks} rules`]);
    if (out === 'open' && days !== null) facts.push(['Deadline', days > 0 ? `${days} days` : 'closing']);
    const action = d.replay ? `<button type="button" class="cta mk-go" data-replay="${esc(d.replay)}">Replay on Arc ↓</button>`
      : job.live ? `<a class="cta mk-go" href="/v1/open-jobs/${encodeURIComponent(job.jobId)}" target="_blank" rel="noreferrer">Open over API ↗</a>` : '';
    const links = job.onchain ? `<a class="demo-link mono mk-tx" href="${EXPLORER}/address/${CORE}?tab=read_proxy" target="_blank" rel="noreferrer">Check getJob(${esc(job.chainJobId)}) on the explorer ↗</a>`
      : job.fundingTx ? `<a class="demo-link mono mk-tx" href="${EXPLORER}/tx/${esc(job.fundingTx)}" target="_blank" rel="noreferrer">Funding tx ${esc(short(job.fundingTx))} ↗</a>` : '';
    detail.innerHTML = `<div class="mk-d-head"><span class="mk-ico big" style="--h:${cat.hue}">${cat.code}</span><span class="m-pill ${out}">${STATUS[out]}</span></div>
      <h3>${esc(d.title || 'Open job')}</h3>
      <p class="mk-brief">${esc(job.publicBrief || '')}</p>
      <dl class="mk-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${links}${action}`;
    if (animate && !reduced) { detail.classList.remove('enter'); void detail.offsetWidth; detail.classList.add('enter'); }
  }
  function refresh(animate) { renderSide(); renderList(animate); }

  async function poll(first) {
    try {
      const res = await readChain();
      changed = new Set();
      for (const j of res.jobs) { if (!first && prev.get(j.jobId) !== j.status) changed.add(j.jobId); prev.set(j.jobId, j.status); }
      chain = res.jobs;
      status.innerHTML = `<span class="dot ok"></span>Live from Arc testnet · ${chain.length} on-chain jobs · block ${res.block.toLocaleString()} · updated ${new Date().toLocaleTimeString([], { hour12: false })}`;
      if (first || changed.size) refresh(first);
    } catch {
      status.innerHTML = `<span class="dot"></span>Arc RPC unreachable · showing ${chain.length ? 'last known' : 'sample'} jobs`;
      if (first) refresh(true);
    }
  }

  side.addEventListener('click', async (e) => {
    const copy = e.target.closest('.mk-copy');
    if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); copy.classList.add('copied'); setTimeout(() => copy.classList.remove('copied'), 1200); } catch { /* ignore */ } return; }
    const b = e.target.closest('.mk-group button'); if (!b) return;
    state[b.closest('.mk-group').dataset.key] = b.dataset.value;
    refresh(true);
  });
  side.addEventListener('input', (e) => { if (e.target.matches('input')) { state.q = e.target.value; renderList(true); } });
  $('.mk-sort', root).addEventListener('change', (e) => { state.sort = e.target.value; renderList(true); });
  list.addEventListener('click', (e) => { const r = e.target.closest('.mk-row'); if (r) select(all().find((j) => j.jobId === r.dataset.id)); });
  detail.addEventListener('click', (e) => { const b = e.target.closest('[data-replay]'); if (b) onReplay?.(b.dataset.replay); });

  await poll(true);
  setInterval(() => { if (!document.hidden) poll(false); }, 10000);
}
