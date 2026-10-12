import { fetchPublicText, siteKey } from './lib/discover.js';
import { buildOverviewPackage, buildPagePackage, packageMeta, tokenEstimate, verifyLlms, withCurrentPage } from './lib/package.js';
import { scoopPage, currentPageSection, isPrivateHost } from './lib/scoop.js';
import { DEFAULT_LIBRARY, libraryUrl, createLibrary, shareBody, notSharedReason, withoutSectionQuery } from './lib/library.js';
import { createTelemetry, docsLike, getInstallId, NOTICE_KEY, pagePath, errorText, setTelemetry, telemetryEnabled } from './lib/telemetry.js';
import { registrableDomain } from './lib/hosts.js';
import { forgetCrawl, isTerminal, loadPending, progressText, rememberCrawl } from './lib/crawl.js';
import { compactCount, rememberVerdict, setTabBadge } from './lib/badge.js';
import { withLiveLinks } from './lib/links.js';
import { logStage, reducedMotion, sleep, timing } from './lib/ux.js';

const DEFAULTS = { share: true };
const $ = (id) => document.getElementById(id);

let settings;
let library;
let devLibrary = false;
let tab;
let clipboardText = '';
let skillId = null;
let libraryOptions;
// Usage statistics (lib/telemetry.js); `current` is the scoop in progress.
const telemetry = createTelemetry();
const openedAt = Date.now();
let current = null;
// The site's place in the docs index ({ site, index, pending, pagePublic, quick }),
// and the crawl adding it in the background, for the Overview and Search tabs.
let siteInfo = null;
let background = null;
const track = (name, props) => telemetry.track(name, props);
const sizeOf = (text) => new TextEncoder().encode(text).length;

function status(text, cls = 'ok') {
  $('status').textContent = text;
  $('status').className = cls;
}

function note(id, text, cls = '') {
  $(id).textContent = text;
  $(id).className = cls;
  $(id).hidden = !text;
}

async function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function showFeedback(id) {
  skillId = id;
  $('feedback').hidden = !id;
  $('voted').hidden = true;
  $('report').hidden = true;
}

// The async clipboard API refuses unfocused documents (e.g. the user clicked
// away while we were scooping). execCommand works there because the extension
// has clipboardWrite. Returns whether the text reached the clipboard.
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text, className: 'offscreen' });
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    getSelection()?.removeAllRanges();
    return ok;
  }
}

async function copy(text) {
  clipboardText = text;
  $('preview').value = text;
  $('copy').disabled = false;
  return writeClipboard(text);
}

// Clicking the text selects all of it, for people who prefer to copy by hand.
$('preview').onfocus = () => $('preview').select();

// Success shows on the Copy button ("Copied ✓" for 2 s) and in the copied
// moment; the status line says it to screen readers.
function copied(ok) {
  if (ok) {
    status('Copied to your clipboard.');
  } else {
    status('Click Copy to put it on your clipboard.', 'err');
  }
}
let copiedTimer = null;
function flashCopied() {
  $('copy-label').textContent = 'Copied ✓';
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { $('copy-label').textContent = 'Copy'; }, timing.copiedLabelMs);
}

// The token count is the headline, the size beside it; where it came from is
// in the label for screen readers and the tooltip.
function showUsage(text, source = '') {
  $('usage').hidden = !text;
  if (!text) return;
  $('tokens').textContent = tokenEstimate(text);
  $('size').textContent = kb(text);
  const label = `About ${tokenEstimate(text).replace(/^~/, '')}, ${kb(text)}${source ? `, ${source}` : ''}`;
  $('usage').setAttribute('aria-label', label);
  $('usage').title = source;
}

const kb = (text) => `${Math.max(1, Math.round(text.length / 1024))} KB`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function tabHtml() {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });
    return result;
  } catch {
    return null; // Pages like the Chrome Web Store can't be scripted.
  }
}

function scoopCurrentTab() {
  return scoopPage(tab.url, {
    title: tab.title,
    parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
    tabHtml,
    allowPrivateHosts: devLibrary, // a local library can verify local pages
  });
}

const DOCS_SOURCES = new Set(['page-md', 'llms', 'llms-full']);

