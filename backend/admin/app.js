// scoop.md admin console. One module, no build step, no dependencies.
// Everything crawled or shared is rendered as text (textContent, never
// innerHTML), and links to crawled URLs only ever carry http(s) hrefs.
// The JSON API is same-origin (/api/*); the browser's Basic auth covers it.

const $view = document.getElementById('view');
const REFRESH_MS = 5000;
let timer = null;
let generation = 0;

// ---- DOM helpers -------------------------------------------------------------

// h('a', { class: 'x', href: '#/', onclick }, 'text', child, [more]) — strings become text nodes.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', safeHref(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Internal hash routes, or http(s) URLs. Anything else (javascript:, data:) becomes inert.
function safeHref(v) {
  const s = String(v);
  if (s.startsWith('#/')) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch {}
  return '#';
}

const ext = (url, label = url) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, label);
const enc = encodeURIComponent;
const fmtInt = (n) => (n ?? 0).toLocaleString('en-US');
const fmtUsd = (n, d = 4) => `$${Number(n ?? 0).toFixed(d)}`;
const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(2)} MB`);

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 0) return d.toISOString().slice(0, 16).replace('T', ' ');
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
const time = (iso) => (iso ? h('time', { datetime: iso, title: iso }, fmtTime(iso)) : '');

function duration(a, b) {
  if (!a) return '';
  const s = Math.max(0, ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

const ACTIVE = new Set(['queued', 'running', 'starting', 'crawling', 'waiting', 'busy']);
const PILL = {
  queued: 'running', running: 'running', starting: 'running', crawling: 'running', waiting: '', busy: 'running',
  complete: 'complete', ready: 'complete',
  rejected: 'rejected', not_devtool: 'rejected', cancelled: 'rejected', empty: 'rejected',
  failed: 'failed', error: 'failed', blocked: 'failed',
};
const LABEL = { not_devtool: 'rejected (not devtool)' };
const pill = (status) => h('span', { class: `pill ${PILL[status] ?? ''}` }, LABEL[status] ?? status ?? '—');

function table(cols, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  return h('div', { class: 'table' },
    h('table', {},
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.cls }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.cls }, c.get(r))))))));
}

const card = (title, ...body) => h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...body);
const stat = (value, label, extra) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label), extra ?? null);

function meter(used, cap) {
  const m = h('div', { class: `meter${used >= cap ? ' over' : ''}` }, h('i'));
  m.firstChild.style.width = `${Math.min(100, cap > 0 ? (used / cap) * 100 : 0)}%`;
  return m;
}

function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied ${fmtBytes(new Blob([text]).size)}`);
}

function markdownBlock(text, { short = false, label = 'Copy' } = {}) {
  const pre = h('pre', { class: `md${short ? ' short' : ''}` });
  pre.textContent = text;
  return h('div', { class: 'grid' },
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(text) }, label),
      h('span', { class: 'meta small' }, `${fmtInt(text.length)} characters · ${fmtBytes(new Blob([text]).size)}`)),
    pre);
}

// ---- API ---------------------------------------------------------------------

class ApiFailure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

async function act(button, fn, done) {
  button.disabled = true;
  try {
    const r = await fn();
    if (done) toast(typeof done === 'function' ? done(r) : done);
    render();
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
  }
}

// ---- Router ------------------------------------------------------------------

function route() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  return { parts, params: new URLSearchParams(query) };
}

const VIEWS = {
  '': overview, crawls, runs: runDetail, batches: batchDetail, seeds, sites: (r) => (r.parts[1] ? siteDetail(r) : sites(r)),
  page: pageDetail, agent, library: (r) => (r.parts[1] ? librarySite(r) : library(r)), skills: skillDetail, costs,
};
const NAV = { '': 'overview', runs: 'crawls', batches: 'crawls', page: 'sites', skills: 'library' };

async function render() {
  const r = route();
  const key = r.parts[0] ?? '';
  const view = VIEWS[key];
  const mine = ++generation;
  clearTimeout(timer);
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === (NAV[key] ?? key));
  if (!view) return show(mine, [card('Not found', h('p', {}, 'No such page. '), h('a', { href: '#/' }, 'Back to the overview'))]);
  let out;
  try {
    out = await view(r);
  } catch (e) {
    out = { nodes: [card('Something went wrong', h('p', { class: 'err' }, e.message))] };
  }
  show(mine, out.nodes ?? out, out.live);
}

// Swaps the view in (unless the user navigated meanwhile) and, while anything
// is running, re-renders every REFRESH_MS. Inputs keep focus and values.
function show(mine, nodes, live = false) {
  if (mine !== generation) return;
  const focused = document.activeElement?.id;
  const values = Object.fromEntries([...$view.querySelectorAll('input[id], select[id]')].map((i) => [i.id, i.type === 'checkbox' ? i.checked : i.value]));
  const keep = $view.dataset.hash === location.hash;
  $view.replaceChildren(...nodes);
  $view.dataset.hash = location.hash;
  if (keep) {
    for (const [id, v] of Object.entries(values)) {
      const el = document.getElementById(id);
      if (el) el.type === 'checkbox' ? (el.checked = v) : (el.value = v);
    }
    if (focused) document.getElementById(focused)?.focus();
  }
  if (live) timer = setTimeout(() => !document.hidden && mine === generation && render(), REFRESH_MS);
}

window.addEventListener('hashchange', () => {
  delete $view.dataset.hash;
  render();
  window.scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => !document.hidden && render());

// Theme: follows the system unless switched; remembered per browser.
const themeKey = 'scoop-admin-theme';
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem(themeKey)); } catch {}
document.getElementById('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(themeKey, next); } catch {}
});

// ---- Shared pieces -----------------------------------------------------------

const siteLink = (site) => h('a', { href: `#/sites/${enc(site)}`, class: 'mono' }, site);
const runLink = (id) => h('a', { href: `#/runs/${id}`, class: 'mono' }, id);
const pageLink = (url, label) => h('a', { href: `#/page?url=${enc(url)}`, class: 'mono' }, label ?? url);

