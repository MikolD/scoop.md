// No dead links in what the agent gets. Before a package built in the
// extension is copied, every http(s) URL in it (Markdown links, autolinks and
// bare URLs outside code, and the related links) is checked: first with the
// library (POST /v1/links/check, when it may be asked), then directly from
// here with HEAD (GET when HEAD isn't implemented), without cookies. Only a
// confirmed URL stays a link: [text](url) otherwise keeps its text, and a bare
// URL or autolink is never removed, just kept as code (`url`) so it isn't
// linked. Related links keep only confirmed ones. The whole check takes at
// most LINK_BUDGET_MS, inside the popup's loader.

import { isPrivateHost } from './hosts.js';

export const LINK_BUDGET_MS = 2_500;
export const BACKEND_TIMEOUT_MS = 2_000;
export const MAX_BACKEND = 200;
export const MAX_DIRECT = 80;
export const CONCURRENCY = 8;

// What an HTTP status says about a URL (after redirects are followed):
// it exists (2xx, and 400/401/403/405: the server knows the address but
// won't serve it to us), it's dead (404, 410), or we can't tell (429, 5xx).
export function linkState(status) {
  if ((status >= 200 && status < 300) || [400, 401, 403, 405].includes(status)) return 'exists';
  if (status === 404 || status === 410) return 'dead';
  return 'unknown';
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED = /^( {4}|\t)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;

// Splits Markdown into [code, text] pieces: fenced and indented code blocks
// and <pre>…</pre> are code, line by line; inline code (`…` with the same
// number of backticks to close) and <code>…</code> are code within a line.
function pieces(text) {
  const out = [];
  const push = (code, t) => {
    const last = out[out.length - 1];
    if (last && last.code === code) last.text += t;
    else out.push({ code, text: t });
  };
  const lines = text.split('\n');
  let fence = null;
  let pre = false;
  let indented = false;
  let prevBlank = true;
  let lastText = '';
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : '';
    const blank = !line.trim();
    if (fence) {
      if (line.trimStart().startsWith(fence) && !line.trim().slice(fence.length).trim()) fence = null;
      push(true, line + nl);
    } else if (pre) {
      if (/<\/pre>/i.test(line)) pre = false;
      push(true, line + nl);
    } else if (FENCE.test(line)) {
      fence = line.trimStart().match(/^(`{3,}|~{3,})/)[1];
      push(true, line + nl);
    } else if (/<pre[\s>]/i.test(line) && !/<\/pre>/i.test(line.slice(line.search(/<pre[\s>]/i)))) {
      pre = true;
      push(true, line + nl);
    } else if (!blank && INDENTED.test(line) && (indented || (prevBlank && !LIST_ITEM.test(lastText) && !INDENTED.test(lastText)))) {
      // An indented code block: after a blank line, not a list's continuation.
      indented = true;
      push(true, line + nl);
    } else {
      if (!blank) indented = false;
      inline(line + nl, push);
    }
    if (!blank && !indented) lastText = line;
    prevBlank = blank;
  });
  return out;
}

function inline(line, push) {
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    const tag = line.slice(i).search(/<code[\s>]/i);
    const at = Math.min(tick < 0 ? Infinity : tick, tag < 0 ? Infinity : i + tag);
    if (at === Infinity) break;
    push(false, line.slice(i, at));
    if (at === tick) {
      const run = line.slice(at).match(/^`+/)[0];
      // The span closes at the next run of exactly as many backticks.
      const close = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
      close.lastIndex = at + run.length;
      const m = close.exec(line);
      if (!m) { push(false, run); i = at + run.length; continue; }
      push(true, line.slice(at, m.index + run.length));
      i = m.index + run.length;
    } else {
      const end = line.toLowerCase().indexOf('</code>', at);
      const stop = end < 0 ? line.length : end + 7;
      push(true, line.slice(at, stop));
      i = stop;
    }
  }
  push(false, line.slice(i));
}

// A URL's end: whitespace, or a ")" that closes nothing opened inside it.
function urlEnd(text, from, { inLink = false } = {}) {
  let depth = 0;
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (/[\s<>"`]/.test(c)) break;
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if (!inLink && c === ']') break;
  }
  if (!inLink) while (i > from && /[.,;:!?*_~'"]/.test(text[i - 1])) i--; // trailing punctuation isn't the URL's
  return i;
}

// Calls on(kind, url, start, end, label) for each http(s) URL in a text
// piece: 'link' ([label](url "title"), not images), 'auto' (<url>), 'bare'.
function scan(text, on) {
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const m = rest.match(/!?\[([^\]\n]*)\]\(\s*<?(?=https?:\/\/)|<(?=https?:\/\/[^\s>]+>)|\bhttps?:\/\//);
    if (!m) return;
    const at = i + m.index;
    if (m[0].startsWith('<') && !m[0].startsWith('<[')) {
      const end = text.indexOf('>', at);
      on('auto', text.slice(at + 1, end), at, end + 1);
      i = end + 1;
    } else if (m[0].includes('[')) {
      const urlStart = at + m[0].length;
      const angled = m[0].endsWith('<');
      const urlStop = angled ? text.indexOf('>', urlStart) : urlEnd(text, urlStart, { inLink: true });
      const tail = text.slice(angled ? urlStop + 1 : urlStop).match(/^\s*(?:"[^"\n]*"|'[^'\n]*')?\s*\)/);
      if (!tail) { i = urlStart; continue; }
      const end = (angled ? urlStop + 1 : urlStop) + tail[0].length;
      if (!m[0].startsWith('!')) on('link', text.slice(urlStart, urlStop), at, end, m[1]);
      i = end;
    } else {
      const end = urlEnd(text, at);
      on('bare', text.slice(at, end), at, end);
      i = Math.max(end, at + 1);
    }
  }
}

// Every http(s) URL in the texts outside code, and the related links' URLs.
export function collectLinks(texts, related = []) {
  const urls = new Set();
  for (const text of texts) {
    if (!text) continue;
    for (const p of pieces(text)) if (!p.code) scan(p.text, (kind, url) => urls.add(url));
  }
  for (const l of related) if (/^https?:\/\//.test(l?.url ?? '')) urls.add(l.url);
  return [...urls];
}

const asCode = (url) => `\`${url}\``;

// Confirmed URLs stay as they are. Otherwise [text](url) keeps its text (a
// URL as text is kept as code), and a bare URL or <url> is kept as `url`.
export function unlink(text, ok) {
  if (!text) return text;
  return pieces(text).map((p) => {
    if (p.code) return p.text;
    let out = '';
    let last = 0;
    scan(p.text, (kind, url, start, end, label) => {
      if (ok.has(url)) return;
      out += p.text.slice(last, start);
      if (kind === 'link') out += /^https?:\/\/\S+$/.test(label.trim()) ? asCode(label.trim()) : label;
      else out += asCode(url);
      last = end;
    });
    return out + p.text.slice(last);
  }).join('');
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

// 'exists', 'dead' or 'unknown' (a timeout, 429 or 5xx). A network error
// (DNS, refused) is dead.
async function direct(url, fetchImpl, signal) {
  const init = { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal };
  try {
    let res = await fetchImpl(url, { ...init, method: 'HEAD' });
    // A server that doesn't implement HEAD: ask again with GET (the body is not read).
    if (res.status === 501) {
      res = await fetchImpl(url, { ...init, method: 'GET' });
      res.body?.cancel?.().catch?.(() => {});
    }
    return linkState(res.status);
  } catch {
    return signal.aborted ? 'unknown' : 'dead';
  }
}

// Returns the set of confirmed URLs. useBackend: the library may be asked
// (it is reachable and sharing is on); private hosts never go to it.
export async function checkLinks(urls, { library = null, useBackend = false, fetchImpl = (...a) => fetch(...a), budgetMs = LINK_BUDGET_MS, now = () => Date.now() } = {}) {
  const ok = new Set();
  if (!urls.length) return ok;
  const deadline = now() + budgetMs;
  let unknown = urls;
  if (useBackend && library?.checkLinks) {
    const asked = urls.filter((u) => !isPrivateHost(hostOf(u))).slice(0, MAX_BACKEND);
    if (asked.length) {
      const res = await library.checkLinks(asked, { timeoutMs: Math.max(1, Math.min(BACKEND_TIMEOUT_MS, deadline - now())) });
      if (res.ok) {
        const bad = new Set(res.data?.bad ?? []);
        for (const u of res.data?.ok ?? []) ok.add(u);
        unknown = urls.filter((u) => !ok.has(u) && !bad.has(u));
      }
    }
  }
  // Direct checks, 8 at a time, until the budget runs out. Dead, unknown or
  // unchecked = not confirmed.
  const queue = unknown.slice(0, MAX_DIRECT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - now()));
  async function worker() {
    while (queue.length && now() < deadline) {
      const url = queue.shift();
      if ((await direct(url, fetchImpl, controller.signal)) === 'exists') ok.add(url);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearTimeout(timer);
  return ok;
}

// The sections, related links and the site's instructions for agents of a
// package, with only confirmed links (an instruction keeps its text, not a
// source that doesn't work).
export async function withLiveLinks({ sections, relatedLinks = [], instructions = [] }, options) {
  const sources = instructions.filter((i) => i?.url).map((i) => ({ url: i.url }));
  const urls = collectLinks(sections.map((s) => s.content), [...relatedLinks, ...sources]);
  const ok = await checkLinks(urls, options);
  return {
    sections: sections.map((s) => (s.content ? { ...s, content: unlink(s.content, ok) } : s)),
    relatedLinks: relatedLinks.filter((l) => ok.has(l.url)),
    instructions: instructions.map((i) => (i?.url && !ok.has(i.url) ? { ...i, url: null } : i)),
    checked: urls.length,
    unlinked: urls.filter((u) => !ok.has(u)).length,
  };
}