// One scoop_result per scoop, and what the events about it may say:
// - the hostname when the page was public or the library has the site; for a
//   signed-in page only its registrable domain (acme.atlassian.net → atlassian.net);
// - the path only when the scoop found a docs source (.md, llms.txt) or the page
//   is public HTML that looks like docs, with secret-looking segments redacted.
function scoopResult(outcome, { scoop, text, sections = [], shared = null, indexed = false, clipboard } = {}) {
  if (!current || current.done) return;
  current.done = true;
  const isPublic = Boolean(scoop?.isPublic);
  const publicSite = isPublic || Boolean(shared) || indexed;
  const docsSource = (scoop?.sections ?? []).some((s) => DOCS_SOURCES.has(s.kind));
  // Later events about this scoop (copy, share, vote) say the same.
  current.site = publicSite ? current.siteKey : registrableDomain(current.siteKey);
  // A page judged not developer docs has no path, even if the site serves an llms.txt.
  current.path = publicSite && verdict.state !== 'no' && (docsSource || (isPublic && docsLike(tab.url))) ? pagePath(tab.url) : undefined;
  track('scoop_result', {
    site: current.site,
    path: current.path,
    outcome,
    sourceKinds: indexed ? ['index'] : [...new Set(sections.map((s) => s.kind))],
    sources: sections.length,
    sizeBytes: text ? sizeOf(text) : 0,
    truncated: Boolean(text && (sections.some((s) => s.content == null) || /\[(Truncated\. The full text|Omitted for length\.)/.test(text))),
    durationMs: Date.now() - current.started,
    libraryHit: Boolean(shared),
    indexHit: indexed,
    libraryWorked: shared?.worked ?? undefined,
    isPublic,
    relatedLinks: (shared ? shared.relatedLinks : scoop?.relatedLinks)?.length ?? 0,
    clipboard,
  });
}

// Stages (body[data-stage]): loading → copied → content, or loading → waiting.
// In 'content', the active tab's panel shows (This page, Overview or Search).
const PANELS = { page: 'content', overview: 'overview', search: 'search' };
let activeTab = 'page';
function setStage(name) {
  document.body.dataset.stage = name;
  logStage(name);
  $('loader').hidden = name !== 'loading';
  $('copied-stage').hidden = name !== 'copied';
  $('tabs').hidden = name !== 'content';
  for (const [t, id] of Object.entries(PANELS)) $(id).hidden = name !== 'content' || t !== activeTab;
}

// The loader stays at least timing.loaderMs, so a fast scoop doesn't flicker.
let loaderShownAt = 0;
function showLoader() {
  loaderShownAt = Date.now();
  $('content').classList.remove('reveal');
  setStage('loading');
}
const loaderDone = () => sleep(Math.max(0, loaderShownAt + timing.loaderMs - Date.now()));

// After the copy: the "copied" moment, then the content. Never before the copy.
async function revealAfterCopy(ok) {
  await loaderDone();
  if (ok) {
    const reduced = reducedMotion();
    document.body.dataset.motion = reduced ? 'reduced' : 'full';
    setStage('copied');
    if (!current?.private) track('copied_animation_shown', { reducedMotion: reduced });
    await sleep(reduced ? timing.reducedMs : timing.celebrateMs);
  }
  reveal();
  if (ok && activeTab === 'page') flashCopied();
}

// Clears the live region first, so the same message twice is announced twice.
let announcing = null;
function announce(text) {
  $('announce').textContent = '';
  clearTimeout(announcing);
  announcing = setTimeout(() => { $('announce').textContent = text; }, ANNOUNCE_DELAY_MS);
}
const ANNOUNCE_DELAY_MS = 50;

// The content, announced with the status line, and focus on the Copy button
// (on the Overview and Search tabs, their own status line and button).
function reveal() {
  if (verdict.state === 'checking') setChip(devDocs(siteInfo?.index, siteInfo?.quick, null));
  setStage('content');
  const panel = $(PANELS[activeTab]);
  panel.classList.remove('reveal');
  void panel.offsetWidth;
  panel.classList.add('reveal');
  if (activeTab === 'page') {
    announce(`${$('status').textContent} ${$('devdocs').getAttribute('aria-label')}.`.replace('..', '.'));
    if (!$('copy').disabled) $('copy').focus();
  } else {
    const id = activeTab === 'overview' ? 'overview-status' : 'search-status';
    announce($(id).textContent);
    $(activeTab === 'overview' ? 'copy-overview' : 'copy-selected').focus();
  }
}

// Copies and records the scoop; returns whether the clipboard took it.
async function copyAndRecord({ text, summary, scoop = null, sections = [], shared = null, indexed = false }) {
  const ok = await copy(text);
  copied(ok);
  scoopResult('copied_ready', { scoop, text, sections, shared, indexed, clipboard: ok });
  if (ok) track('copy', { site: current.site, path: current.path, sizeBytes: sizeOf(text), trigger: 'auto' });
  showUsage(text, summary);
  return ok;
}

const deliver = async (pkg) => revealAfterCopy(await copyAndRecord(pkg));

async function deliverShared(shared, scoop) {
  const site = siteKey(tab.url);
  const sections = withCurrentPage(shared.sections, currentPageSection(scoop), tab.url);
  const text = await composePage({ site, scoop, sections, relatedLinks: shared.relatedLinks ?? [] });
  $('rebuild').hidden = false;
  showFeedback(shared.id);
  return deliver({ text, scoop, sections, shared, summary: `shared, worked for ${plural(shared.worked, 'person', 'people')}` });
}

// The page package (lib/package.js buildPagePackage): a verified llms.txt is
// linked, not included; the site's instructions for agents (from /quick); the
// page content; five confirmed related pages. Every link is checked first
// (lib/links.js): bad or unconfirmed ones are unlinked, inside the loader's
// time. The library is asked only when it is reachable and sharing is on.
async function composePage({ site, scoop, sections, relatedLinks = [], title = null, pageUrl = null }) {
  const { llms, llmsFull } = llmsFiles(sections);
  const pages = sections.filter((s) => s.kind !== 'llms' && s.kind !== 'llms-full');
  // Link addresses leave the device only for public pages: to the library
  // (sharing on) and as HEAD requests to the page's own site and its sources.
  const pagePublic = Boolean(siteInfo?.pagePublic);
  const docs = verdict.state !== 'no';
  const live = await withLiveLinks({ sections: pages, relatedLinks, instructions: docs ? siteInstructions() : [] }, {
    library,
    useBackend: Boolean(settings.share && siteInfo?.libraryUp && pagePublic),
    direct: pagePublic,
    pageUrl: pageUrl ?? scoop?.pageUrl ?? tab.url,
    sourceUrls: sections.map((s) => s.url),
  });
  const text = buildPagePackage({
    site,
    title: title ?? (scoop?.title || tab.title || ''),
    pageUrl: pageUrl ?? scoop?.pageUrl ?? tab.url,
    devDocs: docs,
    llms,
    llmsFull,
    instructions: live.instructions,
    sections: live.sections,
    relatedLinks: live.relatedLinks,
  });
  showPageMeta({ llms: llms?.url, llmsFull: llmsFull?.url, instructions: live.instructions });
  return text;
}

// The site's llms.txt and llms-full.txt, each on its own: verified here (an
// llms.txt starts with an H1 and links somewhere; an llms-full.txt is Markdown
// or too large to download), or as /quick reports them (llms.verified,
// llms.fullVerified).
function llmsFiles(sections = []) {
  const llmsSec = sections.find((s) => s.kind === 'llms');
  const fullSec = sections.find((s) => s.kind === 'llms-full');
  const q = siteInfo?.quick?.llms;
  const llms = llmsSec && verifyLlms(llmsSec.content) ? { url: llmsSec.url } : q?.verified && q.url ? { url: q.url } : null;
  const llmsFull = fullSec && (fullSec.content == null || /^\s*#/.test(fullSec.content)) ? { url: fullSec.url } : q?.fullVerified && q.fullUrl ? { url: q.fullUrl } : null;
  return { llms, llmsFull };
}

// Quick Copy, one line each: "llms.txt ✓ · llms-full.txt ✕" (names link
// when available) and "Agent instructions (n)", collapsed. Both stay hidden
// when the site has no docs at all.
function showPageMeta({ llms = null, llmsFull = null, instructions = [] } = {}) {
  const web = (url) => /^https?:\/\//i.test(url ?? '');
  const docs = verdict.state !== 'no';
  setLlmsItem('llms-item', 'llms.txt', web(llms) ? llms : null);
  setLlmsItem('llms-full-item', 'llms-full.txt', web(llmsFull) ? llmsFull : null);
  $('llms-row').hidden = !docs;
  instructions = instructions.map((i) => (web(i.url) ? i : { ...i, url: null }));
  const list = $('instructions-list');
  list.textContent = '';
  for (const i of instructions) {
    const li = document.createElement('li');
    li.append(document.createTextNode(`${i.text} `));
    if (i.url) li.append(Object.assign(document.createElement('a'), { href: i.url, target: '_blank', rel: 'noopener', textContent: 'source' }));
    list.append(li);
  }
  $('instructions').open = false;
  $('instructions').hidden = !docs || !instructions.length;
  $('instructions-summary').textContent = `Agent instructions (${instructions.length})`;
  $('instructions-summary').setAttribute('aria-label', `What this site says to AI agents: ${plural(instructions.length, 'instruction')}, quoted`);
  $('instructions-none').hidden = !docs || Boolean(instructions.length);
}
function setLlmsItem(id, name, url) {
  const el = $(id);
  el.textContent = '';
  el.dataset.on = String(Boolean(url));
  el.setAttribute('aria-label', `${name} ${url ? 'available' : 'not found'}`);
  if (url) el.append(Object.assign(document.createElement('a'), { href: url, target: '_blank', rel: 'noopener', textContent: name }));
  else el.textContent = name;
}

// The developer-docs pill, at the top of the card. From /quick's docs field
// ({ found, root, via: page|subdomain|path|llms|none }): the page is docs
// ("yes"), the site's docs are elsewhere ("elsewhere", e.g. stripe.com →
// docs.stripe.com), or none ("no"). Without it: the library's isDevDocs (site
// status or /quick); unknown or unreachable: a local guess (indexed, llms.txt
// or a .md twin found, a docs path, code in the page). "Checking…" only
// shows during the loader: the content always gets an answer.
function devDocs(index, quick, scoop) {
  const d = quick?.docs;
  if (d && typeof d.found === 'boolean') {
    if (!d.found) return { state: 'no', guess: false };
    const root = typeof d.root === 'string' && /^https:\/\//i.test(d.root) ? d.root : null;
    if (d.via === 'page' || !root || covers(root, scoop?.pageUrl ?? tab.url)) return { state: 'yes', guess: false };
    return { state: 'elsewhere', guess: false, root };
  }
  // Status may say 'unknown' while /quick knows: either one's yes or no wins over a guess.
  const said = [index?.isDevDocs?.verdict, quick?.isDevDocs?.verdict].find((v) => v === 'yes' || v === 'no');
  if (said) return { state: said, guess: false };
  const kinds = new Set([...(scoop?.sections ?? siteInfo?.scoopSections ?? []), ...(quick?.sources ?? [])].map((s) => s?.kind));
  const code = (scoop?.sections ?? siteInfo?.scoopSections ?? []).some((s) => /^```/m.test(s.content ?? ''));
  const yes = Boolean(index?.indexed) || kinds.has('llms') || kinds.has('page-md') || docsLike(tab.url) || code;
  return { state: yes ? 'yes' : 'no', guess: true };
}
// The docs root holds the page: same host, and the page's path under the root's.
function covers(root, url) {
  try {
    const r = new URL(root);
    const u = new URL(url);
    const dir = r.pathname.endsWith('/') ? r.pathname : `${r.pathname}/`;
    return r.hostname.replace(/^www\./, '') === u.hostname.replace(/^www\./, '') && (u.pathname === r.pathname || u.pathname.startsWith(dir));
  } catch {
    return false;
  }
}
const shortUrl = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
const NOT_DOCS = 'No developer docs found on this site';
let verdict = { state: 'checking', guess: false, root: null };
function setChip({ state, guess = false, root = null }) {
  verdict = { state, guess, root };
  const site = siteInfo?.site ?? siteKey(tab.url);
  const chip = $('devdocs');
  chip.dataset.state = state;
  const text = $('devdocs-text');
  text.textContent = '';
  if (state === 'elsewhere') {
    text.append(Object.assign(document.createElement('a'), { href: root, target: '_blank', rel: 'noopener', textContent: `Docs at ${shortUrl(root)} ↗` }));
  } else {
    text.textContent = { yes: `Docs · ${site}`, no: 'No docs', checking: 'Checking…' }[state];
  }
  chip.setAttribute('aria-label', {
    yes: `${site} has developer docs${guess ? ' (guess)' : ''}`,
    elsewhere: `The developer docs for ${site} are at ${shortUrl(root ?? '')}`,
    no: `${NOT_DOCS}${guess ? ' (guess)' : ''}. scoop.md copied just this page.`,
    checking: 'Checking whether this site has developer docs',
  }[state]);
  chip.title = guess ? `${state === 'yes' ? 'Developer docs' : 'No developer docs'} (guess)` : '';
  // No docs at all: no Overview or Search.
  for (const t of ['overview', 'search']) {
    const el = $(`tab-${t}`);
    if (state === 'no') {
      el.setAttribute('aria-disabled', 'true');
      el.title = NOT_DOCS;
    } else {
      el.removeAttribute('aria-disabled');
      el.title = '';
    }
  }
  if (state === 'no' && activeTab !== 'page') switchTab('page');
  // The library's answer also sets this site's toolbar icon (kept 7 days).
  if (!guess && state !== 'checking' && current && !current.private) {
    rememberVerdict(chrome, site, state === 'no' ? 'not_docs' : 'docs').then(() => setTabBadge(chrome, tab)).catch(() => {});
  }
}
const tabOff = (t) => $(`tab-${t}`).getAttribute('aria-disabled') === 'true';

// The site's instructions for coding agents, as /quick reports them.
function siteInstructions() {
  const list = siteInfo?.quick?.agentInstructions;
  if (!Array.isArray(list)) return [];
  return list.map((i) => (typeof i === 'string' ? { text: i, url: null } : { text: String(i?.text ?? '').trim(), url: i?.url ?? i?.source ?? null })).filter((i) => i.text);
}

// A site in the docs index: its package anchored on this page, used as the
// server builds it (it already puts this page first and links the rest of the
// site). Local sources are not merged in: they would repeat the same page.
// Returns false when the index has nothing for the page.
// fresh: the crawl has only just completed. The index can take a few seconds
// to answer for its pages (live on staging: 404 right after "complete", 200 a
// minute later), so a not-found or busy answer is retried a few times.
async function deliverIndexed(scoop, { fresh = false } = {}) {
  const site = siteKey(tab.url);
  let res;
  let offline = 0;
  for (const wait of fresh ? [0, ...timing.packageRetryMs] : [0]) {
    if (wait) await sleep(wait);
    // Retries get a short timeout, and an unreachable library only one retry,
    // so an outage can't hold the loader for long.
    res = await library.pagePackage(site, scoop.pageUrl, wait ? { timeoutMs: timing.packageRetryTimeoutMs } : {});
    if (res.ok || ![0, 404, 429, 503].includes(res.status)) break;
    if (res.status === 0 && ++offline > 1) break;
  }
  if (!res.ok || typeof res.data !== 'string' || !res.data.trim()) return false;
  $('rebuild').hidden = false;
  const meta = packageMeta(res.data);
  showPageMeta(verdict.state === 'no' ? { llms: meta.llms, llmsFull: meta.llmsFull } : meta);
  await deliver({ text: res.data, scoop, indexed: true, summary: `from the ${site} docs index` });
  return true;
}

const backgroundNote = (site) => `Indexing ${site}…`;

// A page of a site whose docs live elsewhere (stripe.com → docs.stripe.com):
// the copy is the docs' entry point, not the page. Their llms.txt (the first
// ~2k characters) if verified, else their home page, with the site's
// instructions for agents. Returns false when neither could be read.
const ENTRY_CHARS = 2_000;
async function deliverDocsEntry(scoop, root) {
  const rootHost = siteKey(root);
  const llmsUrl = siteInfo.quick?.llms?.verified && /^https:\/\//i.test(siteInfo.quick.llms.url ?? '') ? siteInfo.quick.llms.url : null;
  let section = null;
  let title = '';
  if (llmsUrl) {
    const got = await fetchPublicText(llmsUrl);
    if (got?.content && verifyLlms(got.content)) {
      title = got.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
      section = { kind: 'llms-entry', label: `Docs overview (${shortUrl(llmsUrl)})`, url: llmsUrl, content: cutAtLine(got.content, ENTRY_CHARS) };
    }
  }
  if (!section) {
    const home = await scoopPage(root, { parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html') }).catch(() => null);
    const page = home?.sections.find((s) => s.kind === 'page-md' || s.kind === 'page-html');
    if (page?.content) {
      title = home.title;
      section = { kind: 'docs-home', label: `Docs home (${shortUrl(root)})`, url: page.url, content: cutAtLine(page.content, ENTRY_CHARS) };
    }
  }
  if (!section) return false;
  const text = await composePage({ site: rootHost, scoop, sections: [section], title: title || `${rootHost} docs`, pageUrl: root });
  const ok = await copyAndRecord({ text, scoop, sections: [section], summary: `the docs' entry point at ${shortUrl(root)}` });
  await Promise.all([revealAfterCopy(ok), scoop ? share(scoop) : null]);
  return true;
}
const cutAtLine = (text, max) => (text.length <= max ? text : `${text.slice(0, text.lastIndexOf('\n', max) > max / 2 ? text.lastIndexOf('\n', max) : max).trimEnd()}\n\n[…]`);

// Instant: the local build plus what the library finds for the page right
// away (GET /quick: llms.txt files and the page's .md twin, also on
// docs.<domain>), fetched here without cookies. A .md twin replaces the
// page's converted HTML. Only the local build is shared: sources on another
// host would not match the site.
async function deliverInstant(scoop, quick) {
  if (!scoop?.sections.length && !quick?.sources?.length) throw new Error(NO_TEXT);
  const site = siteKey(tab.url);
  let sections = [...(scoop?.sections ?? [])];
  const have = new Set(sections.map((s) => s.url));
  const extra = (quick?.sources ?? []).filter((s) => s?.url && /^https:\/\//.test(s.url) && !have.has(s.url)).slice(0, 4);
  const fetched = await Promise.all(extra.map(async (s) => {
    const got = await fetchPublicText(s.url);
    if (!got) return null;
    return { kind: s.kind, label: s.label || quickLabel(s.kind), url: s.url, content: got.content ?? null, bytes: got.content == null ? got.bytes : null };
  }));
  for (const s of fetched.filter(Boolean)) {
    if (s.kind === 'page-md') sections = [s, ...sections.filter((x) => x.kind !== 'page-html' && x.kind !== 'page-md')];
    else if (!sections.some((x) => x.kind === s.kind)) sections.push(s);
  }
  if (!sections.length) throw new Error(NO_TEXT);
  // What's shared stays exactly as fetched; only the copy is composed.
  const text = await composePage({ site, scoop, sections, relatedLinks: scoop?.relatedLinks ?? [] });
  const ok = await copyAndRecord({ text, scoop, sections, summary: `${plural(sections.length, 'source')} on ${site}` });
  // Sharing runs while the animation plays; both finish before the scoop does.
  await Promise.all([revealAfterCopy(ok), scoop ? share(scoop) : null]);
}

const quickLabel = (kind) => ({
  'page-md': 'This page (Markdown)',
  llms: 'Site documentation index (llms.txt)',
  'llms-full': 'Full documentation (llms-full.txt)',
}[kind] ?? 'Documentation');

// Asks for the whole site to be indexed, in the background: nothing waits on
// it. The service worker follows it and the badge shows ✓ when it's ready.
async function backgroundCrawl(site, scoop) {
  const res = await library.requestCrawl(scoop.pageUrl);
  const state = res.ok ? res.data?.state : res.status === 429 ? 'rate_limited' : 'error';
  track('crawl_request', { site, state });
  if (!res.ok || !res.data?.id || isTerminal(state)) return null;
  await rememberCrawl(chrome, { requestId: res.data.id, site, url: scoop.pageUrl, state });
  return res.data.id;
}

// While the popup is open, a crawl for this site is checked quietly; when it
// completes, "Copy all <site> docs" copies the indexed package.
let following = false;
async function followCrawl(site, scoop, id) {
  if (following) return;
  following = true;
  note('crawl-note', backgroundNote(site));
  for (let errors = 0; errors < 5;) {
    await sleep(timing.followMs);
    const res = await library.crawlRequest(id);
    if (!res.ok) { if (res.status === 404) break; errors++; continue; }
    await rememberCrawl(chrome, { requestId: id, site, url: scoop.pageUrl, state: res.data.state });
    background = res.data;
    // The crawl's gate decides a guess.
    if (verdict.guess) {
      if (res.data.state === 'rejected') setChip({ state: 'no' });
      else if (res.data.phase && res.data.phase !== 'gate') setChip({ state: 'yes' });
    }
    if (res.data.state === 'complete') {
      note('crawl-note', `${site} docs ready`);
      $('full-docs').textContent = `Copy all ${site} docs`;
      $('full-docs').hidden = false;
      $('full-docs').onclick = async () => {
        $('full-docs').hidden = true;
        showLoader();
        if (await deliverIndexed(scoop, { fresh: true })) {
          await forgetCrawl(chrome, site);
          note('crawl-note', `Copied from the full ${site} docs.`);
        } else {
          reveal();
        }
      };
      break;
    }
    if (isTerminal(res.data.state)) {
      await forgetCrawl(chrome, site);
      note('crawl-note', '');
      break;
    }
  }
}

async function run({ skipLibrary = false } = {}) {
  status('Scooping this page…', 'busy');
  $('copy').disabled = true;
  note('share', '');
  note('crawl-note', '');
  $('full-docs').hidden = true;
  showFeedback(null);
  $('rebuild').hidden = true;
  setChip({ state: 'checking' });
  showPageMeta();
  showUsage('');
  showLoader();
  const site = siteKey(tab.url);
  // The site is named on scoop_result, once it's known whether the page is public.
  // Nothing at all about pages on private hosts.
  current = { siteKey: site, started: Date.now(), done: false, private: isPrivateHost(new URL(tab.url).hostname) };
  if (!current.private) track('scoop_start');

  // Everything at once: the local build, the library's shared skill, the
  // site's place in the docs index, and any crawl this install asked for.
  // Private hostnames never reach the library, not even to ask.
  const ask = !skipLibrary && (devLibrary || !current.private);
  const local = scoopCurrentTab();
  local.catch(() => {});
  const [best, siteStatus, pending] = await Promise.all([
    ask ? library.best(site) : null,
    ask ? library.siteStatus(site) : null,
    ask ? loadPending(chrome).then((p) => p[site] ?? null) : null,
  ]);
  const shared = best?.ok && best.data?.skill?.sections?.length ? best.data.skill : null;
  const index = siteStatus?.ok ? siteStatus.data : null;
  // Reachable: it answered either question (a 4xx/5xx counts; no answer doesn't).
  siteInfo = { site, index, pending, ask, libraryUp: Boolean(best?.status || siteStatus?.status) };
  const scoop = await local.catch((e) => {
    if (shared) return null; // the shared skill still works without the page
    throw e;
  });
  // The page's address goes to the library only for public pages; asking for
  // a crawl is contributing, like sharing, so it also needs sharing on.
  const pagePublic = Boolean(ask && scoop?.isPublic);
  const mayCrawl = pagePublic && settings.share;
  siteInfo.pagePublic = pagePublic;
  siteInfo.scoopSections = scoop?.sections ?? [];
  siteInfo.pageUrl = scoop?.pageUrl;
  background = pending ?? (index?.crawling ? index.request : null);

  setChip(devDocs(index, null, scoop));

  // 1. A crawl this install asked for has completed: the full docs.
  let askedIndex = false;
  if (pending && pagePublic && pending.state === 'complete' && !pending.delivered) {
    askedIndex = true;
    if (await deliverIndexed(scoop, { fresh: true })) {
      await forgetCrawl(chrome, site);
      note('crawl-note', `Copied from the full ${site} docs.`);
      return;
    }
    await forgetCrawl(chrome, site);
  }
  // 2. The site is in the docs index (a crawl may still be adding pages).
  if (index?.indexed && pagePublic && !askedIndex && (await deliverIndexed(scoop))) {
    if (pending && !isTerminal(pending.state)) await rememberCrawl(chrome, { ...pending, delivered: true });
    return;
  }
  // Not indexed yet: index it in the background (or follow the crawl already running).
  const unseen = index && !index.indexed && !index.crawling && index.status === 'new';
  let crawlId = pending && !isTerminal(pending.state) ? pending.requestId : null;
  if (!crawlId && pagePublic && index?.crawling && index.request?.id && !isTerminal(index.request.state)) {
    crawlId = index.request.id;
    await rememberCrawl(chrome, { requestId: crawlId, site, url: scoop.pageUrl, state: index.request.state });
  }
  // What the library finds for the page right away: sources, the site's
  // instructions for agents, and whether it's developer docs.
  const quick = pagePublic ? await library.quick(scoop.pageUrl) : null;
  siteInfo.quick = quick?.ok ? quick.data : null;
  // A crawl gate that already decided (followCrawl) beats a new guess.
  const said = devDocs(index, siteInfo.quick, scoop);
  if (!said.guess || verdict.guess || verdict.state === 'checking') setChip(said);
  // Only developer docs are indexed (and shared).
  const crawl = !crawlId && unseen && mayCrawl && verdict.state === 'yes' ? backgroundCrawl(site, scoop) : Promise.resolve(crawlId);
  const followUp = crawl.then((id) => { if (id && scoop) followCrawl(site, scoop, id); }).catch(() => {});
  // The docs are elsewhere: their entry point, not this page.
  if (verdict.state === 'elsewhere' && (await deliverDocsEntry(scoop, verdict.root))) return followUp;
  // 3. The shared skill.
  if (shared) {
    await deliverShared(shared, scoop);
    return followUp;
  }
  // 4. Instant: the local build with what the library finds right away.
  await deliverInstant(scoop, siteInfo.quick);
  return followUp;
}

// Tabs: This page, Overview, Search. Arrow keys move between them (roving tabindex).
const TABS = ['page', 'overview', 'search'];
function switchTab(name, { focus = false } = {}) {
  if (!TABS.includes(name) || tabOff(name)) return;
  if (name !== activeTab) track('tab_switch', { tab: name });
  activeTab = name;
  for (const t of TABS) {
    const el = $(`tab-${t}`);
    el.setAttribute('aria-selected', String(t === name));
    el.setAttribute('tabindex', t === name ? '0' : '-1');
  }
  if (focus) $(`tab-${name}`).focus();
  if (document.body.dataset.stage === 'content') setStage('content');
  if (name === 'overview') showOverview();
  if (name === 'search') showSearch();
}
for (const t of TABS) {
  $(`tab-${t}`).onclick = () => switchTab(t);
  $(`tab-${t}`).onkeydown = (e) => {
    const on = TABS.filter((x) => !tabOff(x));
    const i = on.indexOf(activeTab);
    const n = on.length;
    const to = { ArrowRight: on[(i + 1) % n], ArrowLeft: on[(i + n - 1) % n], Home: on[0], End: on[n - 1] }[e.key];
    if (!to) return;
    e.preventDefault?.();
    switchTab(to, { focus: true });
  };
}

// Overview and Search work for indexed sites. Otherwise: why not, and the
// background crawl's progress if there is one.
function indexedSite() {
  return siteInfo?.ask && siteInfo.pagePublic && siteInfo.index?.indexed ? siteInfo.site : null;
}
function showOff(panel) {
  $(`${panel}-on`).hidden = true;
  $(`${panel}-off`).hidden = false;
  const site = siteInfo?.site;
  const what = panel === 'search' ? 'Search' : 'Overview';
  $(`${panel}-off-title`).textContent = !site || !siteInfo.ask || !siteInfo.pagePublic
    ? `${what}: public docs sites only`
    : `${what}: ${site} isn't indexed yet`;
  let line = '';
  if (site && siteInfo.pagePublic && background && !isTerminal(background.state)) {
    const { label, count } = progressText(background);
    line = `Indexing… ${label}${count ? ` · ${count}` : ''}`;
  } else if (site && siteInfo.pagePublic && !settings.share) {
    line = 'Sharing is off: no indexing requests';
  }
  $(`${panel}-off-status`).textContent = line;
}

let overviewText = '';
let overviewFull = null;
let overviewLoaded = false;
async function showOverview() {
  const site = indexedSite();
  if (!site) return showOff('overview');
  $('overview-off').hidden = true;
  $('overview-on').hidden = false;
  for (const el of document.querySelectorAll('#overview .site-name')) el.textContent = site;
  if (overviewLoaded) return;
  overviewLoaded = true;
  $('overview-status').textContent = 'Loading…';
  // The site's llms.txt: from this page's scoop, else where /quick says it is.
  if (!currentLlms()?.content && siteInfo.quick === undefined) {
    const quick = await library.quick(siteInfo.pageUrl ?? tab.url);
    siteInfo.quick = quick.ok ? quick.data : null;
  }
  const llmsUrl = siteInfo.quick?.overview ?? currentLlms()?.url ?? null;
  const [topics, llms] = await Promise.all([
    library.topics(site),
    currentLlms()?.content ? { content: currentLlms().content } : llmsUrl ? fetchPublicText(llmsUrl) : null,
  ]);
  const tree = topics.ok ? topics.data?.topics ?? [] : [];
  const pages = topics.ok ? topics.data?.pages ?? 0 : siteInfo.index?.pages ?? 0;
  $('overview-meta').textContent = pages ? `${pages} pages` : '';
  const list = $('overview-topics');
  list.textContent = '';
  for (const node of tree.slice(0, 12)) {
    const li = document.createElement('li');
    li.textContent = `${node.name} `;
    const n = document.createElement('span');
    n.className = 'meta';
    n.textContent = compactCount(node.count);
    li.append(n);
    if (node.children?.length) {
      const sub = document.createElement('ul');
      for (const c of node.children.slice(0, 6)) {
        const cl = document.createElement('li');
        cl.textContent = `${c.name} `;
        const cn = document.createElement('span');
        cn.className = 'meta';
        cn.textContent = compactCount(c.count);
        cl.append(cn);
        sub.append(cl);
      }
      li.append(sub);
    }
    list.append(li);
  }
  const llmsText = llms?.content ?? '';
  $('overview-llms-title').hidden = !llmsText;
  $('overview-llms').hidden = !llmsText;
  $('overview-llms').textContent = llmsText.split('\n').slice(0, 30).join('\n');
  const lines = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      lines.push(`${'  '.repeat(depth)}- ${n.path} (${n.count} ${n.count === 1 ? 'page' : 'pages'})`);
      if (depth < 2) walk(n.children ?? [], depth + 1);
    }
  };
  walk(tree, 0);
  // Within the 16k budget; a longer llms.txt is cut, and offered whole.
  const llmsSource = llmsText ? { url: llms?.url ?? llmsUrl, content: llmsText } : null;
  const built = lines.length || llmsSource ? buildOverviewPackage({ site, topics: lines, pages, llms: llmsSource }) : null;
  overviewText = built?.text ?? '';
  overviewFull = built?.truncated && llmsSource ? llmsSource : null;
  $('copy-overview').disabled = !overviewText;
  $('copy-llms-full').hidden = !overviewFull;
  if (overviewFull) $('copy-llms-full').textContent = `Copy full llms.txt (${tokenEstimate(overviewFull.content)})`;
  $('overview-status').textContent = overviewText ? `${tokenEstimate(overviewText)} · ${kb(overviewText)}` : 'No overview yet';
}
const currentLlms = () => siteInfo?.scoopSections?.find((s) => s.kind === 'llms') ?? null;

$('copy-overview').onclick = async () => {
  if (!overviewText) return;
  const ok = await writeClipboard(overviewText);
  $('overview-status').textContent = ok ? `Copied ✓ · ${tokenEstimate(overviewText)}` : "Couldn't copy. Try again.";
  if (ok) track('copy_overview', { site: indexedSite() });
  await revealAfterCopy(ok);
};
$('copy-llms-full').onclick = async () => {
  if (!overviewFull) return;
  const ok = await writeClipboard(overviewFull.content);
  $('overview-status').textContent = ok ? `Copied ✓ · ${tokenEstimate(overviewFull.content)}` : "Couldn't copy. Try again.";
  if (ok) track('copy_overview', { site: indexedSite() });
  await revealAfterCopy(ok);
};

// Search: debounced, at least 2 characters, 20 results with checkboxes.
let hits = [];
let searchTimer = null;
let searchSeq = 0;
function showSearch() {
  const site = indexedSite();
  if (!site) return showOff('search');
  $('search-off').hidden = true;
  $('search-on').hidden = false;
  $('search-q').placeholder = `Search ${site}`;
  $('search-q').focus?.();
}
$('search-q').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, timing.searchDebounceMs);
};
async function runSearch() {
  const site = indexedSite();
  const q = $('search-q').value.trim();
  const seq = ++searchSeq;
  if (!site || q.length < 2) {
    hits = [];
    renderHits();
    $('search-status').textContent = q ? '2+ characters' : '';
    return;
  }
  $('search-status').textContent = 'Searching…';
  const res = await library.search(site, q, 20);
  if (seq !== searchSeq) return; // a newer search started
  hits = res.ok ? res.data?.hits ?? [] : [];
  track('search', { site, qLen: q.length, results: hits.length });
  renderHits();
  $('search-status').textContent = !res.ok ? 'Search unavailable' : hits.length ? plural(hits.length, 'result') : 'No results';
}
function renderHits() {
  const list = $('search-results');
  list.textContent = '';
  hits.forEach((h, i) => {
    const li = document.createElement('li');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', id: `hit-${i}` });
    box.dataset.index = String(i);
    box.onchange = updateSearchButtons;
    const label = document.createElement('label');
    label.htmlFor = `hit-${i}`;
    const title = document.createElement('span');
    title.className = 'hit-title';
    title.textContent = h.title || h.url;
    const path = document.createElement('span');
    path.className = 'meta hit-path';
    path.textContent = h.heading_path || '';
    const snippet = document.createElement('span');
    snippet.className = 'hit-snippet';
    snippet.textContent = h.snippet || '';
    label.append(title, path, snippet);
    li.append(box, label);
    list.append(li);
  });
  updateSearchButtons();
}
const selectedHits = () => [...document.querySelectorAll('#search-results input[type=checkbox]')].filter((b) => b.checked).map((b) => hits[Number(b.dataset.index)]);
function updateSearchButtons() {
  $('copy-selected').disabled = !selectedHits().length;
  $('copy-all').disabled = !hits.length;
}

