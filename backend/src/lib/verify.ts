// Source verification (docs/BACKEND.md §6): every section must be what its URL
// serves to an anonymous visitor. This is what keeps injected instructions and
// private material out of the shared library. Plain TS over `fetch`, so it runs
// in Workers, Node and anything else with web streams.

import { decodeHTML } from 'entities/decode';
import { ApiError } from './errors.ts';
import { cleanText, markdownTitle, MAX_TITLE } from './skilltext.ts';
import { assertFetchable, normalizeSite, siteOf } from './ssrf.ts';
import type { Section } from './types.ts';

export const FETCH_CAP = 2_000_000;
export const HTML_THRESHOLD = 0.85;
const SHINGLE = 5;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'scoop.md-verifier/1 (+https://scoop.md)';

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;
export interface VerifyOptions {
  fetchImpl?: FetchImpl;
  allowLocalhost?: boolean;
}

interface Fetched {
  contentType: string;
  text: string;
  over: boolean;
}

async function readCapped(res: Response, cap: number): Promise<{ text: string; over: boolean }> {
  if (!res.body) return { text: '', over: false };
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

// Anonymous fetch: no cookies, no auth, none of the client's headers, and
// manual redirects so each hop is checked against the site and the SSRF rules.
// One timeout covers every hop and the body.
export async function fetchSource(url: string, site: string, { fetchImpl = fetch, allowLocalhost = false }: VerifyOptions = {}): Promise<Fetched> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = assertFetchable(url, { allowLocalhost });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (siteOf(current.href) !== site) throw new ApiError('site_mismatch', `${url} redirects off ${site} (to ${current.href})`);
    let res: Response;
    try {
      res = await fetchImpl(current.href, { redirect: 'manual', headers: { 'user-agent': USER_AGENT }, signal });
    } catch (e) {
      throw new ApiError('source_unreachable', `Could not fetch ${url}: ${(e as Error).message}`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = redirectTarget(location, current, url, site, allowLocalhost);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ApiError('source_unreachable', `${url} answered ${res.status}`);
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
      throw new ApiError('source_unreachable', `Could not read ${url}: ${(e as Error).message}`);
    }
  }
  throw new ApiError('source_unreachable', `${url} redirects too many times`);
}

// A redirect is the source's doing, not the client's, so a bad target is 422.
function redirectTarget(location: string, from: URL, url: string, site: string, allowLocalhost: boolean): URL {
  let next: URL;
  try { next = new URL(location, from); } catch { throw new ApiError('source_unreachable', `${url} redirects to an invalid URL`); }
  try {
    return assertFetchable(next.href, { allowLocalhost });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'invalid_request') {
      // Off-site targets (private IPs included) are reported as such.
      if (normalizeSite(next.hostname) !== site) throw new ApiError('site_mismatch', `${url} redirects off ${site} (to ${next.origin})`);
      throw new ApiError('source_unreachable', `${url} redirects to a URL that may not be fetched (${next.origin})`);
    }
    throw e;
  }
}

// CRLF → LF, trailing spaces/tabs off every line, whole text trimmed. Written
// as a scan: /[ \t]+$/gm is quadratic on long runs of spaces mid-line.
export function normalizeText(s: string): string {
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let end = line.length;
    while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    if (end !== line.length) lines[i] = line.slice(0, end);
  }
  return lines.join('\n').trim();
}

function isHtml(contentType: string, text: string): boolean {
  return /text\/html/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(text);
}

const DROPPED = new Set(['script', 'style', 'noscript', 'template']);

const isAsciiLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

// HTML → plain text: drop non-content elements, replace every tag with a space
// so adjacent blocks don't glue words together, decode all HTML5 entities.
// A single linear scan; regexes here go quadratic on input like '<script ' × n.
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const n = html.length;
  // Next closing tag per dropped element, so a missing one is searched for once.
  const nextClose = new Map<string, number>();
  const closeAfter = (name: string, from: number): number => {
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

  // Next '-->' likewise, so a run of unclosed '<!--' doesn't rescan to the end.
  let commentEnd = -2;

  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out.push(html.slice(i)); break; }
    if (lt > i) out.push(html.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      if (commentEnd !== -1 && commentEnd < lt + 4) commentEnd = html.indexOf('-->', lt + 4);
      if (commentEnd !== -1) { out.push(' '); i = commentEnd + 3; continue; }
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
  return decodeHTML(out.join('')).replace(/\s\s+|[^\S ]/g, ' ').trim();
}

const MAX_LINK_TARGET = 2048;

// Markdown → plain text: links and images keep their text, link targets and
// bare URLs go. The link target is found by scanning (capped at
// MAX_LINK_TARGET), not by regex.
export function markdownToPlain(md: string): string {
  const out: string[] = [];
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
  // Ordered-list numbers would count as words; the page's <ol> doesn't show
  // them as text. Other markers (#, *, -, >, |, `) need no pass of their own:
  // shingling splits on letters and digits, which drops them.
  return out
    .join('')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[ \t]{0,3}\d{1,9}[.)][ \t]+/gm, ' ');
}

