// Request validation and limits (docs/BACKEND.md §4, §8). Cheap checks only;
// nothing here fetches.

import { ApiError, bad } from './errors.ts';
import { assertFetchable, normalizeSite, siteOf } from './ssrf.ts';
import { normalizePageUrl } from './urls.ts';
import type { NewSkill, RelatedLink, Section, SectionKind } from './types.ts';

export const MAX_BODY = 6_000_000;
export const MAX_SECTION = 2_000_000;
export const MAX_SECTIONS = 6;
export const MAX_LINKS = 100;
export const MAX_DETAILS = 2000;
const KINDS = new Set<SectionKind>(['page-md', 'llms', 'llms-full', 'page-html']);
export const REASONS = new Set(['malicious', 'wrong', 'copyright', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function installId(header: string | null): string {
  if (!header || !UUID.test(header)) throw bad('X-Scoop-Install must be a UUID v4');
  return header.toLowerCase();
}

function str(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.length || v.length > max) throw bad(`${name} must be a string of 1–${max} characters`);
  return v;
}

// Section URLs are stored, and reach agents, as the server's canonical form:
// a plain fragment dropped (a '#/' client route kept, see urls.ts), and a
// query string refused if it is long or decodes to whitespace or control
// characters, since a query can spell out instructions as well as parameters.
export const MAX_QUERY = 200;
function sectionUrl(raw: string, i: number): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw bad(`sections[${i}].url is not a URL`); }
  if (u.search) {
    let decoded: string;
    try { decoded = decodeURIComponent(u.search.slice(1).replace(/\+/g, ' ')); } catch { decoded = ' '; }
    if (u.search.length > MAX_QUERY || /[\s\p{Cc}\p{Cf}]/u.test(decoded)) {
      throw bad(`sections[${i}].url has a query string that isn't a plain parameter list (at most ${MAX_QUERY} characters, no spaces or control characters)`);
    }
  }
  return normalizePageUrl(u);
}

export function validateSkill(body: unknown, allowLocalhost: boolean): NewSkill {
  if (!isObject(body)) throw bad('Body must be a JSON object');
  const site = normalizeSite(str(body.site, 'site', 253));
  if (site === 'scoop.md' || site.endsWith('.scoop.md')) throw bad('scoop.md itself cannot be shared');
  const pageUrl = str(body.pageUrl, 'pageUrl', 2048);
  assertFetchable(pageUrl, { allowLocalhost });
  if (siteOf(pageUrl) !== site) throw new ApiError('site_mismatch', `pageUrl is not on ${site}`);
  // title, section labels and related-link text are accepted for compatibility
  // and discarded: the server writes its own after verification (skilltext.ts).

  if (!Array.isArray(body.sections) || body.sections.length < 1 || body.sections.length > MAX_SECTIONS) {
    throw bad(`sections must have 1–${MAX_SECTIONS} items`);
  }
  const sections = body.sections.map((s: unknown, i): Section => {
    if (!isObject(s) || !KINDS.has(s.kind as SectionKind)) throw bad(`sections[${i}].kind is invalid`);
    const kind = s.kind as SectionKind;
    const url = sectionUrl(str(s.url, `sections[${i}].url`, 2048), i);
    assertFetchable(url, { allowLocalhost });
    if (siteOf(url) !== site) throw new ApiError('site_mismatch', `Section ${i + 1} (${url}) is not on ${site}`);
    const content = s.content ?? null;
    if (content !== null && typeof content !== 'string') throw bad(`sections[${i}].content must be a string or null`);
    if (content !== null && content.length > MAX_SECTION) throw new ApiError('too_large', `sections[${i}].content is over ${MAX_SECTION} characters`, 413);
    if (content === null) {
      if (kind !== 'llms-full') throw bad(`sections[${i}]: only llms-full sections may omit content`);
      if (!(Number.isInteger(s.bytes) && (s.bytes as number) > 0)) throw bad(`sections[${i}].bytes is required when content is null`);
    }
    return { kind, label: '', url, content, bytes: content === null ? (s.bytes as number) : null };
  });

  const links = body.relatedLinks ?? [];
  if (!Array.isArray(links) || links.length > MAX_LINKS) throw bad(`relatedLinks must have at most ${MAX_LINKS} items`);
  const relatedLinks = links.map((l: unknown, i): RelatedLink => {
    const url = str(isObject(l) ? l.url : undefined, `relatedLinks[${i}].url`, 2048);
    let u: URL;
    try { u = new URL(url); } catch { throw bad(`relatedLinks[${i}].url is not a URL`); }
    if (!/^https?:$/.test(u.protocol)) throw bad(`relatedLinks[${i}].url must be http(s)`);
    if (siteOf(url) !== site) throw new ApiError('site_mismatch', `relatedLinks[${i}] is not on ${site}`);
    return { url, text: '' };
  });

  return { site, pageUrl, title: '', sections, relatedLinks };
}

export function validateFeedback(body: unknown): boolean {
  if (!isObject(body) || typeof body.worked !== 'boolean') throw bad('worked must be true or false');
  return body.worked;
}

export interface NewReport {
  skillId: string;
  reason: string;
  details: string | null;
}

export function validateReport(body: unknown): NewReport {
  if (!isObject(body)) throw bad('Body must be a JSON object');
  const skillId = str(body.skillId, 'skillId', 64);
  if (typeof body.reason !== 'string' || !REASONS.has(body.reason)) throw bad('reason must be malicious, wrong, copyright or other');
  if (body.details !== undefined && body.details !== null && (typeof body.details !== 'string' || body.details.length > MAX_DETAILS)) {
    throw bad(`details must be at most ${MAX_DETAILS} characters`);
  }
  return { skillId, reason: body.reason, details: (body.details as string | undefined) ?? null };
}

export interface NewCrawl {
  site: string;
  startUrl: string;
  maxPages: number;
  maxMinutes: number;
  force: boolean;
}

export const MAX_CRAWL_PAGES = 1000;

// POST /v1/admin/crawl: { site, startUrl?, maxPages?, maxMinutes?, force? }. The
// start URL defaults to the site's root and, when given, scopes the docs root.
// `force: true` skips the devtool gate.
export function validateCrawl(body: unknown, allowLocalhost: boolean): NewCrawl {
  if (!isObject(body)) throw bad('Body must be a JSON object');
  const site = normalizeSite(str(body.site, 'site', 253));
  if (site === 'scoop.md' || site.endsWith('.scoop.md')) throw bad('scoop.md itself cannot be crawled');
  const startUrl = body.startUrl === undefined ? `https://${site}/` : str(body.startUrl, 'startUrl', 1024);
  assertFetchable(startUrl, { allowLocalhost });
  if (siteOf(startUrl) !== site) throw new ApiError('site_mismatch', `startUrl is not on ${site}`);
  const int = (v: unknown, name: string, dflt: number, max: number) => {
    if (v === undefined) return dflt;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw bad(`${name} must be an integer 1–${max}`);
    return v as number;
  };
  if (body.force !== undefined && typeof body.force !== 'boolean') throw bad('force must be a boolean');
  return {
    site,
    startUrl,
    maxPages: int(body.maxPages, 'maxPages', 500, MAX_CRAWL_PAGES),
    maxMinutes: int(body.maxMinutes, 'maxMinutes', 10, 50),
    force: body.force === true,
  };
}
