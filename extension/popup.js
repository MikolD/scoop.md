import { siteKey } from './lib/discover.js';
import { buildPackage, withCurrentPage } from './lib/package.js';
import { scoopPage, currentPageSection, isPrivateHost } from './lib/scoop.js';
import { DEFAULT_LIBRARY, libraryUrl, createLibrary, shareBody, notSharedReason, withoutSectionQuery } from './lib/library.js';

const DEFAULTS = { share: true };
const $ = (id) => document.getElementById(id);

let settings;
let library;
let devLibrary = false;
let tab;
let clipboardText = '';
let skillId = null;

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

async function run({ skipLibrary = false } = {}) {
  status('Scooping this page…', 'busy');
  $('copy').disabled = true;
  note('share', '');
  showFeedback(null);
  $('rebuild').hidden = true;
  const site = siteKey(tab.url);

  // Build locally while asking the library; the copy never waits on the
  // library for more than its short timeout.
  const local = scoopCurrentTab();
  local.catch(() => {});
  // Private hostnames never reach the library, not even to ask.
  const ask = !skipLibrary && (devLibrary || !isPrivateHost(new URL(tab.url).hostname));
  const best = ask ? await library.best(site) : null;
  const shared = best?.ok ? best.data?.skill : null;

  if (shared?.sections?.length) {
    const current = currentPageSection(await local.catch(() => null));
    const sections = withCurrentPage(shared.sections, current, tab.url);
    const text = buildPackage({ site, pageUrl: tab.url, sections, relatedLinks: shared.relatedLinks ?? [] });
    const ok = await copy(text);
    copied(ok);
    note('summary', `${kb(text)} · shared, worked for ${plural(shared.worked, 'person', 'people')}`);
    $('rebuild').hidden = false;
    showFeedback(shared.id);
    return;
  }

  const scoop = await local;
  if (!scoop.sections.length) throw new Error('Could not find any documentation text on this page.');
  const text = buildPackage({ site, pageUrl: scoop.pageUrl, sections: scoop.sections, relatedLinks: scoop.relatedLinks });
  const ok = await copy(text);
  copied(ok);
  note('summary', `${kb(text)} · ${plural(scoop.sections.length, 'source')} on ${site}`);
  await share(scoop);
}

async function share(scoop) {
  if (!settings.share) return note('share', 'Not shared: sharing is off.');
  if (!scoop.isPublic) {
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
  if (res.error?.code === 'offline' || res.error?.code === 'timeout') return note('share', '');
  if (!res.ok) return note('share', `Not shared: ${notSharedReason(res.error, scoop.sections)}`, 'warn');
  note('share', res.data.duplicate ? 'Already in the library.' : 'Shared with the library.');
  showFeedback(res.data.id);
}

async function vote(worked) {
  const res = await library.feedback(skillId, worked);
  note('voted', res.ok
    ? `Thanks. It worked for ${plural(res.data.worked, 'person', 'people')} and didn't for ${res.data.failed}.`
    : "Couldn't record your vote. Try again in a moment.");
}

async function report(reason) {
  const res = await library.report(skillId, reason);
  $('report').hidden = true;
  note('voted', res.ok ? 'Reported. Thanks, we will review it.' : "Couldn't send the report. Try again in a moment.");
}

async function installId() {
  let { installId: id } = await chrome.storage.local.get('installId');
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ installId: id });
  }
  return id;
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

const fail = (e) => status(e?.message || String(e), 'err');

$('theme').onclick = async () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'light' : 'dark';
  applyTheme(theme);
  try { await chrome.storage.local.set({ theme }); } catch {}
};
$('copy').onclick = async () => {
  if (!(await writeClipboard(clipboardText))) return status("Couldn't copy. Try again.", 'err');
  status('Copied again.');
  $('copy-label').textContent = 'Copied';
  setTimeout(() => { $('copy-label').textContent = 'Copy for your agent'; }, 1500);
};
$('rebuild').onclick = () => run({ skipLibrary: true }).catch(fail);
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
    installId: await installId(),
    client: `extension/${chrome.runtime.getManifest().version}`,
  });
  await intro();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:/.test(tab?.url || '')) return status('Open a documentation page first.', 'err');
  await run();
}

// Exported so tests can wait for the first run.
export const ready = main().catch(fail);