function gateText(g) {
  if (!g) return '';
  return [g.decision, g.category, g.method && `(${g.method})`].filter(Boolean).join(' ');
}

const pagesCell = (r) => `${fmtInt(r.pagesNew)} new · ${fmtInt(r.pagesChanged)} chg · ${fmtInt(r.pagesUnchanged)} same${r.pagesFailed ? ` · ${r.pagesFailed} failed` : ''}`;

function runsTable(runs, { site = true } = {}) {
  return table([
    { label: 'Run', get: (r) => runLink(r.id) },
    site && { label: 'Site', get: (r) => siteLink(r.site) },
    { label: 'Status', get: (r) => pill(r.status) },
    { label: 'Gate', get: (r) => (r.forced ? 'forced' : gateText(r.gate)), cls: 'hide-sm' },
    { label: 'Path', get: (r) => r.path ?? '' },
    { label: 'Pages', get: pagesCell, cls: 'nowrap' },
    { label: 'Cost', get: (r) => fmtUsd(r.costUsd + (r.gate?.costUsd ?? 0)), cls: 'num' },
    { label: 'Started', get: (r) => time(r.startedAt), cls: 'nowrap' },
    { label: 'Took', get: (r) => duration(r.startedAt, r.finishedAt), cls: 'num' },
    { label: 'Error', get: (r) => (r.error ? h('span', { class: r.status === 'rejected' ? 'warn small' : 'err small' }, r.error) : ''), cls: 'hide-sm' },
  ].filter(Boolean), runs, 'No crawl runs yet.');
}

function pager(next, params, base) {
  const cursor = Number(params.get('cursor') ?? 0);
  const link = (c) => {
    const p = new URLSearchParams(params);
    if (c) p.set('cursor', String(c)); else p.delete('cursor');
    const qs = p.toString();
    return `${base}${qs ? `?${qs}` : ''}`;
  };
  if (!next && !cursor) return null;
  return h('div', { class: 'pager' },
    cursor ? h('a', { class: 'btn ghost sm', href: link(Math.max(0, cursor - 50)) }, '← Newer') : null,
    next ? h('a', { class: 'btn ghost sm', href: link(next) }, 'Older →') : null);
}

function crawlForm(defaults = {}) {
  const url = h('input', { id: 'crawl-url', type: 'url', class: 'wide', placeholder: 'https://docs.example.com/', required: true, value: defaults.url ?? '' });
  const max = h('input', { id: 'crawl-max', type: 'number', class: 'num', min: 1, max: 1000, value: defaults.maxPages ?? 200 });
  const force = h('input', { id: 'crawl-force', type: 'checkbox' });
  const go = h('button', { class: 'btn', type: 'submit' }, defaults.label ?? 'Start crawl');
  return h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      act(go, () => api('crawl', { method: 'POST', body: { url: url.value.trim(), maxPages: Number(max.value), force: force.checked } }),
        (r) => `Started ${r.runId} for ${r.site}`);
    },
  },
  h('label', { class: 'field' }, 'Start URL', url),
  h('label', { class: 'field' }, 'Max pages', max),
  h('label', { class: 'check' }, force, 'Skip the devtool gate'),
  go);
}

// ---- Overview ----------------------------------------------------------------

async function overview() {
  const o = await api('overview');
  const env = document.getElementById('env');
  env.textContent = o.environment;
  env.className = `env ${o.environment}`;
  env.hidden = false;
  const active = (o.runs.queued ?? 0) + (o.runs.running ?? 0);
  const s = o.sites.byStatus;
  return {
    live: active > 0 || o.batchesRunning > 0,
    nodes: [
      h('div', { class: 'head' }, h('h1', {}, 'Overview'), active ? h('span', { class: 'live' }, 'live') : null, h('span', { class: 'meta' }, `UTC day ${o.day}`)),
      card('Sites', h('div', { class: 'stats' },
        stat(fmtInt(o.sites.total), 'sites'),
        stat(fmtInt(s.ready), 'ready'),
        stat(fmtInt(o.sites.crawling), 'crawling now'),
        stat(fmtInt(s.not_devtool), 'rejected (not devtool)'),
        stat(fmtInt(s.failed), 'failed'),
        stat(fmtInt((s.empty ?? 0) + (s.blocked ?? 0) + (s.new ?? 0)), 'empty, blocked or new')),
      h('div', { class: 'row small' }, Object.entries(s).map(([k, v]) => h('a', { href: `#/sites?status=${enc(k)}` }, pill(k), ` ${v}`)))),
      card('Content', h('div', { class: 'stats' },
        stat(fmtInt(o.pages), 'pages stored'),
        stat(fmtInt(o.indexed), 'pages indexed'),
        stat(fmtInt(o.chunks), 'chunks'),
        stat(fmtInt(o.skills), 'shared skills'),
        stat(fmtInt(o.openReports), 'open reports'))),
      card('Index backlog', h('div', { class: 'stats' },
        stat(fmtInt(o.backlog.indexPending), 'waiting to be queued'),
        stat(fmtInt(o.backlog.awaitingIndex), 'not indexed at current content'),
        stat(fmtInt(o.backlog.unclassified), 'indexed unclassified'),
        stat(fmtInt(o.backlog.classifyFailed), 'classification failed')),
      h('p', { class: 'meta small' }, 'Unclassified and failed pages are picked up by the daily reclassify job (04:17 UTC).')),
      card(h('span', {}, 'Crawls ', h('a', { href: '#/crawls', class: 'small' }, 'open')), h('div', { class: 'stats' },
        stat(fmtInt(o.runs.queued), 'queued'),
        stat(fmtInt(o.runs.running), 'running'),
        stat(fmtInt(o.runs.complete), 'complete today'),
        stat(fmtInt(o.runs.rejected), 'rejected today'),
        stat(fmtInt(o.runs.failed), 'failed today'),
        stat(fmtInt(o.batchesRunning), 'batches running'))),
      card('Spend today', h('div', { class: 'stats' },
        stat(fmtUsd(o.aiSpend.totalUsd), `AI of ${fmtUsd(o.aiSpend.totalCapUsd, 2)} daily cap`, meter(o.aiSpend.totalUsd, o.aiSpend.totalCapUsd)),
        stat(fmtUsd(o.gateCostUsd), 'of which devtool gate'),
        stat(`${fmtInt(Math.round(o.e2b.seconds))} s`, 'E2B sandbox time'),
        stat(fmtUsd(o.e2b.costUsd), 'E2B cost')),
      o.secrets.openrouter ? null : h('p', { class: 'warn small' }, 'OPENROUTER_API_KEY is not set: pages are indexed unclassified and the gate cannot ask the AI.'),
      table([
        { label: 'Site', get: (r) => siteLink(r.site) },
        { label: 'AI spend', get: (r) => fmtUsd(r.costUsd), cls: 'num' },
        { label: `of ${fmtUsd(o.aiSpend.siteCapUsd, 2)} per site`, get: (r) => meter(r.costUsd, o.aiSpend.siteCapUsd) },
      ], o.aiSpend.bySite, 'No AI spend today.')),
    ],
  };
}