// Selected results become one package built by the library from exactly
// those chunks (GET /packages?chunks=), else the package for the query.
$('copy-selected').onclick = async () => {
  const site = indexedSite();
  const chosen = selectedHits();
  const q = $('search-q').value.trim();
  if (!site || !chosen.length) return;
  $('search-status').textContent = 'Building…';
  const ids = chosen.map((h) => h.id).filter(Boolean).slice(0, 30);
  let res = ids.length === chosen.length ? await library.chunksPackage(site, ids) : { ok: false };
  if (!res.ok || !res.data?.trim()) res = q.length >= 2 ? await library.queryPackage(site, q) : res;
  if (!res.ok || !res.data?.trim()) {
    $('search-status').textContent = "Couldn't build it. Try again.";
    return;
  }
  const ok = await writeClipboard(res.data);
  $('search-status').textContent = ok ? `Copied ✓ · ${plural(chosen.length, 'result')} · ${tokenEstimate(res.data)}` : "Couldn't copy. Try again.";
  if (ok) track('copy_search', { site, count: chosen.length });
  await revealAfterCopy(ok);
};
$('copy-all').onclick = async () => {
  const site = indexedSite();
  const q = $('search-q').value.trim();
  if (!site || q.length < 2) return;
  $('search-status').textContent = 'Building…';
  const res = await library.queryPackage(site, q);
  if (!res.ok || !res.data?.trim()) {
    $('search-status').textContent = "Couldn't build it. Try again.";
    return;
  }
  const ok = await writeClipboard(res.data);
  $('search-status').textContent = ok ? `Copied ✓ · all results · ${tokenEstimate(res.data)}` : "Couldn't copy. Try again.";
  if (ok) track('copy_search', { site, count: hits.length });
  await revealAfterCopy(ok);
};

