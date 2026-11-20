// Testnet marketplace backed by Arc escrow state and hosted open-bounty discovery.
import { CORE, ADAPTER, USDC, ZERO, EXPLORER, rpc, call, usdcBalance, escrowEvents } from './chain.js?v=2';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CHAIN_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];
const STATUS = { draft: 'Not funded', open: 'Open', proving: 'Proof pending', paid: 'Paid', rejected: 'Rejected', expired: 'Expired' };
const CATEGORY = {
  'Open bounty': { code: 'OB', hue: '#63f0ff' },
  'Escrow job': { code: 'EJ', hue: '#9fd8ff' },
};
const EVENT_LABEL = { JobCreated: 'Job created', ProviderSet: 'Solver set', BudgetSet: 'Budget set', JobFunded: 'Escrow funded', JobSubmitted: 'Proof submitted',
  JobCompleted: 'Proof accepted', PaymentReleased: 'Solver paid', JobRejected: 'Rejected', JobExpired: 'Expired', Refunded: 'Buyer refunded' };

const outcomeOf = (job) => ({ Open: 'draft', Funded: 'open', Submitted: 'proving', Completed: 'paid',
  Rejected: 'rejected', Expired: 'expired' }[job.status] || 'open');
const categoryOf = (job) => job.openClaim || job.apiJobId ? 'Open bounty' : 'Escrow job';
const sourceOf = (job) => job.onchain ? 'Arc Testnet' : 'Hosted API';
const titleOf = (job) => `Arc job #${job.chainJobId}`;
const usdc = (base) => (Number(base) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const daysLeft = (job) => (job.expiry ? Math.round((Number(job.expiry) * 1000 - Date.now()) / 864e5) : null);
const storage = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

/** Decode getJob(uint256) -> (id, client, provider, evaluator, string description, budget, expiredAt, status, hook). */
function decodeJob(hex) {
  const w = (i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1));
  const big = (i) => BigInt(`0x${w(i)}`);
  const addr = (i) => `0x${w(i).slice(24)}`;
  const base = Number(big(0)) / 32;
  return { id: Number(big(base)), client: addr(base + 1), provider: addr(base + 2),
    budget: big(base + 5).toString(), expiry: big(base + 6).toString(), status: CHAIN_STATUS[Number(big(base + 7))] || 'Open', hook: addr(base + 8) };
}
async function readChain() {
  const count = Number(BigInt(await call(CORE, '0x50355d76')));
  const ids = Array.from({ length: count }, (_, i) => count - i);
  const [rows, block, escrowBal] = await Promise.all([
    Promise.all(ids.map((id) => call(CORE, `0xbf22c457${id.toString(16).padStart(64, '0')}`).then(decodeJob).catch(() => null))),
    rpc('eth_blockNumber', []).then((b) => Number(BigInt(b))),
    usdcBalance(CORE).catch(() => null),
  ]);
  return { block, escrowBal, jobs: rows.filter(Boolean).map((j) => ({
    ...j, jobId: `arc-${j.id}`, chainJobId: String(j.id), onchain: true,
    openClaim: same(j.hook, ADAPTER) || same(j.provider, ADAPTER),
  })) };
}
async function getJson(url, ms = 6000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error(String(res.status));
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function initMarket(root) {
  if (!root) return;
  const side = $('.mk-side', root), list = $('.mk-list', root), detail = $('.mk-detail', root), status = $('.market-status', root);
  const stats = $('.mk-stats', root), bar = $('.mk-bar', root), main = $('.mk-main', root);
  status.innerHTML = '<span class="dot"></span>Reading jobs from Arc testnet…';
  bar.innerHTML = `<div class="mk-tabs" role="tablist"><button type="button" role="tab" data-tab="jobs" aria-selected="true">Jobs</button><button type="button" role="tab" data-tab="board" aria-selected="false">Solver leaderboard</button></div>
    <span class="mk-count mono"></span>
    <label class="mk-sortl">Sort <select class="mk-sort"><option value="new">Newest</option><option value="budget">Budget</option><option value="deadline">Deadline</option></select></label>
    <a class="cta" href="agents.html#buyer">Post via Erdos ↗</a>`;
  const board = document.createElement('div'); board.className = 'mk-board'; board.hidden = true; main.append(board);
  const toast = document.createElement('div'); toast.className = 'mk-toast'; toast.setAttribute('role', 'status'); document.body.append(toast);

  let chain = [], api = [], events = [], escrowBal = null, prev = new Map(), changed = new Set();
  const watched = new Set(storage.get('erdos-watch', []));
  const state = { status: 'all', category: 'all', source: 'all', q: '', sort: 'new', selected: null, tab: 'jobs' };
  const all = () => {
    const jobs = new Map(chain.map(job => [job.chainJobId, job]));
    for (const entry of api) {
      const job = jobs.get(entry.chainJobId);
      if (job && job.status !== 'Funded') continue;
      jobs.set(entry.chainJobId, { ...entry, ...job, apiJobId: entry.jobId, openClaim: true });
    }
    return [...jobs.values()];
  };
  const say = (text) => { toast.textContent = text; toast.classList.add('on'); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('on'), 4200); };

  function renderStats() {
    const sum = (f) => chain.filter(f).reduce((s, j) => s + BigInt(j.budget), 0n);
    const locked = sum((j) => j.status === 'Funded' || j.status === 'Submitted');
    const paid = sum((j) => j.status === 'Completed');
    const refunded = sum((j) => events.some((event) => event.name === 'Refunded' && event.jobId === j.id));
    const solvers = new Set(events.filter((e) => e.name === 'PaymentReleased').map((e) => String(e.args.provider).toLowerCase())).size;
    stats.innerHTML = [
      ['Locked in escrow', usdc(locked), 'USDC'], ['Paid to solvers', usdc(paid), 'USDC'], ['Refunded to buyers', usdc(refunded), 'USDC'],
      ['Jobs on chain', chain.length, ''], ['Paid solver addresses', solvers || '—', ''], ['Escrow balance', escrowBal === null ? '—' : usdc(escrowBal), escrowBal === null ? '' : 'USDC'],
    ].map(([k, v, u]) => `<div><dt>${k}</dt><dd><b>${v}</b>${u ? ` <small>${u}</small>` : ''}</dd></div>`).join('');
  }
  function renderSide() {
    const jobs = all();
    const groups = [
      ['status', 'Status', Object.keys(STATUS).filter((k) => jobs.some((j) => outcomeOf(j) === k)), (k) => STATUS[k], outcomeOf],
      ['category', 'Category', [...new Set(jobs.map(categoryOf))], (k) => k, categoryOf],
      ['source', 'Source', [...new Set(jobs.map(sourceOf))], (k) => k, sourceOf],
    ];
    side.innerHTML = `<label class="mk-search"><span class="sr-only">Search jobs</span><input type="search" placeholder="Search jobs" autocomplete="off" value="${esc(state.q)}"></label>` +
      (watched.size ? `<button type="button" class="mk-watchlist" aria-pressed="${state.source === 'watched'}">★ Watching <em>${watched.size}</em></button>` : '') +
      groups.map(([key, title, values, label, of]) => `<div class="mk-group" data-key="${key}"><p>${title}</p>
        <button type="button" data-value="all" aria-pressed="${state[key] === 'all'}"><span>All</span><em>${jobs.length}</em></button>
        ${values.map((v) => `<button type="button" data-value="${esc(v)}" aria-pressed="${state[key] === v}">${key === 'category' ? `<i style="--h:${(CATEGORY[v]).hue}"></i>` : ''}<span>${esc(label(v))}</span><em>${jobs.filter((j) => of(j) === v).length}</em></button>`).join('')}
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
      && (state.source === 'all' || (state.source === 'watched' ? watched.has(j.jobId) : sourceOf(j) === state.source))
      && (!q || `${titleOf(j)} ${j.publicBrief || ''} ${categoryOf(j)} ${sourceOf(j)}`.toLowerCase().includes(q)));
    const by = { new: () => 0, budget: (a, b) => Number(b.budget) - Number(a.budget), deadline: (a, b) => (daysLeft(a) ?? 1e9) - (daysLeft(b) ?? 1e9) }[state.sort];
    return shown.slice().sort(by);
  }
  function row(job) {
    const cat = CATEGORY[categoryOf(job)], out = outcomeOf(job);
    const tag = job.onchain ? '<span class="src-tag live">LIVE</span>' : '<span class="src-tag live">API</span>';
    return `<li><button type="button" class="mk-row${state.selected?.jobId === job.jobId ? ' sel' : ''}${changed.has(job.jobId) ? ' flash' : ''}" data-id="${esc(job.jobId)}">
      <span class="mk-ico" style="--h:${cat.hue}">${cat.code}</span>
      <span class="mk-title"><b>${esc(titleOf(job))}</b>${tag}${watched.has(job.jobId) ? '<span class="mk-star" aria-label="Watching">★</span>' : ''}</span>
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
  function renderBoard() {
    const rows = new Map();
    const bump = (a, k, v = 1n) => { const key = String(a).toLowerCase(); const r = rows.get(key) || { addr: a, paid: 0, earned: 0n, refused: 0 }; r[k] += typeof r[k] === 'bigint' ? v : Number(v); rows.set(key, r); };
    for (const e of events) if (e.name === 'PaymentReleased') { bump(e.args.provider, 'paid'); bump(e.args.provider, 'earned', BigInt(e.args.amount)); }
    for (const j of chain) if ((j.status === 'Expired' || j.status === 'Rejected') && !same(j.provider, ZERO)) bump(j.provider, 'refused');
    const ranked = [...rows.values()].sort((a, b) => b.paid - a.paid || Number(b.earned - a.earned));
    board.innerHTML = `<p class="mk-board-note">Read from Arc: <b>PaymentReleased</b> events and refunded jobs. Open bounties pay through the claim adapter, so their winners appear under it. No failed proof has ever been paid.</p>
      <table class="result-table"><thead><tr><th>#</th><th>Solver</th><th>Jobs paid</th><th>USDC earned</th><th>Refused</th></tr></thead><tbody>
      ${ranked.map((r, i) => `<tr><td class="mono">${i + 1}</td><td><a class="demo-link mono" href="${EXPLORER}/address/${esc(r.addr)}" target="_blank" rel="noreferrer">${same(r.addr, ADAPTER) ? 'Open-claim adapter' : short(r.addr)} ↗</a></td><td class="mono">${r.paid}</td><td class="mono">${usdc(r.earned)}</td><td class="mono">${r.refused}</td></tr>`).join('') || '<tr><td colspan="5">Waiting for events…</td></tr>'}
      </tbody></table>`;
  }
  function timeline(job) {
    const evs = events.filter((e) => e.jobId === Number(job.chainJobId));
    if (!evs.length) return '<p class="dim small">Loading on-chain events…</p>';
    return `<ol class="mk-timeline">${evs.map((e) => `<li class="${/Refund|Reject|Expired/.test(e.name) ? 'bad' : /Paid|Released|Completed/.test(e.name) ? 'ok' : ''}">
      <a href="${EXPLORER}/tx/${esc(e.tx)}" target="_blank" rel="noreferrer"><b>${EVENT_LABEL[e.name] || e.name}</b><span class="mono">${new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · block ${e.block.toLocaleString()} ↗</span></a></li>`).join('')}</ol>`;
  }
  function select(job, animate = true) {
    state.selected = job;
    $$('.mk-row', list).forEach((r) => r.classList.toggle('sel', !!job && r.dataset.id === job.jobId));
    if (!job) { detail.innerHTML = '<p class="dim">Pick a job to see its details.</p>'; return; }
    const out = outcomeOf(job), cat = CATEGORY[categoryOf(job)], days = daysLeft(job);
    const facts = [['Budget', `${usdc(job.budget)} test USDC`], ['Category', categoryOf(job)], ['Source', sourceOf(job)]];
    if (job.onchain) facts.push(['Chain status', job.status], ['Buyer', short(job.client)]);
    if (job.onchain && !same(job.provider, ZERO)) facts.push([same(job.provider, ADAPTER) ? 'Claimed via' : 'Solver', same(job.provider, ADAPTER) ? 'Open-claim adapter' : short(job.provider)]);
    if (out === 'open' && days !== null) facts.push(['Deadline', days > 0 ? `${days} days` : 'closing']);
    const action = job.apiJobId ? `<a class="cta mk-go" href="/v1/open-jobs/${encodeURIComponent(job.apiJobId)}" target="_blank" rel="noreferrer">Open over API ↗</a>
      <a class="demo-link" href="agents.html#solver">Solver instructions ↗</a>` : '';
    const watch = job.onchain ? `<button type="button" class="mk-watch" aria-pressed="${watched.has(job.jobId)}">${watched.has(job.jobId) ? '★ Watching' : '☆ Watch'}</button>` : '';
    detail.innerHTML = `<div class="mk-d-head"><span class="mk-ico big" style="--h:${cat.hue}">${cat.code}</span>${watch}<span class="m-pill ${out}">${STATUS[out]}</span></div>
      <h3>${esc(titleOf(job))}</h3>
      <p class="mk-brief">${esc(job.publicBrief || '')}</p>
      <dl class="mk-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${job.onchain ? `<p class="mk-sub">On-chain timeline</p>${timeline(job)}` : job.fundingTx ? `<a class="demo-link mono mk-tx" href="${EXPLORER}/tx/${esc(job.fundingTx)}" target="_blank" rel="noreferrer">Funding tx ${esc(short(job.fundingTx))} ↗</a>` : ''}
      ${action}`;
    if (animate && !reduced) { detail.classList.remove('enter'); void detail.offsetWidth; detail.classList.add('enter'); }
  }

  function refresh(animate) {
    renderStats(); renderSide();
    if (state.tab === 'board') renderBoard(); else renderList(animate);
  }
  async function poll(first) {
    const discovery = getJson('/v1/open-jobs?limit=50').then((result) => result.jobs || []).catch(() => []);
    changed = new Set();
    try {
      const res = await readChain();
      for (const j of res.jobs) {
        const before = prev.get(j.jobId);
        if (!first && before !== j.status) {
          changed.add(j.jobId);
          if (watched.has(j.jobId) && before) {
            const msg = `${titleOf(j)}: ${before} → ${j.status}`;
            say(msg);
            if ('Notification' in window && Notification.permission === 'granted') new Notification('Erdos job update', { body: msg });
          }
        }
        prev.set(j.jobId, j.status);
      }
      chain = res.jobs; escrowBal = res.escrowBal;
      status.innerHTML = `<span class="dot ok"></span>Live from Arc testnet · block ${res.block.toLocaleString()} · updated ${new Date().toLocaleTimeString([], { hour12: false })}`;
      if (first || changed.size) events = await escrowEvents().catch(() => events);
    } catch {
      status.innerHTML = `<span class="dot"></span>Arc RPC unavailable${chain.length ? ' · showing last available chain data' : ''}`;
    }
    const discovered = await discovery;
    const discoveryChanged = JSON.stringify(discovered) !== JSON.stringify(api);
    api = discovered;
    if (first || discoveryChanged || changed.size) refresh(first);
    else renderStats();
  }

  side.addEventListener('click', async (e) => {
    const copy = e.target.closest('.mk-copy');
    if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); copy.classList.add('copied'); setTimeout(() => copy.classList.remove('copied'), 1200); } catch { /* ignore */ } return; }
    if (e.target.closest('.mk-watchlist')) { state.source = state.source === 'watched' ? 'all' : 'watched'; refresh(true); return; }
    const b = e.target.closest('.mk-group button'); if (!b) return;
    state[b.closest('.mk-group').dataset.key] = b.dataset.value;
    refresh(true);
  });
  side.addEventListener('input', (e) => { if (e.target.matches('input')) { state.q = e.target.value; renderList(true); } });
  bar.addEventListener('change', (e) => { if (e.target.matches('.mk-sort')) { state.sort = e.target.value; renderList(true); } });
  bar.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      state.tab = tab.dataset.tab;
      $$('[data-tab]', bar).forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      list.hidden = state.tab !== 'jobs'; board.hidden = state.tab !== 'board';
      refresh(true); return;
    }
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('.mk-row'); if (r) select(all().find((j) => j.jobId === r.dataset.id)); });
  detail.addEventListener('click', async (e) => {
    if (e.target.closest('.mk-watch') && state.selected) {
      const id = state.selected.jobId;
      if (watched.has(id)) watched.delete(id); else {
        watched.add(id);
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
        say('Watching this job. You will be told when its status changes.');
      }
      storage.set('erdos-watch', [...watched]); refresh(false);
    }
  });

  await poll(true);
  setInterval(() => { if (!document.hidden) poll(false); }, 10000);
  setInterval(() => { if (!document.hidden) escrowEvents().then((evs) => { events = evs; refresh(false); }).catch(() => {}); }, 45000);
}
