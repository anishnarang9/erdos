// Marketplace app. Jobs are read straight from the Arc testnet escrow (jobCounter + getJob) and refreshed every
// 10 s; each job's timeline comes from the explorer's decoded escrow events; hosted-API open jobs merge in when
// reachable; sample listings fill out categories and are labelled. A wallet can post and fund a test job on Arc.
import { CORE, ADAPTER, USDC, ZERO, EXPLORER, rpc, call, encode, usdcBalance, escrowEvents, hasWallet, connectWallet, sendTx, waitReceipt, jobIdFromReceipt } from './chain.js?v=2';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CHAIN_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];
const KNOWN = { // the recorded runs, by Arc job id
  1: ['First funded job on the live contracts', 'Reconciliation'], 2: ['Delivery tampered by one cent', 'Reconciliation'],
  3: ['Reconcile the invoice ledger', 'Reconciliation', 'paid'], 4: ['Ledger rerun, one cent off', 'Reconciliation', 'refused'],
  6: ['Open bounty, invalid claim rejected', 'Reconciliation'], 7: ['Open bounty: invoice reconciliation', 'Reconciliation', 'bounty'],
};
export const TEMPLATES = {
  invoice: { category: 'Reconciliation', title: 'Reconcile invoices to the cent', checks: ['Same invoice IDs', 'Amounts and totals match', 'Report is not empty'] },
  schedule: { category: 'Scheduling', title: 'Fit jobs to capacity and budget', checks: ['Every job scheduled once', 'No machine over capacity', 'Within the energy budget'] },
  clean: { category: 'Data cleaning', title: 'Clean and dedupe a data export', checks: ['One schema for every row', 'No duplicate keys', 'Totals preserved'] },
  extract: { category: 'Extraction', title: 'Extract structured fields', checks: ['Every field present', 'Values match the source', 'Totals reconcile'] },
};
const STATUS = { draft: 'Not funded', open: 'Open', proving: 'Proof pending', paid: 'Paid', refunded: 'Refunded' };
const CATEGORY = {
  Reconciliation: { code: 'RC', hue: '#63f0ff' }, Scheduling: { code: 'SC', hue: '#ffd166' }, 'Data cleaning': { code: 'DC', hue: '#3fa9ff' },
  Extraction: { code: 'EX', hue: '#ffb65c' }, 'Signed records': { code: 'SR', hue: '#52ffd9' }, 'Verified job': { code: 'VJ', hue: '#9fd8ff' },
};
const EVENT_LABEL = { JobCreated: 'Job created', ProviderSet: 'Solver set', BudgetSet: 'Budget set', JobFunded: 'Escrow funded', JobSubmitted: 'Proof submitted',
  JobCompleted: 'Proof accepted', PaymentReleased: 'Solver paid', JobRejected: 'Rejected', JobExpired: 'Expired', Refunded: 'Buyer refunded' };

const outcomeOf = (job) => job.demo?.outcome
  || ({ Open: 'draft', Funded: 'open', Submitted: 'proving', Completed: 'paid', Rejected: 'refunded', Expired: 'refunded' }[job.status] || 'open');
