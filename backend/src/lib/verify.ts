// Source verification (docs/BACKEND.md §6): every section must be what its URL
// serves to an anonymous visitor. This is what keeps injected instructions and
// private material out of the shared library. Plain TS over `fetch`, so it runs
// in Workers, Node and anything else with web streams.

import { decodeHTML } from 'entities/decode';
import { ApiError } from './errors.ts';
import { assertFetchable, siteOf } from './ssrf.ts';
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
// manual redirects so each hop is checked against the SSRF rules and the site.
export async function fetchSource(url: string, site: string, { fetchImpl = fetch, allowLocalhost = false }: VerifyOptions = {}): Promise<Fetched> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = assertFetchable(current, { allowLocalhost });
    if (siteOf(u.href) !== site) throw new ApiError('site_mismatch', `${url} redirects off ${site} (to ${u.href})`);
    let res: Response;
    try {
      res = await fetchImpl(u.href, {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new ApiError('source_unreachable', `Could not fetch ${url}: ${(e as Error).message}`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, u).href;
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

export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function isHtml(contentType: string, text: string): boolean {
  return /text\/html/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(text);
}

// HTML → plain text: drop non-content elements, replace every tag with a space
// so adjacent blocks don't glue words together, decode all HTML5 entities.
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeHTML(stripped).replace(/\s+/g, ' ').trim();
}

// Markdown → plain text: links and images keep their text, bare URLs and
// heading/emphasis/code/list/table markers go.
export function markdownToPlain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ' ')
    .replace(/[#*_`|~]/g, ' ');
}

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= ws.length; i++) out.push(ws.slice(i, i + SHINGLE).join(' '));
  return out;
}

// Share of the section's 5-word shingles that also occur in the page.
export function containment(sectionMarkdown: string, pageHtml: string): { ratio: number; count: number } {
  const mine = shingles(words(markdownToPlain(sectionMarkdown)));
  if (!mine.length) return { ratio: 0, count: 0 };
  const theirs = new Set(shingles(words(htmlToText(pageHtml))));
  const hits = mine.filter((s) => theirs.has(s)).length;
  return { ratio: hits / mine.length, count: mine.length };
}

export async function verifySection(section: Section, site: string, index: number, opts: VerifyOptions = {}): Promise<void> {
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
    return;
  }

  if (isHtml(src.contentType, src.text)) throw new ApiError('source_unreachable', `${where} serves HTML, not a text file`);

  if (section.content === null) {
    if (section.kind !== 'llms-full') throw new ApiError('invalid_request', `${where}: only llms-full sections may omit content`, 400);
    if (!src.over) throw new ApiError('source_mismatch', `${where} is small enough to include; send its content`);
    return;
  }
  if (src.over || normalizeText(src.text) !== normalizeText(section.content)) {
    throw new ApiError('source_mismatch', `${where} does not match the live file`);
  }
}

// At most 6 sections per request, fetched concurrently (validation enforces the count).
export function verifyAll(sections: Section[], site: string, opts: VerifyOptions = {}): Promise<void[]> {
  return Promise.all(sections.map((s, i) => verifySection(s, site, i, opts)));
}
