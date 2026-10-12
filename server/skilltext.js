// Server-written text for shared skills (docs/BACKEND.md §4, §6): the same
// rules as backend/src/lib/skilltext.ts. Labels, the title, related links and
// pageUrl come only from what verification read; nothing is derived from a
// URL the server didn't fetch. htmlTitle and htmlLinks live in verify.js next
// to htmlToText.

export const MAX_TITLE = 300;
export const MAX_LABEL = 200;
export const MAX_LINK_TEXT = 120;
export const MAX_SOURCE_LINKS = 5000;
const MAX_HEADING_LINE = 1024;

export function cleanText(s, max) {
  let out = s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out.trim();
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const blank = (c) => c === ' ' || c === '\t';

// ATX heading parsed by hand (the regex form backtracks quadratically).
export function parseHeading(line) {
  if (line.length > MAX_HEADING_LINE || line.includes('\n')) return null;
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let j = i;
  while (j < line.length && line[j] === '#' && j - i < 7) j++;
  const level = j - i;
  if (level < 1 || level > 6 || !blank(line[j] ?? '')) return null;
  let a = j;
  let b = line.length;
  while (a < b && blank(line[a])) a++;
  while (b > a && blank(line[b - 1])) b--;
  let k = b;
  while (k > a && line[k - 1] === '#') k--;
  if (k > a && k < b && blank(line[k - 1])) {
    b = k;
    while (b > a && blank(line[b - 1])) b--;
  }
  return b > a ? { level, text: line.slice(a, b) } : null;
}

// Links and images keep their text; one forward scan.
export function stripLinks(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const image = s[i] === '!' && s[i + 1] === '[';
    if (s[i] !== '[' && !image) {
      out += s[i++];
      continue;
    }
    const start = i + (image ? 2 : 1);
    let j = start;
    while (j < s.length && s[j] !== ']' && s[j] !== '[') j++;
    if (s[j] === ']' && s[j + 1] === '(') {
      let k = j + 2;
      while (k < s.length && s[k] !== ')' && s[k] !== '[') k++;
      if (s[k] === ')') {
        out += s.slice(start, j);
        i = k + 1;
        continue;
      }
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

const headingText = (s) => stripLinks(s.slice(0, MAX_HEADING_LINE)).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);

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
    const h = parseHeading(line);
    if (!h) continue;
    if (h.level === 1) return cleanText(headingText(h.text), MAX_TITLE);
    first ||= headingText(h.text);
  }
  return cleanText(first, MAX_TITLE);
}

export function resolveLink(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  return { url: u.href, key: u.pathname === '/' ? u.href : u.href.replace(/\/(?=$|\?)/, '') };
}

export const linkKey = (href, base) => resolveLink(href, base)?.key ?? null;

// Links map key → { url (as the source resolved it, no fragment), text }.
export function addLink(links, href, base, text) {
  const r = resolveLink(href, base);
  if (!r || links.get(r.key)?.text) return;
  links.set(r.key, { url: r.url, text: text() });
}

// A '#/' client route (cut at '?' or a second '#', trailing slashes trimmed); '' otherwise.
export function pageHash(hash) {
  if (!hash.startsWith('#/')) return '';
  const route = hash.slice(1).split(/[?#]/)[0].replace(/\/+$/, '');
  return route ? `#${route}` : '';
}

// Origin and path of a verified page section (a page-md's .md or index.md
// dropped) plus a client route: no query string or plain fragment.
export function canonicalPageUrl(sectionUrl, kind) {
  const u = new URL(sectionUrl);
  const path = kind === 'page-md' ? u.pathname.replace(/index\.md$/, '').replace(/\.md$/, '') : u.pathname;
  return u.origin + (path || '/') + pageHash(u.hash);
}

export function pageKey(href) {
  let u;
  try { u = new URL(href); } catch { return href; }
  const route = u.hash.startsWith('#/') ? u.hash.slice(1).split(/[?#]/)[0] : '';
  const path = route ? u.pathname.replace(/[^/]*$/, '') + route.slice(1) : u.pathname;
  return u.origin + path.replace(/(\/index)?\.md$/, '').replace(/\/$/, '');
}

export function markdownLinks(md, base) {
  const links = new Map();
  let i = md.indexOf('[');
  while (i !== -1 && i < md.length && links.size < MAX_SOURCE_LINKS) {
    let j = i + 1;
    while (j < md.length && md[j] !== ']' && md[j] !== '[') j++;
    if (md[j] === ']' && md[j + 1] === '(') {
      let k = j + 2;
      while (k < md.length && md[k] !== ')' && md[k] !== '[') k++;
      if (md[k] === ')') {
        const target = md.slice(j + 2, k).trim().split(/\s/)[0].replace(/^<|>$/g, '');
        if (target) addLink(links, target, base, () => cleanText(stripLinks(md.slice(i + 1, j)).replace(/[*_`]/g, ''), MAX_LINK_TEXT));
        i = md.indexOf('[', k + 1);
        continue;
      }
    }
    i = j < md.length && md[j] === '[' ? j : md.indexOf('[', j + 1);
  }
  return links;
}

export function sectionLabel(kind, title) {
  if (kind === 'llms') return 'Site documentation index (llms.txt)';
  if (kind === 'llms-full') return 'Full documentation (llms-full.txt)';
  return title ? cleanText(`This page: ${title}`, MAX_LABEL) : 'This page';
}

const isPage = (kind) => kind === 'page-md' || kind === 'page-html';

export function withServerText(skill, verified) {
  const sections = skill.sections.map((s, i) => ({ ...s, label: sectionLabel(s.kind, verified[i]?.title ?? '') }));
  const pageTitle = skill.sections.map((s, i) => (isPage(s.kind) ? verified[i]?.title : '')).find(Boolean);
  const found = new Map();
  for (const v of verified) for (const [key, link] of v.links) if (!found.get(key)?.text) found.set(key, link);
  const seen = new Set();
  const relatedLinks = [];
  for (const l of skill.relatedLinks) {
    const key = linkKey(l.url);
    const link = key ? found.get(key) : undefined;
    if (!key || !link || seen.has(key)) continue;
    seen.add(key);
    relatedLinks.push({ url: link.url, text: link.text });
  }
  const here = pageKey(skill.pageUrl);
  const pages = skill.sections.filter((s) => isPage(s.kind));
  const page = pages.find((s) => pageKey(s.url) === here && s.kind === 'page-html') ?? pages.find((s) => pageKey(s.url) === here) ?? pages[0];
  const pageUrl = page ? canonicalPageUrl(page.url, page.kind) : canonicalPageUrl(skill.sections[0].url, skill.sections[0].kind);
  return { ...skill, pageUrl, title: cleanText(pageTitle || `${skill.site} documentation`, MAX_TITLE), sections, relatedLinks };
}
