// Demo marketplace app. Listings come over the API: GET /v1/open-jobs (live, via the hosted rewrite) is tried first,
// and the demo listings file uses the same response shape, so live and demo jobs render the same way.
// Layout: filters (with counts) · compact job list · details panel for the selected job.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EXPLORER = 'https://explorer.testnet.arc.io/tx/';

const STATUS = { open: 'Open', proving: 'Proof pending', paid: 'Paid', refunded: 'Refunded' };
const CATEGORY = {
  Reconciliation: { code: 'RC', hue: '#63f0ff' },
  Scheduling: { code: 'SC', hue: '#ffd166' },
  'Data cleaning': { code: 'DC', hue: '#a78bfa' },
  Extraction: { code: 'EX', hue: '#ff8fd8' },
  'Signed records': { code: 'SR', hue: '#52ffd9' },
  Other: { code: 'JB', hue: '#9ca3af' },
};
const outcomeOf = (job) => job.demo?.outcome
  || (job.status === 'Completed' ? 'paid' : job.status === 'Expired' || job.status === 'Rejected' ? 'refunded' : job.status === 'Submitted' ? 'proving' : 'open');
const categoryOf = (job) => job.demo?.category || 'Other';
const marketOf = (job) => job.demo?.market || 'Live API';
const usdc = (base) => (Number(base) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysLeft = (job) => (job.expiry ? Math.round((Number(job.expiry) * 1000 - Date.now()) / 864e5) : null);

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
  status.textContent = 'Calling GET /v1/open-jobs…';
  let live = [], demo = [], apiOk = false;
  try { live = ((await getJson('/v1/open-jobs?limit=50')).jobs || []).map((j) => ({ ...j, live: true })); apiOk = true; } catch { /* demo only */ }
  try { demo = (await getJson(new URL('./api/open-jobs.json', import.meta.url))).jobs || []; } catch { demo = []; }
  const jobs = [...live, ...demo];
  status.innerHTML = `<span class="dot ${apiOk ? 'ok' : ''}"></span>${apiOk ? `API connected · ${live.length} live` : 'API offline here · demo listings'} · ${jobs.length} jobs`;

  const state = { status: 'all', category: 'all', market: 'all', q: '', sort: 'new', selected: null };
  const groups = [
    ['status', 'Status', Object.keys(STATUS), (k) => STATUS[k], outcomeOf],
    ['category', 'Category', [...new Set(jobs.map(categoryOf))], (k) => k, categoryOf],
    ['market', 'Source', [...new Set(jobs.map(marketOf))], (k) => k, marketOf],
  ];
  side.innerHTML = `<label class="mk-search"><span class="sr-only">Search jobs</span><input type="search" placeholder="Search jobs" autocomplete="off"></label>` +
    groups.map(([key, title, values, label, of]) => `<div class="mk-group" data-key="${key}"><p>${title}</p>
      <button type="button" data-value="all" aria-pressed="true"><span>All</span><em>${jobs.length}</em></button>
      ${values.map((v) => `<button type="button" data-value="${esc(v)}" aria-pressed="false">${key === 'category' ? `<i style="--h:${(CATEGORY[v] || CATEGORY.Other).hue}"></i>` : ''}<span>${esc(label(v))}</span><em>${jobs.filter((j) => of(j) === v).length}</em></button>`).join('')}
    </div>`).join('');

  function visible() {
    const q = state.q.trim().toLowerCase();
    const shown = jobs.filter((j) => (state.status === 'all' || outcomeOf(j) === state.status)
      && (state.category === 'all' || categoryOf(j) === state.category)
      && (state.market === 'all' || marketOf(j) === state.market)
      && (!q || `${j.demo?.title} ${j.publicBrief} ${categoryOf(j)} ${marketOf(j)}`.toLowerCase().includes(q)));
    const by = { new: () => 0, budget: (a, b) => Number(b.budget) - Number(a.budget), deadline: (a, b) => (daysLeft(a) ?? 1e9) - (daysLeft(b) ?? 1e9) }[state.sort];
    return shown.slice().sort(by);
  }
  function row(job) {
    const cat = CATEGORY[categoryOf(job)] || CATEGORY.Other, out = outcomeOf(job);
    const tag = job.live ? '<span class="src-tag live">LIVE</span>' : job.chainJobId ? '<span class="src-tag arc">ON ARC</span>' : '';
    return `<li><button type="button" class="mk-row${state.selected === job ? ' sel' : ''}" data-id="${esc(job.jobId)}">
      <span class="mk-ico" style="--h:${cat.hue}">${cat.code}</span>
      <span class="mk-title"><b>${esc(job.demo?.title || `Open job ${job.chainJobId ?? ''}`)}</b>${tag}</span>
      <span class="mk-budget">${usdc(job.budget)}</span>
      <span class="m-pill ${out}">${STATUS[out]}</span>
    </button></li>`;
  }
  function renderList() {
    const shown = visible();
    $('.mk-count', root).textContent = `${shown.length} ${shown.length === 1 ? 'job' : 'jobs'}`;
    list.innerHTML = shown.map(row).join('') || '<li class="mk-empty">No jobs match.</li>';
    if (!reduced) { list.classList.remove('enter'); void list.offsetWidth; list.classList.add('enter'); }
    if (!state.selected || !shown.includes(state.selected)) select(shown[0] || null);
  }
  function select(job) {
    state.selected = job;
    $$('.mk-row', list).forEach((r) => r.classList.toggle('sel', !!job && r.dataset.id === job.jobId));
    if (!job) { detail.innerHTML = '<p class="dim">Pick a job to see its details.</p>'; return; }
    const d = job.demo || {}, out = outcomeOf(job), cat = CATEGORY[categoryOf(job)] || CATEGORY.Other, days = daysLeft(job);
    const source = job.live ? 'Live from the API' : job.chainJobId ? `Arc testnet job #${esc(job.chainJobId)}` : 'Sample listing';
    const action = d.replay ? `<button type="button" class="cta mk-go" data-replay="${esc(d.replay)}">Replay on Arc ↓</button>`
      : job.live ? `<a class="cta mk-go" href="/v1/open-jobs/${encodeURIComponent(job.jobId)}" target="_blank" rel="noreferrer">Open over API ↗</a>` : '';
    detail.innerHTML = `<div class="mk-d-head"><span class="mk-ico big" style="--h:${cat.hue}">${cat.code}</span><span class="m-pill ${out}">${STATUS[out]}</span></div>
      <h3>${esc(d.title || 'Open job')}</h3>
      <p class="mk-brief">${esc(job.publicBrief || '')}</p>
      <dl class="mk-facts">
        <div><dt>Budget</dt><dd>${usdc(job.budget)} ${d.replay || job.live ? 'test ' : ''}USDC</dd></div>
        <div><dt>Category</dt><dd>${esc(categoryOf(job))}</dd></div>
        <div><dt>Source</dt><dd>${esc(marketOf(job))}</dd></div>
        ${d.checks ? `<div><dt>Checks</dt><dd>${d.checks} rules</dd></div>` : ''}
        ${out === 'open' && days !== null ? `<div><dt>Deadline</dt><dd>${days > 0 ? `${days} days` : 'closing'}</dd></div>` : ''}
        <div><dt>Record</dt><dd>${source}</dd></div>
      </dl>
      ${job.fundingTx ? `<a class="demo-link mono mk-tx" href="${EXPLORER}${esc(job.fundingTx)}" target="_blank" rel="noreferrer">Funding tx ${esc(job.fundingTx.slice(0, 8))}…${esc(job.fundingTx.slice(-4))} ↗</a>` : ''}
      ${action}`;
    if (!reduced) { detail.classList.remove('enter'); void detail.offsetWidth; detail.classList.add('enter'); }
  }

  side.addEventListener('click', (e) => {
    const b = e.target.closest('.mk-group button'); if (!b) return;
    const group = b.closest('.mk-group'); state[group.dataset.key] = b.dataset.value;
    $$('button', group).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderList();
  });
  $('input', side).addEventListener('input', (e) => { state.q = e.target.value; renderList(); });
  $('.mk-sort', root).addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  list.addEventListener('click', (e) => { const r = e.target.closest('.mk-row'); if (r) select(jobs.find((j) => j.jobId === r.dataset.id)); });
  detail.addEventListener('click', (e) => { const b = e.target.closest('[data-replay]'); if (b) onReplay?.(b.dataset.replay); });
  renderList();
}