const NO_TEXT = 'Could not find any documentation text on this page.';

function shareResult(outcome, reason) {
  track('share_result', { site: current?.site, path: current?.path, outcome, reason });
}

async function share(scoop) {
  if (!settings.share) {
    shareResult('not_shared', 'sharing_off');
    return note('share', 'Not shared: sharing is off.');
  }
  if (verdict.state === 'no') {
    shareResult('not_shared', 'not_devdocs');
    return note('share', 'Not shared: scoop.md only shares developer docs.');
  }
  // The page isn't the docs (they're elsewhere): what was copied is their
  // entry point, so the page itself isn't shared.
  if (verdict.state === 'elsewhere') {
    shareResult('not_shared', 'docs_elsewhere');
    return note('share', '');
  }
  if (!scoop.isPublic) {
    shareResult('not_shared', scoop.privateHost ? 'private_host' : 'signed_in');
    return note('share', scoop.privateHost && !devLibrary
      ? 'Not shared: this page is on your computer or a private network.'
      : "Not shared: this page's text only loads in your browser.");
  }

  note('share', 'Sharing with the library…');
  const body = shareBody(scoop);
  let res = await library.share(body);
  const retry = res.ok ? null : withoutSectionQuery(body, res.error);
  if (retry) res = await library.share(retry);
  // An unreachable library is not the user's problem: the copy already worked.
  if (!res.ok) shareResult('not_shared', res.error?.code);
  else shareResult(res.data.duplicate ? 'duplicate' : 'shared');
  if (res.error?.code === 'offline' || res.error?.code === 'timeout') return note('share', '');
  if (!res.ok) return note('share', `Not shared: ${notSharedReason(res.error, scoop.sections)}`, 'warn');
  note('share', res.data.duplicate ? 'Already in the library.' : 'Shared with the library.');
  showFeedback(res.data.id);
}