// ---- Crawls ------------------------------------------------------------------

async function crawls(r) {
  const status = r.params.get('status') ?? '';
  const site = r.params.get('site') ?? '';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (site) qs.set('site', site);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const [runs, batches] = await Promise.all([api(`runs?${qs}`), api('batches')]);
  const active = runs.runs.some((x) => ACTIVE.has(x.status)) || batches.batches.some((b) => b.status === 'running');

  const statusSel = h('select', { id: 'runs-status' }, ['', 'active', 'queued', 'running', 'complete', 'rejected', 'failed'].map((s) => h('option', { value: s, selected: s === status }, s || 'any status')));
  const siteIn = h('input', { id: 'runs-site', type: 'search', placeholder: 'site', value: site });
  const filter = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const p = new URLSearchParams();
      if (statusSel.value) p.set('status', statusSel.value);
      if (siteIn.value.trim()) p.set('site', siteIn.value.trim());
      location.hash = `#/crawls${p.toString() ? `?${p}` : ''}`;
    },
  }, h('label', { class: 'field' }, 'Status', statusSel), h('label', { class: 'field' }, 'Site', siteIn), h('button', { class: 'btn ghost', type: 'submit' }, 'Filter'));

  return {
    live: active,
    nodes: [
      h('div', { class: 'head' }, h('h1', {}, 'Crawls'), active ? h('span', { class: 'live' }, `refreshing every ${REFRESH_MS / 1000}s`) : null),
      card('Start a crawl', crawlForm(), h('p', { class: 'meta small' }, 'One crawl per site at a time; the devtool gate runs first unless skipped.')),
      card(h('span', {}, 'Batches ', h('a', { href: '#/seeds', class: 'small' }, 'start one from Seeds')), table([
        { label: 'Batch', get: (b) => h('a', { href: `#/batches/${b.id}`, class: 'mono' }, b.id) },
        { label: 'Status', get: (b) => pill(b.status) },
        { label: 'Progress', get: (b) => `${b.done}/${b.jobs} done · ${b.active} running`, cls: 'nowrap' },
        { label: 'Concurrency', get: (b) => b.concurrency, cls: 'num' },
        { label: 'Max pages', get: (b) => b.max_pages ?? 'per seed', cls: 'num' },
        { label: 'Started', get: (b) => time(b.created_at), cls: 'nowrap' },
      ], batches.batches, 'No batches yet.')),
      card('Runs', filter, runsTable(runs.runs), pager(runs.next, r.params, '#/crawls')),
    ],
  };
}

async function runDetail(r) {
  const id = r.parts[1];
  const d = await api(`runs/${id}`);
  const run = d.run;
  const active = ACTIVE.has(run.status);
  const cancel = h('button', {
    class: 'btn danger', type: 'button',
    onclick: (e) => confirm(`Cancel ${run.id}? Its Workflow is terminated and its sandboxes killed.`) &&
      act(e.currentTarget, () => api(`runs/${run.id}/cancel`, { method: 'POST' }), (x) => `Cancelled (${x.terminated ? 'workflow terminated' : 'no live workflow'}, ${x.sandboxes} sandboxes killed)`),
  }, 'Cancel run');
  return {
    live: active,
    nodes: [
      h('p', { class: 'crumbs' }, h('a', { href: '#/crawls' }, 'Crawls'), ' / run'),
      h('div', { class: 'head' }, h('h1', { class: 'mono' }, run.id), pill(run.status), active ? h('span', { class: 'live' }, 'live') : null, h('span', { class: 'grow' }), active ? cancel : null),
      card(null, h('dl', { class: 'kv' },
        h('dt', {}, 'Site'), h('dd', {}, siteLink(run.site)),
        h('dt', {}, 'Start URL'), h('dd', {}, ext(run.startUrl)),
        h('dt', {}, 'Path'), h('dd', {}, run.path ?? '—'),
        h('dt', {}, 'Gate'), h('dd', {}, run.forced ? 'skipped (forced by an admin)' : run.gate ? `${gateText(run.gate)} — ${run.gate.reason ?? ''}` : '—'),
        h('dt', {}, 'Pages'), h('dd', {}, `${pagesCell(run)} · ${fmtInt(run.pagesSkipped)} skipped`),
        h('dt', {}, 'Browser'), h('dd', {}, `${fmtInt(Math.round(run.browserSeconds))} s · ${fmtUsd(run.costUsd)}`),
        h('dt', {}, 'Gate AI'), h('dd', {}, fmtUsd(run.gate?.costUsd ?? 0)),
        h('dt', {}, 'Started'), h('dd', {}, run.startedAt ?? ''),
        h('dt', {}, 'Finished'), h('dd', {}, run.finishedAt ?? (active ? `running for ${duration(run.startedAt)}` : '—')),
        h('dt', {}, 'Workflow'), h('dd', {}, d.workflow ? `${d.workflow.status}${d.workflow.error ? ` — ${d.workflow.error}` : ''}` : 'expired or unknown'),
        run.error ? [h('dt', {}, 'Error'), h('dd', { class: run.status === 'rejected' ? 'warn' : 'err' }, run.error)] : null)),
      card(`Pages fetched by this run (first ${d.pages.length})`, table([
        { label: 'URL', get: (p) => pageLink(p.url), cls: 'url' },
        { label: 'Kind', get: (p) => p.kind },
        { label: 'Size', get: (p) => fmtBytes(p.bytes), cls: 'num' },
        { label: 'Changed', get: (p) => time(p.changedAt), cls: 'nowrap' },
      ], d.pages, 'No pages recorded by this run.')),
    ],
  };
}

