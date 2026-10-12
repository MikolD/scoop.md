// Server-written text for shared skills (docs/BACKEND.md §4, §6). Section
// labels, the skill title and related-link text reach agents, so none of it
// is taken from the client: labels and the title come from the verified
// sources (htmlTitle in verify.ts, markdownTitle here), link text from the
// link's own URL. The same code is in server/skilltext.js.

import { pageTitle } from '../index/chunk.ts';
import type { NewSkill, SectionKind } from './types.ts';

export const MAX_TITLE = 300;
export const MAX_LABEL = 200;
export const MAX_LINK_TEXT = 120;

// One line of plain text: control and format characters (zero-width, bidi
// overrides) dropped, whitespace collapsed, length capped.
export function cleanText(s: string, max: number): string {
  return s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

export function markdownTitle(md: string): string {
  return cleanText(pageTitle(md), MAX_TITLE);
}

// A readable name from a URL's last path segment: "/d1/get-started/index.md"
// → "Get started". The hostname when the path is empty.
export function pathTitle(url: string): string {
  const u = new URL(url);
  const segments = u.pathname.split('/').filter(Boolean);
  let seg = segments.pop();
  if (seg && /^index(\.\w+)?$/i.test(seg)) seg = segments.pop();
  if (!seg) return u.hostname;
  let s = seg;
  try { s = decodeURIComponent(seg); } catch { /* keep it encoded */ }
  s = cleanText(s.replace(/\.(md|mdx|markdown|html?|txt)$/i, '').replace(/[-_+]+/g, ' '), MAX_LINK_TEXT);
  return s ? s[0].toUpperCase() + s.slice(1) : u.hostname;
}

export function sectionLabel(kind: SectionKind, title: string, url: string): string {
  if (kind === 'llms') return 'Site documentation index (llms.txt)';
  if (kind === 'llms-full') return 'Full documentation (llms-full.txt)';
  return cleanText(`This page: ${title || pathTitle(url)}`, MAX_LABEL);
}

// Replaces every client-sent string in a validated skill. titles[i] is what
// verification read from section i's source (empty for llms kinds).
export function withServerText(skill: NewSkill, titles: string[]): NewSkill {
  const sections = skill.sections.map((s, i) => ({ ...s, label: sectionLabel(s.kind, titles[i] ?? '', s.url) }));
  const pageTitleText = skill.sections.map((s, i) => (s.kind === 'page-md' || s.kind === 'page-html' ? titles[i] : '')).find(Boolean);
  return {
    ...skill,
    title: cleanText(pageTitleText || pathTitle(skill.pageUrl), MAX_TITLE),
    sections,
    relatedLinks: skill.relatedLinks.map((l) => ({ url: l.url, text: pathTitle(l.url) })),
  };
}