async function vote(worked) {
  const res = await library.feedback(skillId, worked);
  track('vote', { site: current?.site, path: current?.path, skillId, worked, ok: res.ok });
  note('voted', res.ok
    ? `Thanks. It worked for ${plural(res.data.worked, 'person', 'people')} and didn't for ${res.data.failed}.`
    : "Couldn't record your vote. Try again in a moment.");
}

async function report(reason) {
  const res = await library.report(skillId, reason);
  track('report', { site: current?.site, path: current?.path, skillId, reason, ok: res.ok });
  $('report').hidden = true;
  note('voted', res.ok ? 'Reported. Thanks, we will review it.' : "Couldn't send the report. Try again in a moment.");
}

// One-time notice about usage statistics, shown whatever the sharing setting.
// Until it has been shown, events carry no site or path (lib/telemetry.js).
async function usageNotice() {
  if (!(await telemetryEnabled(chrome))) return;
  if ((await chrome.storage.local.get(NOTICE_KEY))[NOTICE_KEY]) return;
  $('usage-notice').hidden = false;
  telemetry.markNoticeShown();
  $('usage-ok').onclick = () => { $('usage-notice').hidden = true; };
  $('usage-off').onclick = async () => {
    telemetry.disable();
    library = createLibrary({ ...libraryOptions, telemetry: false });
    $('usage-notice-text').textContent = 'Usage statistics are off. You can turn them back on in Settings.';
    $('usage-off').hidden = true;
    $('usage-ok').onclick = () => { $('usage-notice').hidden = true; };
    await setTelemetry(chrome, false);
  };
}

