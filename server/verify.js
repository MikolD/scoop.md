// Source verification (docs/BACKEND.md §6): every section must be what its URL
// serves to an anonymous visitor. This is what keeps injected instructions and
// private material out of the shared library.

export const FETCH_CAP = 2_000_000;
export const HTML_THRESHOLD = 0.85;
const SHINGLE = 5;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;

export class VerifyError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizeSite(host) {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

export function siteOf(url) {
  return normalizeSite(new URL(url).hostname);
}

// SSRF guard. Returns the parsed URL or throws 400 invalid_request.
export function assertFetchable(raw, { allowLocalhost = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new VerifyError('invalid_request', `Not a URL: ${raw}`, 400); }
  const host = u.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (allowLocalhost && isLocal) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new VerifyError('invalid_request', `Unsupported scheme: ${raw}`, 400);
    return u;
  }
  if (u.protocol !== 'https:') throw new VerifyError('invalid_request', `Only https URLs are accepted: ${raw}`, 400);
  if (u.port && u.port !== '443') throw new VerifyError('invalid_request', `Non-standard port: ${raw}`, 400);
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
  if (ipLiteral || host === 'localhost' || /\.(local|internal|localhost|test)$/.test(host)) {
    throw new VerifyError('invalid_request', `Host not allowed: ${host}`, 400);
  }
  return u;
}

async function readCapped(res, cap) {
  if (!res.body?.getReader) {
    const text = await res.text();
    return { text: text.slice(0, cap), over: text.length > cap };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), over: false };
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return { text, over: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}

// Anonymous fetch: no cookies, no auth, manual redirects so each hop is
// checked against the site and the SSRF rules. One timeout covers every hop
// and the body.
export async function fetchSource(url, site, { fetchImpl = fetch, allowLocalhost = false } = {}) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = assertFetchable(url, { allowLocalhost });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (siteOf(current.href) !== site) throw new VerifyError('site_mismatch', `${url} redirects off ${site} (to ${current.href})`);
    let res;
    try {
      res = await fetchImpl(current.href, {
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'user-agent': 'scoop.md-verifier/1 (+https://scoop.md)' },
        signal,
      });
    } catch (e) {
      throw new VerifyError('source_unreachable', `Could not fetch ${url}: ${e.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = redirectTarget(res.headers.get('location'), current, url, site, allowLocalhost);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new VerifyError('source_unreachable', `${url} answered ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length')) || 0;
    const contentType = res.headers.get('content-type') || '';
    if (declared > FETCH_CAP) {
      await res.body?.cancel();
      return { contentType, text: '', over: true };
    }
    try {
      return { contentType, ...(await readCapped(res, FETCH_CAP)) };
    } catch (e) {
      throw new VerifyError('source_unreachable', `Could not read ${url}: ${e.message}`);
    }
  }
  throw new VerifyError('source_unreachable', `${url} redirects too many times`);
}

// A redirect is the source's doing, not the client's, so a bad target is 422.
function redirectTarget(location, from, url, site, allowLocalhost) {
  let next;
  try { next = new URL(location, from); } catch { throw new VerifyError('source_unreachable', `${url} redirects to an invalid URL`); }
  try {
    return assertFetchable(next.href, { allowLocalhost });
  } catch (e) {
    if (e instanceof VerifyError && e.code === 'invalid_request') {
      // Off-site targets (private IPs included) are reported as such.
      if (normalizeSite(next.hostname) !== site) throw new VerifyError('site_mismatch', `${url} redirects off ${site} (to ${next.origin})`);
      throw new VerifyError('source_unreachable', `${url} redirects to a URL that may not be fetched (${next.origin})`);
    }
    throw e;
  }
}

// CRLF → LF, trailing spaces/tabs off every line, whole text trimmed. Written
// as a scan: /[ \t]+$/gm is quadratic on long runs of spaces mid-line.
export function normalizeText(s) {
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let end = line.length;
    while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    if (end !== line.length) lines[i] = line.slice(0, end);
  }
  return lines.join('\n').trim();
}

function isHtml(contentType, text) {
  return /text\/html/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(text);
}

// Common named entities in docs prose. The production Worker should decode the
// full HTML5 table (docs/BACKEND.md §6); unknown names are left as-is, which
// costs a few shingles but never a false match.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–',
  hellip: '…', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  times: '×', rarr: '→', larr: '←', laquo: '«', raquo: '»', deg: '°',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,32});/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  });
}

const DROPPED = new Set(['script', 'style', 'noscript', 'template']);

const isAsciiLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