async function batchDetail(r) {
  const id = r.parts[1];
  const { batch, jobs } = await api(`batches/${id}`);
  const running = batch.status === 'running';
  const live = running || jobs.some((j) => ACTIVE.has(j.run_status));
  const stop = (stopRuns) => h('button', {
    class: stopRuns ? 'btn danger' : 'btn ghost', type: 'button',
    onclick: (e) => confirm(stopRuns ? 'Cancel the batch and stop its running crawls?' : 'Stop starting new crawls? Running crawls finish.') &&
      act(e.currentTarget, () => api(`batches/${id}/cancel`, { method: 'POST', body: { stopRuns } }), (x) => `Batch cancelled; ${x.stopped} crawls stopped`),
  }, stopRuns ? 'Cancel and stop crawls' : 'Stop queuing');
  const count = (s) => jobs.filter((j) => j.status === s).length;
  return {
    live,
    nodes: [
      h('p', { class: 'crumbs' }, h('a', { href: '#/crawls' }, 'Crawls'), ' / batch'),
      h('div', { class: 'head' }, h('h1', { class: 'mono' }, batch.id), pill(batch.status), live ? h('span', { class: 'live' }, 'live') : null,
        h('span', { class: 'grow' }), running ? stop(false) : null, running ? stop(true) : null),
      card(null, h('div', { class: 'stats' },
        stat(`${jobs.length}`, 'jobs'),
        stat(`${count('waiting')}`, 'waiting'),
        stat(`${count('starting') + count('running')}`, `running (max ${batch.concurrency})`),
        stat(`${count('complete')}`, 'complete'),
        stat(`${count('rejected')}`, 'rejected'),
        stat(`${count('failed') + count('error')}`, 'failed or error'),
        stat(`${count('cancelled')}`, 'cancelled')),
      h('p', { class: 'meta small' }, `Max pages: ${batch.max_pages ?? 'per seed'} · gate ${batch.force ? 'skipped' : 'on'} · started ${batch.created_at}${batch.finished_at ? ` · ended ${batch.finished_at}` : ''}`)),
      card('Jobs', table([
        { label: '#', get: (j) => j.ord + 1, cls: 'num' },
        { label: 'Seed', get: (j) => j.name },
        { label: 'Site', get: (j) => siteLink(j.site) },
        { label: 'Job', get: (j) => pill(j.status) },
        { label: 'Run', get: (j) => (j.run_id ? h('span', { class: 'row' }, runLink(j.run_id), j.run_status ? pill(j.run_status) : null) : '') },
        { label: 'Path', get: (j) => j.run_path ?? '' },
        { label: 'Pages', get: (j) => (j.run_pages == null ? '' : fmtInt(j.run_pages)), cls: 'num' },
        { label: 'Tries', get: (j) => j.attempts, cls: 'num' },
        { label: 'Note', get: (j) => (j.error || j.run_error ? h('span', { class: 'small muted' }, j.error ?? j.run_error) : ''), cls: 'hide-sm' },
      ], jobs)),
    ],
  };
}

// ---- Seeds -------------------------------------------------------------------

async function seeds() {
  const { seeds: list } = await api('seeds');
  const boxes = list.map((s, i) => h('input', { type: 'checkbox', id: `seed-${i}`, 'data-url': s.startUrl, 'aria-label': `Select ${s.name}` }));
  const all = h('input', { type: 'checkbox', id: 'seed-all', 'aria-label': 'Select all', onchange: (e) => boxes.forEach((b) => (b.checked = e.target.checked)) });
  const conc = h('input', { id: 'batch-conc', type: 'number', class: 'num', min: 1, max: 8, value: 4 });
  const max = h('input', { id: 'batch-max', type: 'number', class: 'num', min: 1, max: 1000, placeholder: 'per seed' });
  const force = h('input', { id: 'batch-force', type: 'checkbox' });
  const start = (everything) => async (e) => {
    const picked = boxes.filter((b) => b.checked).map((b) => b.dataset.url);
    if (!everything && !picked.length) return toast('Select some seeds first', true);
    const n = everything ? list.length : picked.length;
    if (!confirm(`Start a batch of ${n} crawls, ${conc.value} at a time?`)) return;
    const body = { concurrency: Number(conc.value), force: force.checked, ...(max.value ? { maxPages: Number(max.value) } : {}), ...(everything ? {} : { startUrls: picked }) };
    const res = await act(e.currentTarget, () => api('batches', { method: 'POST', body }), (x) => `Batch ${x.batchId}: ${x.jobs} jobs`);
    if (res) location.hash = `#/batches/${res.batchId}`;
  };
  return [
    h('div', { class: 'head' }, h('h1', {}, 'Seeds'), h('span', { class: 'meta' }, `${list.length} sites from seeds/devtools.json`)),
    card('Start a batch',
      h('div', { class: 'form' },
        h('label', { class: 'field' }, 'Concurrency (1–8)', conc),
        h('label', { class: 'field' }, 'Max pages', max),
        h('label', { class: 'check' }, force, 'Skip the devtool gate'),
        h('button', { class: 'btn', type: 'button', onclick: start(false) }, 'Crawl selected'),
        h('button', { class: 'btn ghost', type: 'button', onclick: start(true) }, 'Crawl all')),
      h('p', { class: 'meta small' }, 'The batch runs on the server (CrawlBatch Workflow): you can close this page. A busy site (409) is retried a minute later.')),
    card(null, table([
      { label: h('label', { class: 'check' }, all, 'All'), get: (s) => boxes[list.indexOf(s)] },
      { label: 'Seed', get: (s) => s.name },
      { label: 'Site', get: (s) => siteLink(s.site) },
      { label: 'Start URL', get: (s) => ext(s.startUrl), cls: 'url hide-sm' },
      { label: 'Max', get: (s) => s.maxPages, cls: 'num' },
      { label: 'Status', get: (s) => h('span', { class: 'row' }, s.status ? pill(s.status) : h('span', { class: 'meta' }, 'never crawled'), s.crawling ? pill('crawling') : null) },
      { label: 'Pages', get: (s) => fmtInt(s.pagesFetched), cls: 'num' },
      { label: 'Last crawl', get: (s) => time(s.lastCrawledAt), cls: 'nowrap' },
    ], list)),
  ];
}

