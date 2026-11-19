// Demo marketplace: listings come over the API. GET /v1/open-jobs (live, through the hosted rewrite) is tried first;
// the demo listings file uses the same response shape, so live and demo jobs render the same way.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EXPLORER = 'https://explorer.testnet.arc.io/tx/';

const STATUS = {
  open: ['OPEN', 'open'], proving: ['PROOF PENDING', 'proving'], paid: ['PAID', 'paid'], refunded: ['REFUNDED', 'refunded'],
};
function outcomeOf(job) {
  if (job.demo?.outcome) return job.demo.outcome;
  if (job.status === 'Completed') return 'paid';
  if (job.status === 'Expired' || job.status === 'Rejected') return 'refunded';
  if (job.status === 'Submitted') return 'proving';
  return 'open';
}
const usdc = (base) => (Number(base) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  const grid = $('.market-grid', root), status = $('.market-status', root);
  let live = [], demo = [], liveState = 'checking';
  status.textContent = 'Calling GET /v1/open-jobs…';

  try {
    const res = await getJson('/v1/open-jobs?limit=50');
    live = (res.jobs || []).map((j) => ({ ...j, live: true }));
    liveState = 'ok';
  } catch { liveState = 'down'; }
  try { demo = (await getJson(new URL('./api/open-jobs.json', import.meta.url))).jobs || []; } catch { demo = []; }
  const jobs = [...live, ...demo];
  const onArc = demo.filter((j) => j.chainJobId).length;
  status.innerHTML = `<b>${jobs.length}</b> listings · <span class="${liveState === 'ok' ? 'ok' : 'dim'}">${live.length} live from <code>/v1/open-jobs</code>${liveState === 'down' ? ' (API unreachable here)' : ''}</span> · ${demo.length} demo · <span class="ok">${onArc} ran on Arc</span>`;

  const markets = [...new Set(jobs.map((j) => j.demo?.market || 'API'))];
  const marketBar = $('.market-filter[data-kind="market"]', root);
  marketBar.insertAdjacentHTML('beforeend', markets.map((m) => `<button type="button" data-value="${esc(m)}" aria-pressed="false">${esc(m)}</button>`).join(''));
  const filters = { status: 'all', market: 'all' };

  function card(job, i) {
    const out = outcomeOf(job), [label, cls] = STATUS[out];
    const d = job.demo || {};
    const title = d.title || job.publicBrief || `Open job ${job.chainJobId ?? job.jobId}`;
    const days = job.expiry ? Math.round((Number(job.expiry) * 1000 - Date.now()) / 864e5) : null;
    const due = out === 'open' && days !== null ? (days > 0 ? `${days} days left` : 'closing') : '';
    const kind = job.live ? '<span class="src-tag live">LIVE</span>' : job.chainJobId ? `<span class="src-tag arc">ARC JOB #${esc(job.chainJobId)}</span>` : '<span class="src-tag">SAMPLE</span>';
    const action = d.replay
      ? `<button type="button" class="m-act" data-replay="${esc(d.replay)}">Replay on Arc ↓</button>`
      : job.live ? `<a class="m-act" href="/v1/open-jobs/${encodeURIComponent(job.jobId)}" target="_blank" rel="noreferrer">View over API ↗</a>`
        : `<span class="m-act muted">Sample listing</span>`;
    const tx = job.fundingTx ? `<a class="m-tx mono" href="${EXPLORER}${esc(job.fundingTx)}" target="_blank" rel="noreferrer">funded ${esc(job.fundingTx.slice(0, 6))}…${esc(job.fundingTx.slice(-4))} ↗</a>` : '';
    return `<article class="m-card ${cls}${d.replay ? ' runnable' : ''}" style="--i:${i}" data-status="${out}" data-market="${esc(d.market || 'API')}">
      <header><span class="m-market">${esc(d.market || 'API')}</span>${kind}</header>
      <h3>${esc(title)}</h3>
      <p class="m-brief more">${esc(job.publicBrief || '')}</p>
      <div class="m-meta"><span class="m-budget"><b>${usdc(job.budget)}</b> ${d.replay || job.live ? 'test ' : ''}USDC</span><span class="m-pill ${cls}">${label}</span></div>
      <div class="m-sub mono"><span>${esc(d.category || job.jobType || 'Verified job')}</span>${d.checks ? `<span>${d.checks} checks</span>` : ''}${due ? `<span>${due}</span>` : ''}</div>
      <footer>${action}${tx}</footer>
    </article>`;
  }
  function render() {
    const shown = jobs.filter((j) => (filters.status === 'all' || outcomeOf(j) === filters.status) && (filters.market === 'all' || (j.demo?.market || 'API') === filters.market));
    grid.innerHTML = shown.map(card).join('') || '<p class="dim">No listings match these filters.</p>';
    if (!reduced) { grid.classList.remove('enter'); void grid.offsetWidth; grid.classList.add('enter'); }
  }
  $$('.market-filter', root).forEach((bar) => bar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    filters[bar.dataset.kind] = b.dataset.value;
    $$('button', bar).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-replay]'); if (!b) return;
    onReplay?.(b.dataset.replay);
  });
  render();
}