// HTML → plain text: drop non-content elements, replace every tag with a space
// so adjacent blocks don't glue words together, decode entities. A single
// linear scan; regexes here go quadratic on input like '<script ' × n.
export function htmlToText(html) {
  const lower = html.toLowerCase();
  const n = html.length;
  // Next closing tag per dropped element, so a missing one is searched for once.
  const nextClose = new Map();
  const closeAfter = (name, from) => {
    const cached = nextClose.get(name);
    if (cached !== undefined && (cached === -1 || cached >= from)) return cached;
    let at = lower.indexOf(`</${name}`, from);
    // `</script foo>` is not a closing tag; only whitespace may precede '>'.
    while (at !== -1) {
      let j = at + 2 + name.length;
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === '>') break;
      at = lower.indexOf(`</${name}`, at + 1);
    }
    nextClose.set(name, at);
    return at;
  };

  const out = [];
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out.push(html.slice(i)); break; }
    if (lt > i) out.push(html.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end !== -1) { out.push(' '); i = end + 3; continue; }
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) { out.push(html.slice(lt)); break; } // no tag can start from here on
    if (gt === lt + 1) { out.push('<>'); i = gt + 1; continue; }
    let j = lt + 1;
    while (j < gt && isAsciiLetter(html.charCodeAt(j))) j++;
    const name = lower.slice(lt + 1, j);
    if (DROPPED.has(name)) {
      const close = closeAfter(name, gt + 1);
      if (close !== -1) { out.push(' '); i = html.indexOf('>', close) + 1; continue; }
    }
    out.push(' ');
    i = gt + 1;
  }
  // Collapse whitespace; single spaces (the common case) are left alone.
  return decodeEntities(out.join('')).replace(/\s\s+|[^\S ]/g, ' ').trim();
}

const MAX_LINK_TARGET = 2048;

// Markdown → plain text: links and images keep their text, link targets and
// bare URLs go. The link target is found by scanning (capped at
// MAX_LINK_TARGET), not by regex.
export function markdownToPlain(md) {
  const out = [];
  let kept = 0; // start of the text not yet copied to `out`
  let from = 0; // where to look for the next ']('
  let nextParen = -2; // cached index of the next ')' after the current '](' (-1: none left)
  for (;;) {
    const open = md.indexOf('](', from);
    if (open === -1) break;
    from = open + 2;
    if (nextParen !== -1 && nextParen < from) nextParen = md.indexOf(')', from);
    if (nextParen === -1) break;
    if (nextParen - from > MAX_LINK_TARGET) continue;
    out.push(md.slice(kept, open), ' ');
    kept = from = nextParen + 1;
  }
  out.push(md.slice(kept));
  // Heading, emphasis, code, list, quote and table markers need no pass of
  // their own: shingling splits on letters and digits, which drops them.
  return out.join('').replace(/https?:\/\/\S+/g, ' ');
}

// 32-bit FNV-1a of one word.
function hashWord(w) {
  let h = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// 5-word shingles of the lowercased words in `text`, each hashed to 32 bits.
// Numbers instead of joined strings keep a 2 MB page's shingle set small; a
// hash collision can only add a match by chance (about 1 in 4 billion per lookup
// per shingle of the page), never remove one.
export function shingleHashes(text) {
  const out = [];
  const ring = new Array(SHINGLE).fill(0);
  let count = 0;
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    ring[count % SHINGLE] = hashWord(m[0]);
    count++;
    if (count < SHINGLE) continue;
    let h = 0x811c9dc5;
    for (let k = count - SHINGLE; k < count; k++) h = Math.imul(h ^ ring[k % SHINGLE], 0x01000193);
    out.push(h >>> 0);
  }
  return out;
}

// Share of the section's 5-word shingles that also occur in the page.
export function containment(sectionMarkdown, pageHtml) {
  const mine = shingleHashes(markdownToPlain(sectionMarkdown));
  if (!mine.length) return { ratio: 0, count: 0 };
  const theirs = new Set(shingleHashes(htmlToText(pageHtml)));
  const hits = mine.filter((s) => theirs.has(s)).length;
  return { ratio: hits / mine.length, count: mine.length };
}

export async function verifySection(section, site, index, opts = {}) {
  const where = `Section ${index + 1} (${section.url})`;
  if (siteOf(section.url) !== site) throw new VerifyError('site_mismatch', `${where} is not on ${site}`);
  const src = await fetchSource(section.url, site, opts);

  if (section.kind === 'page-html') {
    if (src.over) throw new VerifyError('source_unreachable', `${where} is larger than ${FETCH_CAP} bytes`);
    if (!isHtml(src.contentType, src.text)) throw new VerifyError('source_mismatch', `${where} is not an HTML page`);
    const { ratio, count } = containment(section.content, src.text);
    const needed = count < 20 ? 1 : HTML_THRESHOLD;
    if (ratio < needed) {
      throw new VerifyError('source_mismatch', `${where} matches ${Math.round(ratio * 100)}% of the live page; ${Math.round(needed * 100)}% required`);
    }
    return;
  }

  if (isHtml(src.contentType, src.text)) throw new VerifyError('source_unreachable', `${where} serves HTML, not a text file`);

  if (section.content === null) {
    if (section.kind !== 'llms-full') throw new VerifyError('invalid_request', `${where}: only llms-full sections may omit content`, 400);
    if (!src.over) throw new VerifyError('source_mismatch', `${where} is small enough to include; send its content`);
    return;
  }
  if (src.over || normalizeText(src.text) !== normalizeText(section.content)) {
    throw new VerifyError('source_mismatch', `${where} does not match the live file`);
  }
}