// ---- Sites -------------------------------------------------------------------

async function sites(r) {
  const status = r.params.get('status') ?? '';
  const q = r.params.get('q') ?? '';
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (q) qs.set('q', q);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const d = await api(`sites?${qs}`);
  const statusSel = h('select', { id: 'sites-status' }, ['', 'ready', 'crawling', 'not_devtool', 'failed', 'empty', 'blocked', 'new'].map((s) => h('option', { value: s, selected: s === status }, s || 'any status')));
  const qIn = h('input', { id: 'sites-q', type: 'search', placeholder: 'filter by name', value: q });
  return {
    live: d.sites.some((s) => s.crawling),
    nodes: [
      h('div', { class: 'head' }, h('h1', {}, 'Sites')),
      card(null,
        h('form', {
          onsubmit: (e) => {
            e.preventDefault();
            const p = new URLSearchParams();
            if (statusSel.value) p.set('status', statusSel.value);
            if (qIn.value.trim()) p.set('q', qIn.value.trim());
            location.hash = `#/sites${p.toString() ? `?${p}` : ''}`;
          },
        }, h('label', { class: 'field' }, 'Status', statusSel), h('label', { class: 'field' }, 'Site', qIn), h('button', { class: 'btn ghost', type: 'submit' }, 'Filter')),
        table([
          { label: 'Site', get: (s) => siteLink(s.site) },
          { label: 'Status', get: (s) => h('span', { class: 'row' }, pill(s.status), s.crawling ? pill('crawling') : null) },
          { label: 'Gate', get: (s) => (s.gate ? `${s.gate.category ?? ''} (${s.gate.method})` : ''), cls: 'hide-sm' },
          { label: 'Pages', get: (s) => fmtInt(s.pages), cls: 'num' },
          { label: 'Indexed', get: (s) => fmtInt(s.indexed), cls: 'num' },
          { label: 'llms.txt', get: (s) => (s.hasLlms ? 'yes' : ''), cls: 'hide-sm' },
          { label: 'Last crawl', get: (s) => (s.lastRun ? h('span', { class: 'row' }, time(s.lastRun.startedAt), pill(s.lastRun.status)) : ''), cls: 'nowrap' },
        ], d.sites, 'No sites match.'),
        pager(d.next, r.params, '#/sites')),
    ],
  };
}

function topicTreeView(nodes, site) {
  if (!nodes.length) return h('p', { class: 'empty' }, 'No topics yet (pages are unclassified or not indexed).');
  const list = (ns) => h('ul', {}, ns.map((n) => h('li', {},
    h('a', { href: `#/sites/${enc(site)}?topic=${enc(n.path)}` }, n.name), h('span', { class: 'count' }, String(n.count)),
    n.children.length ? list(n.children) : null)));
  return h('div', { class: 'tree' }, list(nodes));
}

