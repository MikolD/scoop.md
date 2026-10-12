import { siteKey } from './lib/discover.js';
import { buildPackage, withCurrentPage } from './lib/package.js';
import { scoopPage, currentPageSection, isPrivateHost } from './lib/scoop.js';
import { DEFAULT_LIBRARY, libraryUrl, createLibrary, shareBody, notSharedReason, withoutSectionQuery } from './lib/library.js';
import { createTelemetry, getInstallId, pagePath, errorText } from './lib/telemetry.js';

const DEFAULTS = { share: true };
const $ = (id) => document.getElementById(id);

let settings;
let library;
let devLibrary = false;
let tab;
let clipboardText = '';
let skillId = null;
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

// One scoop_result per scoop. The page's path is recorded only when its
// content was public; for a signed-in page only the hostname is.
function scoopResult(outcome, { scoop, text, sections = [], shared = null, clipboard } = {}) {
  if (!current || current.done) return;
  current.done = true;
  const isPublic = Boolean(scoop?.isPublic);
  // Later events about this scoop (copy, share, vote) carry the same path.
  current.path = isPublic ? pagePath(tab.url) : undefined;
  track('scoop_result', {
    site: current.site,
    path: current.path,
    outcome,
    sourceKinds: [...new Set(sections.map((s) => s.kind))],
    sources: sections.length,
    sizeBytes: text ? sizeOf(text) : 0,
    truncated: Boolean(text && (sections.some((s) => s.content == null) || /\[(Truncated\. The full text|Omitted for length\.)/.test(text))),
    durationMs: Date.now() - current.started,
    libraryHit: Boolean(shared),
    libraryWorked: shared?.worked ?? undefined,
    isPublic,
    relatedLinks: (shared ? shared.relatedLinks : scoop?.relatedLinks)?.length ?? 0,
    clipboard,
  });
}

async function run({ skipLibrary = false } = {}) {
  status('Scooping this page…', 'busy');
  $('copy').disabled = true;
  note('share', '');
  showFeedback(null);
  $('rebuild').hidden = true;
  const site = siteKey(tab.url);
  current = { site, started: Date.now(), done: false };
  track('scoop_start', { site });

  // Build locally while asking the library; the copy never waits on the
  // library for more than its short timeout.
  const local = scoopCurrentTab();
  local.catch(() => {});
  // Private hostnames never reach the library, not even to ask.
  const ask = !skipLibrary && (devLibrary || !isPrivateHost(new URL(tab.url).hostname));
  const best = ask ? await library.best(site) : null;
  const shared = best?.ok ? best.data?.skill : null;

  if (shared?.sections?.length) {
    const scoop = await local.catch(() => null);
    const sections = withCurrentPage(shared.sections, currentPageSection(scoop), tab.url);
    const text = buildPackage({ site, pageUrl: tab.url, sections, relatedLinks: shared.relatedLinks ?? [] });
    const ok = await copy(text);
    copied(ok);
    scoopResult('copied_ready', { scoop, text, sections, shared, clipboard: ok });
    if (ok) track('copy', { site, path: current.path, sizeBytes: sizeOf(text), trigger: 'auto' });
    note('summary', `${kb(text)} · shared, worked for ${plural(shared.worked, 'person', 'people')}`);
    $('rebuild').hidden = false;
    showFeedback(shared.id);
    return;
  }

  const scoop = await local;
  if (!scoop.sections.length) throw new Error(NO_TEXT);
  const text = buildPackage({ site, pageUrl: scoop.pageUrl, sections: scoop.sections, relatedLinks: scoop.relatedLinks });
  const ok = await copy(text);
  copied(ok);
  scoopResult('copied_ready', { scoop, text, sections: scoop.sections, clipboard: ok });
  if (ok) track('copy', { site, path: current.path, sizeBytes: sizeOf(text), trigger: 'auto' });
  note('summary', `${kb(text)} · ${plural(scoop.sections.length, 'source')} on ${site}`);
  await share(scoop);
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
  if (current && !current.done) {
    const empty = e?.message === NO_TEXT;
    scoopResult(empty ? 'empty' : 'error');
    if (!empty) track('error', { where: 'scoop', code: e?.name || 'Error', message: errorText(e) });
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
  library = createLibrary({
    baseUrl,
    installId: await getInstallId(chrome),
    client: `extension/${chrome.runtime.getManifest().version}`,
  });
  await intro();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url || '')) {
    track('scoop_result', { outcome: 'unsupported_page', durationMs: 0 });
    return status('Open a documentation page first.', 'err');
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
globalThis.addEventListener?.('pagehide', onClose);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onClose(); });

// Exported so tests can wait for the first run.
export const ready = main().catch(fail);
