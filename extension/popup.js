import { siteKey } from './lib/discover.js';
import { buildPackage, withCurrentPage } from './lib/package.js';
import { scoopPage, currentPageSection, isPrivateHost } from './lib/scoop.js';
import { DEFAULT_LIBRARY, libraryUrl, createLibrary, shareBody, notSharedReason, withoutSectionQuery } from './lib/library.js';
import { createTelemetry, docsLike, getInstallId, NOTICE_KEY, pagePath, errorText, setTelemetry, telemetryEnabled } from './lib/telemetry.js';
import { registrableDomain } from './lib/hosts.js';
import { forgetCrawl, isTerminal, loadPending, progressText, rememberCrawl } from './lib/crawl.js';
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

function copied(ok) {
  if (ok) status('Copied. Paste it into your agent.');
  else status('Ready. Click Copy to put it on your clipboard.', 'err');
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
  current.path = publicSite && (docsSource || (isPublic && docsLike(tab.url))) ? pagePath(tab.url) : undefined;
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
function setStage(name) {
  document.body.dataset.stage = name;
  logStage(name);
  $('loader').hidden = name !== 'loading';
  $('copied-stage').hidden = name !== 'copied';
  $('waiting').hidden = name !== 'waiting';
  $('content').hidden = name !== 'content';
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
}

// Clears the live region first, so the same message twice is announced twice.
let announcing = null;
function announce(text) {
  $('announce').textContent = '';
  clearTimeout(announcing);
  announcing = setTimeout(() => { $('announce').textContent = text; }, ANNOUNCE_DELAY_MS);
}
const ANNOUNCE_DELAY_MS = 50;

// The content, announced with the status line, and focus on the Copy button.
function reveal() {
  setStage('content');
  $('content').classList.add('reveal');
  announce($('status').textContent);
  if (!$('copy').disabled) $('copy').focus();
}

// Copies and records the scoop; returns whether the clipboard took it.
async function copyAndRecord({ text, summary, scoop = null, sections = [], shared = null, indexed = false }) {
  const ok = await copy(text);
  copied(ok);
  scoopResult('copied_ready', { scoop, text, sections, shared, indexed, clipboard: ok });
  if (ok) track('copy', { site: current.site, path: current.path, sizeBytes: sizeOf(text), trigger: 'auto' });
  note('summary', summary);
  return ok;
}

const deliver = async (pkg) => revealAfterCopy(await copyAndRecord(pkg));

// The package built here from the page, as before the docs index existed.
async function deliverLocal(scoop, { crawlNote = '' } = {}) {
  if (!scoop?.sections.length) throw new Error(NO_TEXT);
  const site = siteKey(tab.url);
  const text = buildPackage({ site, pageUrl: scoop.pageUrl, sections: scoop.sections, relatedLinks: scoop.relatedLinks });
  note('crawl-note', crawlNote);
  const ok = await copyAndRecord({ text, scoop, sections: scoop.sections, summary: `${kb(text)} · ${plural(scoop.sections.length, 'source')} on ${site}` });
  // Sharing runs while the animation plays; both finish before the scoop does.
  await Promise.all([revealAfterCopy(ok), share(scoop)]);
}

async function deliverShared(shared, scoop) {
  const site = siteKey(tab.url);
  const sections = withCurrentPage(shared.sections, currentPageSection(scoop), tab.url);
  const text = buildPackage({ site, pageUrl: tab.url, sections, relatedLinks: shared.relatedLinks ?? [] });
  $('rebuild').hidden = false;
  showFeedback(shared.id);
  return deliver({ text, scoop, sections, shared, summary: `${kb(text)} · shared, worked for ${plural(shared.worked, 'person', 'people')}` });
}

// A site in the docs index: its package anchored on this page, used as the
// server builds it (it already puts this page first and links the rest of the
// site). Local sources are not merged in: they would repeat the same page.
// Returns false when the index has nothing for the page.
async function deliverIndexed(scoop) {
  const site = siteKey(tab.url);
  const res = await library.pagePackage(site, scoop.pageUrl);
  if (!res.ok || typeof res.data !== 'string' || !res.data.trim()) return false;
  $('rebuild').hidden = false;
  await deliver({ text: res.data, scoop, indexed: true, summary: `${kb(res.data)} · from the ${site} docs index` });
  return true;
}

// Asks the library to crawl the site, then waits for it. Returns once
// something was copied.
async function requestCrawl(scoop) {
  const site = siteKey(tab.url);
  const res = await library.requestCrawl(scoop.pageUrl);
  const state = res.ok ? res.data?.state : res.status === 429 ? 'rate_limited' : 'error';
  track('crawl_request', { site, state });
  if (!res.ok) {
    return deliverLocal(scoop, { crawlNote: res.status === 429 ? 'The docs index is busy right now, so we copied just this page.' : '' });
  }
  if (state === 'complete') {
    if (await deliverIndexed(scoop)) return;
    return deliverLocal(scoop);
  }
  if (state === 'rejected') return deliverLocal(scoop, { crawlNote: REJECTED_NOTE });
  if (state === 'failed') return deliverLocal(scoop, { crawlNote: failedNote(site) });
  await rememberCrawl(chrome, { requestId: res.data.id, site, url: scoop.pageUrl, state });
  return waitForCrawl(scoop, { id: res.data.id, state, etaSeconds: res.data.etaSeconds });
}

const REJECTED_NOTE = "This doesn't look like developer docs, so we copied just this page.";
const failedNote = (site) => `We couldn't read the docs for ${site}, so we copied just this page.`;

// The waiting view: polls every timing.pollMs until the crawl ends, or until
// "Copy this page now". The request stays stored, so closing the popup leaves
// it to the service worker.
let waitingSince = 0;
function waitOutcome(outcome) {
  if (!waitingSince) return;
  track('crawl_wait', { durationMs: Date.now() - waitingSince, outcome });
  waitingSince = 0;
}

function showProgress(req) {
  const { label, count, fraction } = progressText(req);
  // #wait-phase is aria-live: only a new phase is written (and announced).
  if ($('wait-phase').textContent !== label) $('wait-phase').textContent = label;
  note('wait-count', count, 'meta');
  // No value: an indeterminate bar.
  if (fraction == null) $('wait-progress').removeAttribute('value');
  else $('wait-progress').setAttribute('value', String(Math.round(fraction * 100)));
}

async function waitForCrawl(scoop, initial) {
  const site = siteKey(tab.url);
  await loaderDone();
  $('wait-site').textContent = site;
  showProgress(initial);
  setStage('waiting');
  // Phase changes are announced by #wait-phase (aria-live); this says what's going on.
  announce(`Figuring out the docs for ${site}…`);
  $('copy-now').disabled = false;
  waitingSince = Date.now();
  // The give-up clock is this wait's own: waitingSince is cleared once the wait
  // has been reported, which must not end the wait.
  const waitStarted = waitingSince;
  let stopped = false;
  let copyingNow = null;
  $('copy-now').onclick = () => {
    if (stopped) return;
    stopped = true;
    waitOutcome('copied_page');
    copyingNow = deliverLocal(scoop, { crawlNote: `We're still figuring out the docs for ${site}. The scoop.md icon shows ✓ when they're ready.` });
  };
  const poll = (async () => {
    let req = initial;
    let errors = 0;
    while (!stopped && !isTerminal(req.state)) {
      if (Date.now() - waitStarted >= timing.maxWaitMs) {
        req = { state: 'timeout' };
        break;
      }
      await sleep(timing.pollMs);
      if (stopped) return;
      const res = await library.crawlRequest(initial.id);
      if (stopped) return;
      if (res.ok && res.data?.state) {
        errors = 0;
        req = { ...res.data, id: initial.id };
        showProgress(req);
        await rememberCrawl(chrome, { requestId: initial.id, site, url: scoop.pageUrl, state: req.state });
      } else if (res.status === 404 || ++errors >= 5) {
        req = { state: 'failed' };
      }
    }
    if (stopped) return;
    stopped = true;
    $('copy-now').onclick = null;
    waitOutcome(req.state);
    if (req.state === 'complete') {
      // Fetching the package can take a moment: back to the loader, no second copy.
      $('copy-now').disabled = true;
      showLoader();
      await forgetCrawl(chrome, site);
      if (await deliverIndexed(scoop)) return;
      return deliverLocal(scoop);
    }
    if (req.state === 'timeout') {
      // Still running: the service worker carries on and shows ✓ when it's ready.
      return deliverLocal(scoop, { crawlNote: `This is taking longer than usual, so we copied just this page. The scoop.md icon shows ✓ when the docs for ${site} are ready.` });
    }
    await forgetCrawl(chrome, site);
    return deliverLocal(scoop, { crawlNote: req.state === 'rejected' ? REJECTED_NOTE : failedNote(site) });
  })();
  // The poll returns soon after "Copy this page now" too; then that copy is what's left.
  await poll;
  if (copyingNow) await copyingNow;
}

async function run({ skipLibrary = false } = {}) {
  status('Scooping this page…', 'busy');
  $('copy').disabled = true;
  note('share', '');
  note('crawl-note', '');
  showFeedback(null);
  $('rebuild').hidden = true;
  showLoader();
  const site = siteKey(tab.url);
  // The site is named on scoop_result, once it's known whether the page is public.
  // Nothing at all about pages on private hosts.
  current = { siteKey: site, started: Date.now(), done: false, private: isPrivateHost(new URL(tab.url).hostname) };
  if (!current.private) track('scoop_start');

  // Everything at once: the local build, the library's shared skill, the
  // site's place in the docs index, and any crawl this install is waiting on.
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
  const scoop = await local.catch((e) => {
    if (shared) return null; // the shared skill still works without the page
    throw e;
  });
  // The page's address goes to the index only for public pages; asking for a
  // crawl is contributing, like sharing, so it also needs sharing on.
  const pagePublic = Boolean(ask && scoop?.isPublic);
  const mayCrawl = pagePublic && settings.share;

  // 1. A crawl this install asked for earlier: deliver it, or keep waiting.
  let askedIndex = false;
  if (pending && pagePublic) {
    if (pending.state === 'complete') {
      await forgetCrawl(chrome, site);
      askedIndex = true;
      if (await deliverIndexed(scoop)) return;
    } else if (!isTerminal(pending.state)) {
      return waitForCrawl(scoop, { id: pending.requestId, state: pending.state, phase: pending.phase });
    } else {
      await forgetCrawl(chrome, site);
    }
  }
  // 2. The site is in the docs index.
  if (index?.indexed && pagePublic && !askedIndex && (await deliverIndexed(scoop))) return;
  const crawling = index && !index.indexed && index.crawling && index.request?.id;
  const unseen = index && !index.indexed && !index.crawling && index.status === 'new';
  // 3. The shared skill (when the site isn't indexed yet, ask for a crawl in the
  // background so the next scoop gets the index; the badge follows it).
  if (shared) {
    if (unseen && mayCrawl) backgroundCrawl(site, scoop);
    return deliverShared(shared, scoop);
  }
  // 4. Someone's crawl is already running: wait for it too.
  if (crawling && pagePublic) {
    await rememberCrawl(chrome, { requestId: index.request.id, site, url: scoop.pageUrl, state: index.request.state });
    return waitForCrawl(scoop, { ...index.request });
  }
  // 5. Never crawled: ask, and wait.
  if (unseen && mayCrawl) return requestCrawl(scoop);
  // 6. Built here, as before.
  return deliverLocal(scoop);
}

function backgroundCrawl(site, scoop) {
  library.requestCrawl(scoop.pageUrl).then((res) => {
    const state = res.ok ? res.data?.state : res.status === 429 ? 'rate_limited' : 'error';
    track('crawl_request', { site, state });
    if (res.ok && res.data?.id && !isTerminal(state)) return rememberCrawl(chrome, { requestId: res.data.id, site, url: scoop.pageUrl, state });
  }).catch(() => {});
}

const NO_TEXT = 'Could not find any documentation text on this page.';

function shareResult(outcome, reason) {
  track('share_result', { site: current?.site, path: current?.path, outcome, reason });
}

async function share(scoop) {
  if (!settings.share) {
    shareResult('not_shared', 'sharing_off');
    return note('share', 'Not shared: sharing is off.');
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
  $('copy-label').textContent = 'Copied';
  setTimeout(() => { $('copy-label').textContent = 'Copy for your agent'; }, 1500);
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
  waitOutcome('closed');
  onClose();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onClose(); });

// Exported so tests can wait for the first run.
export const ready = main().catch(fail);
