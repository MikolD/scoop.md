// No dead links in what the agent gets. Before a package built in the
// extension is copied, every http(s) link in it (Markdown links outside code,
// and the related links) is checked: first with the library (POST
// /v1/links/check, when it may be asked), then directly from here with HEAD
// (GET when HEAD is refused), without cookies. A link that is bad, or that
// couldn't be confirmed within the time budget, is unlinked: its text stays,
// its URL goes. Related links keep only confirmed ones. The whole check takes
// at most LINK_BUDGET_MS, inside the popup's loader.

import { isPrivateHost } from './hosts.js';

export const LINK_BUDGET_MS = 2_500;
export const BACKEND_TIMEOUT_MS = 2_000;
export const MAX_BACKEND = 200;
export const MAX_DIRECT = 80;
export const CONCURRENCY = 8;

// [text](url) or [text](url "title"), not images.
const MD_LINK = /(?<!!)\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"\n]*")?\)/g;
const FENCE = /^(```|~~~)/;

// Runs fn over the parts of a Markdown text outside fenced code blocks.
function outsideCode(text, fn) {
  const lines = text.split('\n');
  let inCode = false;
  let chunk = [];
  const out = [];
  const flush = () => {
    if (chunk.length) out.push(fn(chunk.join('\n')));
    chunk = [];
  };
  for (const line of lines) {
    if (FENCE.test(line.trimStart())) {
      if (!inCode) flush();
      inCode = !inCode;
      out.push(line);
      continue;
    }
    if (inCode) out.push(line);
    else chunk.push(line);
  }
  flush();
  return out.join('\n');
}

// Every http(s) link target in the texts, and the related links' URLs.
export function collectLinks(texts, related = []) {
  const urls = new Set();
  for (const text of texts) {
    if (!text) continue;
    outsideCode(text, (part) => {
      for (const m of part.matchAll(MD_LINK)) urls.add(m[2]);
      return part;
    });
  }
  for (const l of related) if (/^https?:\/\//.test(l?.url ?? '')) urls.add(l.url);
  return [...urls];
}

// Keeps [text](url) for confirmed URLs; otherwise just text.
export function unlink(text, ok) {
  if (!text) return text;
  return outsideCode(text, (part) => part.replace(MD_LINK, (all, label, url) => (ok.has(url) ? all : label)));
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

async function direct(url, fetchImpl, signal) {
  const init = { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal };
  try {
    let res = await fetchImpl(url, { ...init, method: 'HEAD' });
    // Some servers refuse HEAD; ask again with GET (the body is not read).
    if ([403, 405, 501].includes(res.status)) {
      res = await fetchImpl(url, { ...init, method: 'GET' });
      res.body?.cancel?.().catch?.(() => {});
    }
    return res.ok;
  } catch {
    return false;
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
  // Direct checks, 8 at a time, until the budget runs out. Unchecked = not confirmed.
  const queue = unknown.slice(0, MAX_DIRECT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - now()));
  async function worker() {
    while (queue.length && now() < deadline) {
      const url = queue.shift();
      if (await direct(url, fetchImpl, controller.signal)) ok.add(url);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearTimeout(timer);
  return ok;
}

// The sections and related links of a local package, with only confirmed links.
export async function withLiveLinks({ sections, relatedLinks = [] }, options) {
  const urls = collectLinks(sections.map((s) => s.content), relatedLinks);
  const ok = await checkLinks(urls, options);
  return {
    sections: sections.map((s) => (s.content ? { ...s, content: unlink(s.content, ok) } : s)),
    relatedLinks: relatedLinks.filter((l) => ok.has(l.url)),
    checked: urls.length,
    unlinked: urls.filter((u) => !ok.has(u)).length,
  };
}