async function siteDetail(r) {
  const site = r.parts[1];
  const topic = r.params.get('topic') ?? '';
  const qs = new URLSearchParams();
  if (topic) qs.set('topic', topic);
  if (r.params.get('cursor')) qs.set('cursor', r.params.get('cursor'));
  const [d, pages] = await Promise.all([api(`sites/${enc(site)}`), api(`sites/${enc(site)}/pages?${qs}`)]);
  const p = d.profile;
  const active = p?.crawling || d.runs.some((x) => ACTIVE.has(x.status));
  const startUrl = d.runs[0]?.startUrl ?? `https://${site}/`;
  return {
    live: active,
    nodes: [
      h('p', { class: 'crumbs' }, h('a', { href: '#/sites' }, 'Sites'), ' / site'),
      h('div', { class: 'head' }, h('h1', { class: 'mono' }, site), p ? pill(p.status) : null, p?.crawling ? pill('crawling') : null,
        h('span', { class: 'grow' }),
        h('a', { class: 'btn ghost sm', href: `#/agent?site=${enc(site)}` }, 'Agent view'),
        h('a', { class: 'btn ghost sm', href: `#/library/${enc(site)}` }, 'Shared skills')),
      card('Re-crawl', crawlForm({ url: startUrl, maxPages: p?.pagesFetched ? Math.min(1000, Math.max(50, p.pagesFetched)) : 200, label: 'Re-crawl' })),
      h('div', { class: 'cols' },
        card('Profile', p ? h('dl', { class: 'kv' },
          h('dt', {}, 'Docs root'), h('dd', { class: 'mono' }, p.docsRoot ?? '—'),
          h('dt', {}, 'llms.txt'), h('dd', {}, p.llmsUrl ? ext(p.llmsUrl) : 'no'),
          h('dt', {}, 'llms-full.txt'), h('dd', {}, p.llmsFullUrl ? ext(p.llmsFullUrl) : 'no'),
          h('dt', {}, '.md twins'), h('dd', {}, p.mdTwinsRatio == null ? '—' : `${Math.round(p.mdTwinsRatio * 100)}% (${p.twinPattern ?? ''})`),
          h('dt', {}, 'Sitemap URLs'), h('dd', {}, fmtInt(p.sitemapUrlsCount)),
          h('dt', {}, 'Needs browser'), h('dd', {}, p.needsBrowser ? 'yes' : 'no'),
          h('dt', {}, 'Crawl delay'), h('dd', {}, p.crawlDelay == null ? '—' : `${p.crawlDelay}s`),
          h('dt', {}, 'OpenAPI'), h('dd', {}, p.openapi?.length ? p.openapi.map((u) => h('div', {}, ext(u))) : '—'),
          h('dt', {}, 'Gate'), h('dd', {}, p.gate ? `${p.gate.category ?? ''} (${p.gate.method}${p.gate.confidence != null ? `, ${p.gate.confidence}` : ''}) — ${p.gate.reason ?? ''}` : '—'),
          h('dt', {}, 'Last crawled'), h('dd', {}, p.lastCrawledAt ?? '—'),
        ) : h('p', { class: 'empty' }, 'No profile (indexed by hand only).')),
        card('Counts', h('div', { class: 'stats' },
          stat(fmtInt(d.counts.pages), 'pages'),
          stat(fmtInt(d.counts.indexed), 'indexed'),
          stat(fmtInt(d.counts.indexPending), 'waiting to queue'),
          stat(fmtInt(d.counts.chunks), 'chunks'),
          stat(fmtInt(d.counts.skills), 'shared skills'),
          stat(fmtUsd(d.counts.classifyUsd), 'classification spend'))),
        card('Topics', topicTreeView(d.topics, site))),
      card(h('span', {}, topic ? ['Pages under ', h('code', {}, topic), ' ', h('a', { href: `#/sites/${enc(site)}`, class: 'small' }, 'all pages')] : 'Pages'),
        table([
          { label: 'Page', get: (x) => h('div', {}, pageLink(x.url, x.title || x.url), x.title ? h('div', { class: 'meta small mono' }, x.url) : null), cls: 'url' },
          { label: 'Slot', get: (x) => x.slot ?? '' },
          { label: 'Topic', get: (x) => (x.topic ? h('code', {}, x.topic) : ''), cls: 'hide-sm' },
          { label: 'Summary', get: (x) => h('span', { class: 'small' }, x.summary ?? ''), cls: 'hide-sm' },
          { label: 'Model', get: (x) => (x.indexed ? h('span', { class: x.current ? '' : 'warn' }, `${x.model}${x.current ? '' : ' (stale)'}`) : h('span', { class: 'meta' }, x.indexPending ? 'queued' : 'not indexed')) },
          { label: 'Cost', get: (x) => (x.costUsd ? fmtUsd(x.costUsd, 5) : ''), cls: 'num' },
          { label: 'Size', get: (x) => fmtBytes(x.bytes), cls: 'num' },
        ], pages.pages, 'No pages.'),
        pager(pages.next, r.params, `#/sites/${enc(site)}`)),
      card('Crawl history', runsTable(d.runs, { site: false })),
    ],
  };
}

// ---- Page --------------------------------------------------------------------

async function pageDetail(r) {
  const url = r.params.get('url') ?? '';
  const d = await api(`page?url=${enc(url)}`);
  const l = d.labels;
  const site = d.page?.site;
  return [
    h('p', { class: 'crumbs' }, h('a', { href: '#/sites' }, 'Sites'), site ? [' / ', h('a', { href: `#/sites/${enc(site)}` }, site)] : null, ' / page'),
    h('div', { class: 'head' }, h('h1', {}, l?.title || d.page?.title || 'Page')),
    h('p', {}, ext(d.url)),
    h('div', { class: 'cols' },
      card('Stored', d.page ? h('dl', { class: 'kv' },
        h('dt', {}, 'Source'), h('dd', {}, ext(d.page.source_url)),
        h('dt', {}, 'Kind'), h('dd', {}, d.page.source_kind),
        h('dt', {}, 'Hash'), h('dd', { class: 'mono' }, d.page.content_hash),
        h('dt', {}, 'Size'), h('dd', {}, fmtBytes(d.page.bytes)),
        h('dt', {}, 'Fetched'), h('dd', {}, d.page.fetched_at),
        h('dt', {}, 'Changed'), h('dd', {}, d.page.changed_at),
        h('dt', {}, 'Run'), h('dd', {}, runLink(d.page.run_id)),
        h('dt', {}, 'Index queue'), h('dd', {}, d.page.index_pending ? 'waiting to be sent' : 'sent'),
      ) : h('p', { class: 'empty' }, 'Indexed by hand (no crawl record).')),
      card('AI labels', l ? h('dl', { class: 'kv' },
        h('dt', {}, 'Slot'), h('dd', {}, l.slot),
        h('dt', {}, 'Topic'), h('dd', {}, h('code', {}, l.topicPath.join(' / ') || '—')),
        h('dt', {}, 'Summary'), h('dd', {}, l.summary || '—'),
        h('dt', {}, 'Tasks'), h('dd', {}, l.tasks.length ? h('ul', { class: 'plain' }, l.tasks.map((t) => h('li', {}, t))) : '—'),
        h('dt', {}, 'Entities'), h('dd', {}, l.entities.length ? l.entities.map((e) => h('div', {}, h('span', { class: 'meta' }, `${e.kind} `), h('code', {}, e.name))) : '—'),
        h('dt', {}, 'Model'), h('dd', {}, `${l.model}${l.attempts ? ` (${l.attempts} failed attempts)` : ''}`),
        h('dt', {}, 'Cost'), h('dd', {}, fmtUsd(l.costUsd, 5)),
        h('dt', {}, 'Indexed'), h('dd', {}, `${l.indexedAt}${l.current ? '' : ' — older content than stored'}`),
      ) : h('p', { class: 'empty' }, 'Not indexed yet.'))),
    card(h('span', {}, 'Stored Markdown ', h('code', { class: 'small meta' }, d.markdownKey)),
      d.markdown === null ? h('p', { class: 'err' }, 'The R2 object is missing.') : markdownBlock(d.markdown),
      d.truncated ? h('p', { class: 'warn small' }, 'Shown truncated.') : null),
    card(`Chunks (${d.chunks.length})`, d.chunks.length
      ? d.chunks.map((c) => h('div', { class: 'chunk' }, h('div', { class: 'meta small' }, `#${c.ord} · ${c.heading_path} · `, h('code', {}, c.id)), (() => { const p = h('pre', { class: 'md short' }); p.textContent = c.text; return p; })()))
      : h('p', { class: 'empty' }, 'No chunks.')),
  ];
}