// One line, once: pinning shows on the icon whether each site is developer docs.
const PIN_KEY = 'pinHintSeen';
async function pinHint() {
  try {
    const { [PIN_KEY]: seen } = await chrome.storage.local.get(PIN_KEY);
    if (seen || (await chrome.action.getUserSettings?.())?.isOnToolbar !== false) return;
  } catch {
    return;
  }
  $('pin-hint').hidden = false;
  $('pin-ok').onclick = () => {
    $('pin-hint').hidden = true;
    chrome.storage.local.set({ [PIN_KEY]: true });
  };
}

async function intro() {
  const { introSeen } = await chrome.storage.local.get('introSeen');
  if (introSeen || !settings.share) return;
  $('intro').hidden = false;
  $('intro-ok').onclick = () => {
    $('intro').hidden = true;
    chrome.storage.local.set({ introSeen: true });
  };
}

function fail(e) {
  status(e?.message || String(e), 'err');
  reveal();
  if (current && !current.done) {
    const empty = e?.message === NO_TEXT;
    scoopResult(empty ? 'empty' : 'error');
    if (!empty && !current.private) track('error', { where: 'scoop', code: e?.name || 'Error', message: errorText(e) });
  } else {
    track('error', { where: 'popup', code: e?.name || 'Error', message: errorText(e) });
  }
}