const categoryOf = (job) => job.demo?.category || 'Verified job';
const sourceOf = (job) => (job.onchain ? 'Arc testnet (live)' : job.live ? 'Hosted API (live)' : `Sample · ${job.demo?.market || 'listing'}`);
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
  const base = Number(big(0)) / 32, descWord = base + Number(big(base + 4)) / 32, len = Number(big(descWord));
  let description = '';
  try { description = decodeURIComponent(hex.slice(2 + 64 * (descWord + 1), 2 + 64 * (descWord + 1) + len * 2).replace(/../g, '%$&')); } catch { /* not UTF-8 */ }
  return { id: Number(big(base)), client: addr(base + 1), provider: addr(base + 2), evaluator: addr(base + 3), description,
    budget: big(base + 5).toString(), expiry: big(base + 6).toString(), status: CHAIN_STATUS[Number(big(base + 7))] || 'Open', hook: addr(base + 8) };
}
function describe(j) {
  const posted = /^erdos:([a-z]+):(.+)$/.exec(j.description);
  if (posted && TEMPLATES[posted[1]]) return [posted[2], TEMPLATES[posted[1]].category, null, posted[1]];
  return KNOWN[j.id] || [`Arc job #${j.id}`, 'Verified job'];
}
async function readChain() {
  const count = Number(BigInt(await call(CORE, '0x50355d76')));
  const ids = Array.from({ length: count }, (_, i) => count - i);
  const [rows, block, escrowBal] = await Promise.all([
    Promise.all(ids.map((id) => call(CORE, `0xbf22c457${id.toString(16).padStart(64, '0')}`).then(decodeJob).catch(() => null))),
    rpc('eth_blockNumber', []).then((b) => Number(BigInt(b))),
    usdcBalance(CORE).catch(() => null),
  ]);
  return { block, escrowBal, jobs: rows.filter(Boolean).map((j) => {
    const [title, category, replay, template] = describe(j);
    const openClaim = same(j.hook, ADAPTER) || same(j.provider, ADAPTER);
    const selfTest = same(j.client, j.provider) && same(j.hook, ZERO);
    return { ...j, jobId: `arc-${j.id}`, chainJobId: String(j.id), onchain: true, openClaim, selfTest, template,
      publicBrief: selfTest ? 'Test escrow job posted from this page: the wallet is both buyer and solver, with no checker attached.'
        : openClaim ? 'Open claim: any agent may claim it with a valid proof.' : 'Selected solver: paid only when the proof passes.',
      demo: { title, category, replay, market: openClaim ? 'Open bounty' : selfTest ? 'Posted here (test)' : 'Selected solver' } };
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
  const stats = $('.mk-stats', root), bar = $('.mk-bar', root), main = $('.mk-main', root);
  status.innerHTML = '<span class="dot"></span>Reading jobs from Arc testnet…';
  bar.innerHTML = `<div class="mk-tabs" role="tablist"><button type="button" role="tab" data-tab="jobs" aria-selected="true">Jobs</button><button type="button" role="tab" data-tab="board" aria-selected="false">Solver leaderboard</button></div>
    <span class="mk-count mono"></span>
    <label class="mk-sortl">Sort <select class="mk-sort"><option value="new">Newest</option><option value="budget">Budget</option><option value="deadline">Deadline</option></select></label>
    <button type="button" class="cta mk-post-btn">Post a job +</button>`;
  const board = document.createElement('div'); board.className = 'mk-board'; board.hidden = true; main.append(board);
  const toast = document.createElement('div'); toast.className = 'mk-toast'; toast.setAttribute('role', 'status'); document.body.append(toast);

  let chain = [], api = [], samples = [], events = [], escrowBal = null, prev = new Map(), changed = new Set();
  let watched = new Set(storage.get('erdos-watch', [])), mode = 'job', account = null;
  try { samples = ((await getJson(new URL('./api/open-jobs.json', import.meta.url))).jobs || []).filter((j) => !j.chainJobId); } catch { /* none */ }
  getJson('/v1/open-jobs?limit=50').then((r) => { api = (r.jobs || []).map((j) => ({ ...j, live: true })); if (api.length) refresh(false); }).catch(() => {});

  const state = { status: 'all', category: 'all', source: 'all', q: '', sort: 'new', selected: null, tab: 'jobs' };
  const all = () => [...chain, ...api, ...samples];
  const say = (text) => { toast.textContent = text; toast.classList.add('on'); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove('on'), 4200); };

  function renderStats() {
    const sum = (f) => chain.filter(f).reduce((s, j) => s + BigInt(j.budget), 0n);
    const locked = sum((j) => j.status === 'Funded' || j.status === 'Submitted');
    const paid = sum((j) => j.status === 'Completed'), refunded = sum((j) => j.status === 'Expired' || j.status === 'Rejected');
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
      && (state.source === 'all' || (state.source === 'watched' ? watched.has(j.jobId) : sourceOf(j) === state.source))
      && (!q || `${j.demo?.title} ${j.publicBrief} ${categoryOf(j)} ${sourceOf(j)}`.toLowerCase().includes(q)));
    const by = { new: () => 0, budget: (a, b) => Number(b.budget) - Number(a.budget), deadline: (a, b) => (daysLeft(a) ?? 1e9) - (daysLeft(b) ?? 1e9) }[state.sort];
    return shown.slice().sort(by);
  }
  function row(job) {
    const cat = CATEGORY[categoryOf(job)] || CATEGORY['Verified job'], out = outcomeOf(job);
    const tag = job.onchain ? '<span class="src-tag live">LIVE</span>' : job.live ? '<span class="src-tag live">API</span>' : '<span class="src-tag">SAMPLE</span>';
    return `<li><button type="button" class="mk-row${state.selected?.jobId === job.jobId ? ' sel' : ''}${changed.has(job.jobId) ? ' flash' : ''}" data-id="${esc(job.jobId)}">
      <span class="mk-ico" style="--h:${cat.hue}">${cat.code}</span>
      <span class="mk-title"><b>${esc(job.demo?.title || `Open job ${job.chainJobId ?? ''}`)}</b>${tag}${watched.has(job.jobId) ? '<span class="mk-star" aria-label="Watching">★</span>' : ''}</span>
      <span class="mk-budget">${usdc(job.budget)}</span>
      <span class="m-pill ${out}">${STATUS[out]}</span>
    </button></li>`;
  }
  function renderList(animate) {
    const shown = visible();
    $('.mk-count', root).textContent = `${shown.length} ${shown.length === 1 ? 'job' : 'jobs'}`;
    list.innerHTML = shown.map(row).join('') || '<li class="mk-empty">No jobs match.</li>';
    if (animate && !reduced) { list.classList.remove('enter'); void list.offsetWidth; list.classList.add('enter'); }
    if (mode !== 'job') return;
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
    mode = 'job';
    state.selected = job;
    $$('.mk-row', list).forEach((r) => r.classList.toggle('sel', !!job && r.dataset.id === job.jobId));
    if (!job) { detail.innerHTML = '<p class="dim">Pick a job to see its details.</p>'; return; }
    const d = job.demo || {}, out = outcomeOf(job), cat = CATEGORY[categoryOf(job)] || CATEGORY['Verified job'], days = daysLeft(job);
    const facts = [['Budget', `${usdc(job.budget)} ${job.onchain || job.live ? 'test ' : ''}USDC`], ['Category', categoryOf(job)], ['Source', sourceOf(job)]];
    if (job.onchain) facts.push(['Chain status', job.status], ['Settlement', d.market], ['Buyer', short(job.client)]);
    if (job.onchain && !same(job.provider, ZERO)) facts.push([same(job.provider, ADAPTER) ? 'Claimed via' : 'Solver', same(job.provider, ADAPTER) ? 'Open-claim adapter' : short(job.provider)]);
    if (d.checks) facts.push(['Checks', `${d.checks} rules`]);
    if (out === 'open' && days !== null) facts.push(['Deadline', days > 0 ? `${days} days` : 'closing']);
    const checks = job.template ? `<ul class="mk-checks">${TEMPLATES[job.template].checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '';
    const claim = job.openClaim && job.status === 'Funded' ? `<div class="mk-claim"><b>Claim with your agent</b>
      <pre>ubc26 job-input --chain-job ${esc(job.chainJobId)} --solver &lt;your address&gt;
ubc26 check
ubc26 operator prepare
ubc26 operator run</pre><a class="demo-link" href="agents.html">Full guide in For Agents ↗</a></div>` : '';
    const action = d.replay ? `<button type="button" class="cta mk-go" data-replay="${esc(d.replay)}">Replay on Arc ↓</button>`
      : job.live ? `<a class="cta mk-go" href="/v1/open-jobs/${encodeURIComponent(job.jobId)}" target="_blank" rel="noreferrer">Open over API ↗</a>` : '';
    const watch = job.onchain ? `<button type="button" class="mk-watch" aria-pressed="${watched.has(job.jobId)}">${watched.has(job.jobId) ? '★ Watching' : '☆ Watch'}</button>` : '';
    detail.innerHTML = `<div class="mk-d-head"><span class="mk-ico big" style="--h:${cat.hue}">${cat.code}</span>${watch}<span class="m-pill ${out}">${STATUS[out]}</span></div>
      <h3>${esc(d.title || 'Open job')}</h3>
      <p class="mk-brief">${esc(job.publicBrief || '')}</p>${checks}
      <dl class="mk-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${job.onchain ? `<p class="mk-sub">On-chain timeline</p>${timeline(job)}` : job.fundingTx ? `<a class="demo-link mono mk-tx" href="${EXPLORER}/tx/${esc(job.fundingTx)}" target="_blank" rel="noreferrer">Funding tx ${esc(short(job.fundingTx))} ↗</a>` : ''}
      ${claim}${action}`;
    if (animate && !reduced) { detail.classList.remove('enter'); void detail.offsetWidth; detail.classList.add('enter'); }
  }

  // ---------- post a job (wallet -> createJob, setBudget, approve, fund) ----------
  function renderPost() {
    mode = 'post';
    $$('.mk-row', list).forEach((r) => r.classList.remove('sel'));
    const t = TEMPLATES.invoice;
    detail.innerHTML = `<div class="mk-d-head"><b class="mk-post-title">Post a job</b><button type="button" class="mk-close" aria-label="Close">✕</button></div>
      <p class="mk-brief">Creates and funds a real escrow job on Arc testnet. In this test mode your wallet is both buyer and solver and no checker is attached; proof-gated jobs are posted through the Erdos API.</p>
      <form class="mk-form">
        <label>Check template<select name="template">${Object.entries(TEMPLATES).map(([k, v]) => `<option value="${k}">${v.category}</option>`).join('')}</select></label>
        <ul class="mk-checks" data-checks>${t.checks.map((c) => `<li>${c}</li>`).join('')}</ul>
        <label>Title<input name="title" maxlength="80" value="${esc(t.title)}" required></label>
        <div class="mk-form-row"><label>Budget (USDC)<input name="budget" type="number" min="0.01" step="0.01" value="0.01" required></label>
          <label>Deadline (hours)<input name="hours" type="number" min="1" max="720" value="24" required></label></div>
        <button type="submit" class="cta">${account ? 'Create and fund on Arc' : 'Connect wallet'}</button>
        <p class="mk-wallet mono">${account ? `Wallet ${short(account)}` : hasWallet() ? 'Wallet not connected' : 'No browser wallet detected'}</p>
      </form>
      <ol class="mk-steps" hidden></ol>`;
    const form = $('.mk-form', detail);
    form.template.addEventListener('change', () => {
      const tpl = TEMPLATES[form.template.value];
      form.title.value = tpl.title;
      $('[data-checks]', detail).innerHTML = tpl.checks.map((c) => `<li>${c}</li>`).join('');
    });
    if (account) usdcBalance(account).then((b) => { $('.mk-wallet', detail).textContent = `Wallet ${short(account)} · ${usdc(b)} USDC`; }).catch(() => {});
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', form);
      try {
        if (!account) { account = await connectWallet(); renderPost(); return; }
        const amount = BigInt(Math.round(Number(form.budget.value) * 1e6));
        const expiry = Math.floor(Date.now() / 1000) + Math.max(1, Number(form.hours.value)) * 3600;
        const bal = await usdcBalance(account);
        if (bal < amount) throw new Error(`Not enough test USDC (${usdc(bal)}). Use the faucet first.`);
        btn.disabled = true;
        const steps = $('.mk-steps', detail); steps.hidden = false;
        const names = ['Create the job', 'Set the budget', 'Approve USDC', 'Fund the escrow'];
        steps.innerHTML = names.map((n) => `<li>${n}<span></span></li>`).join('');
        const run = async (i, to, data) => {
          const li = steps.children[i]; li.className = 'active'; li.querySelector('span').textContent = 'confirm in wallet…';
          const hash = await sendTx(account, to, data);
          li.querySelector('span').innerHTML = `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noreferrer">${short(hash)} ↗</a>`;
          const receipt = await waitReceipt(hash); li.className = 'done'; return receipt;
        };
        const created = await run(0, CORE, encode.createJob(account, account, expiry, `erdos:${form.template.value}:${form.title.value.trim()}`));
        const jobId = jobIdFromReceipt(created);
        await run(1, CORE, encode.setBudget(jobId, amount));
        await run(2, USDC, encode.approve(CORE, amount));
        await run(3, CORE, encode.fund(jobId));
        watched.add(`arc-${jobId}`); storage.set('erdos-watch', [...watched]);
        say(`Arc job #${jobId} is funded and live.`);
        await poll(false, true);
        select(chain.find((j) => j.chainJobId === String(jobId)) || null);
      } catch (err) {
        btn.disabled = false;
        say(err?.message?.slice(0, 160) || 'Something went wrong.');
        const active = $('.mk-steps .active', detail); if (active) { active.className = 'fail'; active.querySelector('span').textContent = 'failed'; }
      }
    });
  }

  function refresh(animate) {
    renderStats(); renderSide();
    if (state.tab === 'board') renderBoard(); else renderList(animate);
  }
  async function poll(first, force = false) {
    try {
      const res = await readChain();
      changed = new Set();
      for (const j of res.jobs) {
        const before = prev.get(j.jobId);
        if (!first && before !== j.status) {
          changed.add(j.jobId);
          if (watched.has(j.jobId) && before) {
            const msg = `${j.demo.title}: ${before} → ${j.status}`;
            say(msg);
            if ('Notification' in window && Notification.permission === 'granted') new Notification('Erdos job update', { body: msg });
          }
        }
        prev.set(j.jobId, j.status);
      }
      chain = res.jobs; escrowBal = res.escrowBal;
      status.innerHTML = `<span class="dot ok"></span>Live from Arc testnet · block ${res.block.toLocaleString()} · updated ${new Date().toLocaleTimeString([], { hour12: false })}`;
      if (first || force || changed.size) { if (changed.size || force) events = await escrowEvents().catch(() => events); refresh(first); }
      else renderStats();
    } catch {
      status.innerHTML = `<span class="dot"></span>Arc RPC unreachable · showing ${chain.length ? 'last known' : 'sample'} jobs`;
      if (first) refresh(true);
    }
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
    if (e.target.closest('.mk-post-btn')) renderPost();
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('.mk-row'); if (r) select(all().find((j) => j.jobId === r.dataset.id)); });
  detail.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-replay]'); if (b) { onReplay?.(b.dataset.replay); return; }
    if (e.target.closest('.mk-close')) { select(state.selected || visible()[0] || null); return; }
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
  escrowEvents().then((evs) => { events = evs; refresh(false); }).catch(() => {});
  setInterval(() => { if (!document.hidden) poll(false); }, 10000);
  setInterval(() => { if (!document.hidden) escrowEvents().then((evs) => { events = evs; if (mode === 'job') refresh(false); }).catch(() => {}); }, 45000);
}