// ---- Agent view --------------------------------------------------------------

async function agent(r) {
  const site = r.params.get('site') ?? '';
  const q = r.params.get('q') ?? '';
  const topic = r.params.get('topic') ?? '';
  const budget = r.params.get('budget') ?? '';
  const siteIn = h('input', { id: 'ag-site', type: 'text', placeholder: 'docs.example.com', value: site, required: true });
  const qIn = h('input', { id: 'ag-q', type: 'search', class: 'wide', placeholder: 'verify webhook signature', value: q });
  const topicIn = h('input', { id: 'ag-topic', type: 'text', placeholder: 'or a topic, e.g. webhooks/signatures', value: topic });
  const budgetIn = h('input', { id: 'ag-budget', type: 'number', class: 'num', min: 2000, max: 400000, step: 1000, placeholder: '60000', value: budget });
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const p = new URLSearchParams({ site: siteIn.value.trim() });
      if (qIn.value.trim()) p.set('q', qIn.value.trim());
      if (topicIn.value.trim()) p.set('topic', topicIn.value.trim());
      if (budgetIn.value) p.set('budget', budgetIn.value);
      location.hash = `#/agent?${p}`;
    },
  },
  h('label', { class: 'field' }, 'Site', siteIn),
  h('label', { class: 'field' }, 'Search query', qIn),
  h('label', { class: 'field' }, 'Topic', topicIn),
  h('label', { class: 'field' }, 'Budget (chars)', budgetIn),
  h('button', { class: 'btn', type: 'submit' }, 'Preview'));

  const out = [
    h('div', { class: 'head' }, h('h1', {}, 'What the agent gets')),
    card(null, form, h('p', { class: 'meta small' }, 'Search is GET /v1/search; the package is GET /v1/packages (by query, or by topic when one is given). The shared skill the extension copies is in the Shared library.')),
  ];
  if (!site || (!q && !topic)) return out;

  const pq = new URLSearchParams({ site });
  if (topic) pq.set('topic', topic); else pq.set('q', q);
  if (budget) pq.set('budget', budget);
  const [hits, pkg] = await Promise.allSettled([
    q ? api(`search?${new URLSearchParams({ site, q, limit: '10' })}`) : Promise.resolve(null),
    api(`package?${pq}`),
  ]);
  if (hits.status === 'fulfilled' && hits.value) {
    out.push(card(`Search hits (${hits.value.hits.length})`, hits.value.hits.length
      ? hits.value.hits.map((x, i) => h('div', { class: 'chunk' },
        h('div', { class: 'row' }, h('b', {}, `${i + 1}.`), pageLink(x.url, x.title || x.url), h('span', { class: 'pill' }, x.slot), h('span', { class: 'meta small' }, `score ${x.score.toFixed(4)}`)),
        h('div', { class: 'meta small' }, x.heading_path, x.topic_path?.length ? [' · ', h('code', {}, x.topic_path.join('/'))] : null),
        h('p', { class: 'small' }, x.snippet)))
      : h('p', { class: 'empty' }, 'No hits.')));
  } else if (hits.status === 'rejected') {
    out.push(card('Search hits', h('p', { class: 'err' }, hits.reason.message)));
  }
  out.push(pkg.status === 'fulfilled'
    ? card(h('span', {}, 'Package ', h('span', { class: 'meta small' }, `${pkg.value.chunks} chunks considered · budget ${fmtInt(pkg.value.budget)}`)), markdownBlock(pkg.value.markdown, { label: 'Copy package' }))
    : card('Package', h('p', { class: pkg.reason.status === 404 ? 'meta' : 'err' }, pkg.reason.message)));
  return out;
}

// ---- Shared library ----------------------------------------------------------

const votes = (s) => h('span', { class: 'nowrap' }, h('span', { class: 'ok' }, `▲ ${s.worked}`), ' ', h('span', { class: 'err' }, `▼ ${s.failed}`));

async function library(r) {
  const d = await api(`library${r.params.get('cursor') ? `?cursor=${enc(r.params.get('cursor'))}` : ''}`);
  return [
    h('div', { class: 'head' }, h('h1', {}, 'Shared library')),
    card(`Open reports (${d.reports.length})`, table([
      { label: 'Reported', get: (x) => time(x.createdAt), cls: 'nowrap' },
      { label: 'Skill', get: (x) => h('a', { href: `#/skills/${enc(x.skillId)}`, class: 'mono' }, x.skillId) },
      { label: 'Site', get: (x) => (x.site ? siteLink(x.site) : '') },
      { label: 'Reason', get: (x) => h('span', { class: 'pill' }, x.reason) },
      { label: 'Details', get: (x) => h('span', { class: 'small' }, x.details ?? '') },
      { label: 'Skill state', get: (x) => (x.skillRemoved ? pill('removed') : 'live') },
    ], d.reports, 'No open reports.')),
    card('Sites with shared skills', table([
      { label: 'Site', get: (x) => h('a', { href: `#/library/${enc(x.site)}`, class: 'mono' }, x.site) },
      { label: 'Live / total', get: (x) => `${x.live} / ${x.total}`, cls: 'num' },
      { label: 'Votes', get: votes },
      { label: 'Best', get: (x) => (x.best ? h('a', { href: `#/skills/${enc(x.best.id)}` }, x.best.title || x.best.id) : h('span', { class: 'meta' }, 'none qualifies')) },
      { label: 'Last shared', get: (x) => time(x.lastSharedAt), cls: 'nowrap' },
    ], d.sites, 'No skills shared yet.'), pager(d.next, r.params, '#/library')),
  ];
}