$('theme').onclick = async () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'light' : 'dark';
  applyTheme(theme);
  track('settings_change', { key: 'theme', value: theme });
  try { await chrome.storage.local.set({ theme }); } catch {}
};
$('copy').onclick = async () => {
  if (!(await writeClipboard(clipboardText))) return status("Couldn't copy. Try again.", 'err');
  track('copy', { site: current?.site, path: current?.path, sizeBytes: sizeOf(clipboardText), trigger: 'button' });
  status('Copied again.');
  flashCopied();
};
$('rebuild').onclick = () => {
  track('rebuild', { site: current?.site, path: current?.path });
  return run({ skipLibrary: true }).catch(fail);
};
$('settings').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
for (const btn of document.querySelectorAll('#feedback button[data-worked]')) {
  btn.onclick = () => vote(btn.dataset.worked === 'true');
}
$('report-open').onclick = (e) => { e.preventDefault(); $('report').hidden = !$('report').hidden; };
$('report').onsubmit = (e) => { e.preventDefault(); return report($('reason').value); };

async function main() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  try { applyTheme((await chrome.storage.local.get('theme')).theme); } catch {}
  const baseUrl = await libraryUrl(chrome);
  devLibrary = baseUrl !== DEFAULT_LIBRARY;
  libraryOptions = {
    baseUrl,
    installId: await getInstallId(chrome),
    client: `extension/${chrome.runtime.getManifest().version}`,
    telemetry: await telemetryEnabled(chrome),
  };
  library = createLibrary(libraryOptions);
  await usageNotice();
  await pinHint();
  await intro();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url || '')) {
    track('scoop_result', { outcome: 'unsupported_page', durationMs: 0 });
    status('Open a documentation page first.', 'err');
    return reveal();
  }
  await run();
}

// The popup can't tell a toolbar click from the keyboard shortcut (MV3 has no
// signal for either), so popup_open carries no trigger.
track('popup_open');
let closed = false;
function onClose() {
  if (closed) return;
  closed = true;
  track('popup_close', { durationMs: Date.now() - openedAt });
  telemetry.flushOnClose();
}
// Hidden isn't always closed (the popup can come back), so only pagehide ends a wait.
globalThis.addEventListener?.('pagehide', () => {
  // Hidden may already have run onClose: send anything queued since.
  telemetry.flushOnClose();
  onClose();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onClose(); });

// Exported so tests can wait for the first run.
export const ready = main().catch(fail);