// 53-bit hash (cyrb53) of one shingle: its words, space-separated, under `seed`.
function shingleHash(ring: string[], first: number, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let k = 0; k < SHINGLE; k++) {
    const w = ring[(first + k) % SHINGLE];
    for (let i = 0; i <= w.length; i++) {
      const c = i < w.length ? w.charCodeAt(i) : 32;
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// 5-word shingles of the lowercased words in `text`, each a 53-bit hash under
// `seed`. Numbers instead of joined strings keep a 2 MB page's shingle set
// small. Both sides of one comparison must use the same seed; a fresh random
// seed per comparison means colliding shingles can't be prepared offline.
export function shingleHashes(text: string, seed: number): number[] {
  const out: number[] = [];
  const ring: string[] = new Array(SHINGLE).fill('');
  let count = 0;
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    ring[count % SHINGLE] = m[0];
    count++;
    if (count >= SHINGLE) out.push(shingleHash(ring, count - SHINGLE, seed));
  }
  return out;
}

// The page's <title>, else its first <h1>, as plain text. indexOf scans only,
// so a crafted 2 MB page stays linear. <title> is looked for in <head> alone,
// since SVG icons in the body carry <title> elements of their own.
export function htmlTitle(html: string): string {
  const lower = html.toLowerCase();
  const head = lower.indexOf('</head');
  for (const [tag, end] of [['title', head < 0 ? lower.length : head], ['h1', lower.length]] as const) {
    let at = lower.indexOf(`<${tag}`);
    while (at !== -1 && at < end && !/[\s>/]/.test(lower[at + tag.length + 1] ?? '')) at = lower.indexOf(`<${tag}`, at + 1);
    if (at === -1 || at >= end) continue;
    const open = lower.indexOf('>', at);
    const close = open === -1 ? -1 : lower.indexOf(`</${tag}`, open);
    if (close === -1) continue;
    const text = cleanText(htmlToText(html.slice(open + 1, close)), MAX_TITLE);
    if (text) return text;
  }
  return '';
}

// Share of the section's 5-word shingles that also occur in the page.
export function containment(sectionMarkdown: string, pageHtml: string): { ratio: number; count: number } {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const mine = shingleHashes(markdownToPlain(sectionMarkdown), seed);
  if (!mine.length) return { ratio: 0, count: 0 };
  const theirs = new Set(shingleHashes(htmlToText(pageHtml), seed));
  const hits = mine.filter((s) => theirs.has(s)).length;
  return { ratio: hits / mine.length, count: mine.length };
}

// Resolves to the title read from the verified source (the HTML <title>/<h1>
// for page-html, the Markdown H1 for page-md, '' otherwise), which the server
// uses instead of any client-sent label (skilltext.ts).
export async function verifySection(section: Section, site: string, index: number, opts: VerifyOptions = {}): Promise<string> {
  const where = `Section ${index + 1} (${section.url})`;
  if (siteOf(section.url) !== site) throw new ApiError('site_mismatch', `${where} is not on ${site}`);
  const src = await fetchSource(section.url, site, opts);

  if (section.kind === 'page-html') {
    if (src.over) throw new ApiError('source_unreachable', `${where} is larger than ${FETCH_CAP} bytes`);
    if (!isHtml(src.contentType, src.text)) throw new ApiError('source_mismatch', `${where} is not an HTML page`);
    const { ratio, count } = containment(section.content ?? '', src.text);
    const needed = count < 20 ? 1 : HTML_THRESHOLD;
    if (ratio < needed) {
      throw new ApiError('source_mismatch', `${where} matches ${Math.round(ratio * 100)}% of the live page; ${Math.round(needed * 100)}% required`);
    }
    return htmlTitle(src.text);
  }

  if (isHtml(src.contentType, src.text)) throw new ApiError('source_unreachable', `${where} serves HTML, not a text file`);

  if (section.content === null) {
    if (section.kind !== 'llms-full') throw new ApiError('invalid_request', `${where}: only llms-full sections may omit content`, 400);
    if (!src.over) throw new ApiError('source_mismatch', `${where} is small enough to include; send its content`);
    return '';
  }
  if (src.over || normalizeText(src.text) !== normalizeText(section.content)) {
    throw new ApiError('source_mismatch', `${where} does not match the live file`);
  }
  return section.kind === 'page-md' ? markdownTitle(section.content) : '';
}

// At most 6 sections per request (validation enforces the count). Text sections
// are verified concurrently; page-html sections one at a time, since each holds
// a whole page and its shingle set in memory. Resolves to each section's title.
export async function verifyAll(sections: Section[], site: string, opts: VerifyOptions = {}): Promise<string[]> {
  const titles: string[] = sections.map(() => '');
  const htmlOneByOne = async () => {
    for (const [i, s] of sections.entries()) if (s.kind === 'page-html') titles[i] = await verifySection(s, site, i, opts);
  };
  await Promise.all([
    ...sections.map(async (s, i) => { if (s.kind !== 'page-html') titles[i] = await verifySection(s, site, i, opts); }),
    htmlOneByOne(),
  ]);
  return titles;
}
