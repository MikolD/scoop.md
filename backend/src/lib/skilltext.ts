// Server-written text for shared skills (docs/BACKEND.md §4, §6). Section
// labels, the skill title, related links and pageUrl reach agents, so none of
// them is taken from the client unless a verified source backs it: titles come
// from what verification read (htmlTitle and htmlLinks in verify.ts,
// markdownTitle and markdownLinks here), related links must appear as links in
// a verified source and take that source's anchor text. Nothing is derived
// from a URL the server didn't fetch. The same code is in server/skilltext.js.

import { pageTitle, stripLinks } from '../index/chunk.ts';
import type { NewSkill, SectionKind } from './types.ts';

export const MAX_TITLE = 300;
export const MAX_LABEL = 200;
export const MAX_LINK_TEXT = 120;
// Links collected per source; a docs page rarely has more than a few hundred.
export const MAX_SOURCE_LINKS = 5000;

// What verification read from one section's source: its title ('' for llms
// kinds or none) and its links, keyed by linkKey, with their anchor text.
export interface Verified {
  title: string;
  links: Map<string, string>;
}

// One line of plain text: control and format characters (zero-width, bidi
// overrides) dropped, whitespace collapsed, length capped without splitting a
// surrogate pair.
export function cleanText(s: string, max: number): string {
  let out = s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out.trim();
}

export function markdownTitle(md: string): string {
  return cleanText(pageTitle(md), MAX_TITLE);
}

// A link's identity for matching: absolute, fragment dropped, trailing slash
// dropped (except the root). Null for anything that isn't http(s).
export function linkKey(href: string, base?: string): string | null {
  let u: URL;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  return u.pathname === '/' ? u.href : u.href.replace(/\/(?=$|\?)/, '');
}

// The page a URL stands for, as the extension's package.js keys it: a '#/'
// client route resolved, a trailing .md, /index.md or slash dropped.
export function pageKey(href: string): string {
  let u: URL;
  try { u = new URL(href); } catch { return href; }
  const route = u.hash.startsWith('#/') ? u.hash.slice(1).split(/[?#]/)[0] : '';
  const path = route ? u.pathname.replace(/[^/]*$/, '') + route.slice(1) : u.pathname;
  return u.origin + path.replace(/(\/index)?\.md$/, '').replace(/\/$/, '');
}

// Markdown links [text](url) in a verified file, resolved against its URL.
// One forward scan: a search for ']' or ')' stops at the next '[', so no
// character is read more than twice.
export function markdownLinks(md: string, base: string): Map<string, string> {
  const links = new Map<string, string>();
  let i = md.indexOf('[');
  while (i !== -1 && i < md.length && links.size < MAX_SOURCE_LINKS) {
    let j = i + 1;
    while (j < md.length && md[j] !== ']' && md[j] !== '[') j++;
    if (md[j] === ']' && md[j + 1] === '(') {
      let k = j + 2;
      while (k < md.length && md[k] !== ')' && md[k] !== '[') k++;
      if (md[k] === ')') {
        // [text](url "title"): the URL is the first word, <> allowed.
        const target = md.slice(j + 2, k).trim().split(/\s/)[0].replace(/^<|>$/g, '');
        const key = target && linkKey(target, base);
        if (key && !links.get(key)) links.set(key, cleanText(stripLinks(md.slice(i + 1, j)).replace(/[*_`]/g, ''), MAX_LINK_TEXT));
        i = md.indexOf('[', k + 1);
        continue;
      }
    }
    i = j < md.length && md[j] === '[' ? j : md.indexOf('[', j + 1);
  }
  return links;
}

export function sectionLabel(kind: SectionKind, title: string): string {
  if (kind === 'llms') return 'Site documentation index (llms.txt)';
  if (kind === 'llms-full') return 'Full documentation (llms-full.txt)';
  return title ? cleanText(`This page: ${title}`, MAX_LABEL) : 'This page';
}

const isPage = (kind: SectionKind) => kind === 'page-md' || kind === 'page-html';

// Replaces every client-sent string in a validated skill with what the
// verified sources say. verified[i] is what verification read from section i.
export function withServerText(skill: NewSkill, verified: Verified[]): NewSkill {
  const sections = skill.sections.map((s, i) => ({ ...s, label: sectionLabel(s.kind, verified[i]?.title ?? '') }));
  const pageTitleText = skill.sections.map((s, i) => (isPage(s.kind) ? verified[i]?.title : '')).find(Boolean);

  // Related links survive only when a verified source links to them; the text is the source's.
  const found = new Map<string, string>();
  for (const v of verified) for (const [key, text] of v.links) if (!found.get(key)) found.set(key, text);
  const seen = new Set<string>();
  const relatedLinks = [];
  for (const l of skill.relatedLinks) {
    const key = linkKey(l.url);
    if (!key || !found.has(key) || seen.has(key)) continue;
    seen.add(key);
    relatedLinks.push({ url: l.url, text: found.get(key) ?? '' });
  }

  // pageUrl must be a page the skill verified; otherwise its first page section (or first section).
  const here = pageKey(skill.pageUrl);
  const pages = skill.sections.filter((s) => isPage(s.kind));
  const pageUrl = pages.some((s) => pageKey(s.url) === here) ? skill.pageUrl : (pages[0] ?? skill.sections[0]).url;

  return {
    ...skill,
    pageUrl,
    title: cleanText(pageTitleText || `${skill.site} documentation`, MAX_TITLE),
    sections,
    relatedLinks,
  };
}
