// Request validation and limits (docs/BACKEND.md §4, §8). Cheap checks only;
// nothing here fetches.

import { ApiError, bad } from './errors.ts';
import { assertFetchable, normalizeSite, siteOf } from './ssrf.ts';
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

export function validateSkill(body: unknown, allowLocalhost: boolean): NewSkill {
  if (!isObject(body)) throw bad('Body must be a JSON object');
  const site = normalizeSite(str(body.site, 'site', 253));
  const pageUrl = str(body.pageUrl, 'pageUrl', 2048);
  assertFetchable(pageUrl, { allowLocalhost });
  if (siteOf(pageUrl) !== site) throw new ApiError('site_mismatch', `pageUrl is not on ${site}`);
  const title = body.title === undefined || body.title === null ? '' : String(body.title).slice(0, 300);

  if (!Array.isArray(body.sections) || body.sections.length < 1 || body.sections.length > MAX_SECTIONS) {
    throw bad(`sections must have 1–${MAX_SECTIONS} items`);
  }
  const sections = body.sections.map((s: unknown, i): Section => {
    if (!isObject(s) || !KINDS.has(s.kind as SectionKind)) throw bad(`sections[${i}].kind is invalid`);
    const kind = s.kind as SectionKind;
    const url = str(s.url, `sections[${i}].url`, 2048);
    assertFetchable(url, { allowLocalhost });
    if (siteOf(url) !== site) throw new ApiError('site_mismatch', `Section ${i + 1} (${url}) is not on ${site}`);
    const content = s.content ?? null;
    if (content !== null && typeof content !== 'string') throw bad(`sections[${i}].content must be a string or null`);
    if (content !== null && content.length > MAX_SECTION) throw new ApiError('too_large', `sections[${i}].content is over ${MAX_SECTION} characters`, 413);
    if (content === null) {
      if (kind !== 'llms-full') throw bad(`sections[${i}]: only llms-full sections may omit content`);
      if (!(Number.isInteger(s.bytes) && (s.bytes as number) > 0)) throw bad(`sections[${i}].bytes is required when content is null`);
    }
    return { kind, label: str(s.label, `sections[${i}].label`, 200), url, content, bytes: content === null ? (s.bytes as number) : null };
  });

  const links = body.relatedLinks ?? [];
  if (!Array.isArray(links) || links.length > MAX_LINKS) throw bad(`relatedLinks must have at most ${MAX_LINKS} items`);
  const relatedLinks = links.map((l: unknown, i): RelatedLink => {
    const url = str(isObject(l) ? l.url : undefined, `relatedLinks[${i}].url`, 2048);
    let u: URL;
    try { u = new URL(url); } catch { throw bad(`relatedLinks[${i}].url is not a URL`); }
    if (!/^https?:$/.test(u.protocol)) throw bad(`relatedLinks[${i}].url must be http(s)`);
    if (siteOf(url) !== site) throw new ApiError('site_mismatch', `relatedLinks[${i}] is not on ${site}`);
    return { url, text: String((l as Json).text ?? '').slice(0, 120) };
  });

  return { site, pageUrl, title, sections, relatedLinks };
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