function skillRows(list) {
  return table([
    { label: 'Skill', get: (s) => h('a', { href: `#/skills/${enc(s.id)}` }, s.title || s.id) },
    { label: 'Page', get: (s) => ext(s.pageUrl), cls: 'url hide-sm' },
    { label: 'Votes', get: votes },
    { label: 'Sources', get: (s) => s.sources.map((x) => h('div', { class: 'small' }, h('span', { class: 'meta' }, `${x.kind} `), ext(x.url, x.label))), cls: 'hide-sm' },
    { label: 'Size', get: (s) => fmtBytes(s.sizeBytes), cls: 'num' },
    { label: 'Shared', get: (s) => time(s.createdAt), cls: 'nowrap' },
  ], list);
}

async function librarySite(r) {
  const site = r.parts[1];
  const d = await api(`library/${enc(site)}`);
  return [
    h('p', { class: 'crumbs' }, h('a', { href: '#/library' }, 'Shared library'), ' / site'),
    h('div', { class: 'head' }, h('h1', { class: 'mono' }, site), h('span', { class: 'grow' }), h('a', { class: 'btn ghost sm', href: `#/sites/${enc(site)}` }, 'Crawl data')),
    card('Best skill (what the extension gets first)', d.best ? skillRows([d.best]) : h('p', { class: 'empty' }, 'No skill qualifies yet.')),
    card(`Recent skills (${d.recent.length})`, skillRows(d.recent)),
    d.removed.length ? card(`Taken down (${d.removed.length})`, table([
      { label: 'Skill', get: (s) => h('a', { href: `#/skills/${enc(s.id)}`, class: 'mono' }, s.id) },
      { label: 'Title', get: (s) => s.title },
      { label: 'Removed', get: (s) => time(s.removed_at), cls: 'nowrap' },
    ], d.removed)) : null,
  ];
}

async function skillDetail(r) {
  const id = r.parts[1];
  const d = await api(`skills/${enc(id)}`);
  const s = d.skill;
  const takedown = h('button', {
    class: 'btn danger', type: 'button',
    onclick: (e) => confirm(`Take down ${s.id}? Its content is deleted; the record stays for audit.`) &&
      act(e.currentTarget, () => api(`skills/${enc(s.id)}`, { method: 'DELETE' }), 'Skill taken down'),
  }, 'Take down');
  return [
    h('p', { class: 'crumbs' }, h('a', { href: '#/library' }, 'Shared library'), ' / ', h('a', { href: `#/library/${enc(s.site)}` }, s.site), ' / skill'),
    h('div', { class: 'head' }, h('h1', {}, s.title || s.id), s.removedAt ? pill('removed') : null, h('span', { class: 'grow' }), s.removedAt ? null : takedown),
    card(null, h('dl', { class: 'kv' },
      h('dt', {}, 'ID'), h('dd', { class: 'mono' }, s.id),
      h('dt', {}, 'Page'), h('dd', {}, ext(s.pageUrl)),
      h('dt', {}, 'Votes'), h('dd', {}, votes(s), s.lastWorkedAt ? h('span', { class: 'meta' }, ` · last worked ${fmtTime(s.lastWorkedAt)}`) : null),
      h('dt', {}, 'Shared'), h('dd', {}, s.createdAt),
      s.removedAt ? [h('dt', {}, 'Removed'), h('dd', { class: 'err' }, s.removedAt)] : null,
      h('dt', {}, 'Sources'), h('dd', {}, s.sources.map((x) => h('div', {}, h('span', { class: 'meta' }, `${x.kind} · ${x.label} `), ext(x.url)))))),
    card(h('span', {}, 'Package the extension copies ', h('span', { class: 'meta small' }, '(on the skill\'s own page; built by extension/lib/package.js)')),
      d.package === null ? h('p', { class: 'empty' }, 'Content removed.') : markdownBlock(d.package, { label: 'Copy package' })),
    s.relatedLinks?.length ? card(`Related links (${s.relatedLinks.length})`, h('ul', { class: 'plain' }, s.relatedLinks.map((l) => h('li', {}, ext(l.url, l.text || l.url))))) : null,
    card(`Reports (${d.reports.length})`, table([
      { label: 'Reported', get: (x) => time(x.createdAt), cls: 'nowrap' },
      { label: 'Reason', get: (x) => h('span', { class: 'pill' }, x.reason) },
      { label: 'Details', get: (x) => x.details ?? '' },
      { label: 'Resolved', get: (x) => x.resolvedAt ?? '' },
    ], d.reports, 'No reports.')),
  ].filter(Boolean);
}

// ---- Costs -------------------------------------------------------------------

async function costs() {
  const d = await api('costs?days=14');
  const total = (k) => d.days.reduce((n, x) => n + x[k], 0);
  return [
    h('div', { class: 'head' }, h('h1', {}, 'Costs'), h('span', { class: 'meta' }, 'last 14 UTC days')),
    card(null, h('div', { class: 'stats' },
      stat(fmtUsd(total('aiUsd'), 2), 'AI (classifier + gate)'),
      stat(fmtUsd(total('gateUsd'), 2), 'of which gate'),
      stat(fmtUsd(total('e2bUsd'), 2), 'E2B sandboxes'),
      stat(fmtInt(total('runs')), 'crawl runs')),
    h('p', { class: 'meta small' }, `Caps per UTC day: ${fmtUsd(d.siteCapUsd, 2)} per site, ${fmtUsd(d.totalCapUsd, 2)} in total (AI only).`)),
    card('By day', table([
      { label: 'Day', get: (x) => x.day, cls: 'nowrap mono' },
      { label: 'AI', get: (x) => fmtUsd(x.aiUsd), cls: 'num' },
      { label: 'Cap', get: (x) => meter(x.aiUsd, d.totalCapUsd) },
      { label: 'Gate', get: (x) => fmtUsd(x.gateUsd), cls: 'num' },
      { label: 'E2B', get: (x) => `${fmtUsd(x.e2bUsd)} · ${fmtInt(Math.round(x.browserSeconds))}s`, cls: 'num' },
      { label: 'Runs', get: (x) => x.runs, cls: 'num' },
      { label: 'Top sites (AI)', get: (x) => x.sites.slice(0, 4).map((s) => h('div', { class: 'small' }, siteLink(s.site), ` ${fmtUsd(s.costUsd)}`)), cls: 'hide-sm' },
    ], d.days)),
  ];
}

render();
