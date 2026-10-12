// Server-written text for shared skills (docs/BACKEND.md §4, §6): the same
// rules as backend/src/lib/skilltext.ts. Section labels, the skill title and
// related-link text reach agents, so none of it is taken from the client.
// htmlTitle lives in verify.js next to htmlToText.

export const MAX_TITLE = 300;
export const MAX_LABEL = 200;
export const MAX_LINK_TEXT = 120;

export function cleanText(s, max) {
  return s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const headingText = (s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);

// The first level-1 heading outside code, else the first heading.
export function markdownTitle(md) {
  let fence = '';
  let first = '';
  for (const line of md.split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = '';
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const h = HEADING.exec(line);
    if (!h) continue;
    if (h[1].length === 1) return cleanText(headingText(h[2]), MAX_TITLE);
    first ||= headingText(h[2]);
  }
  return cleanText(first, MAX_TITLE);
}

export function pathTitle(url) {
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

export function sectionLabel(kind, title, url) {
  if (kind === 'llms') return 'Site documentation index (llms.txt)';
  if (kind === 'llms-full') return 'Full documentation (llms-full.txt)';
  return cleanText(`This page: ${title || pathTitle(url)}`, MAX_LABEL);
}

export function withServerText(skill, titles) {
  const sections = skill.sections.map((s, i) => ({ ...s, label: sectionLabel(s.kind, titles[i] ?? '', s.url) }));
  const pageTitle = skill.sections.map((s, i) => (s.kind === 'page-md' || s.kind === 'page-html' ? titles[i] : '')).find(Boolean);
  return {
    ...skill,
    title: cleanText(pageTitle || pathTitle(skill.pageUrl), MAX_TITLE),
    sections,
    relatedLinks: skill.relatedLinks.map((l) => ({ url: l.url, text: pathTitle(l.url) })),
  };
}
