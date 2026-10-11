// Builds the sections for one page: what the popup copies and shares, and what
// scripts/check-live.js verifies. fetch and HTML parsing are injected so the
// same code runs in the extension and in Node.

import { siteKey, discover } from './discover.js';
import { pickMain, htmlToMarkdown, relatedLinks } from './extract.js';

const MIN_PAGE_CHARS = 200;
const label = (s) => s.slice(0, 200);

// Drops the fragment, unless it is the route of a hash-routed site (/#/guide).
export function pageUrlOf(url) {
  const u = new URL(url);
  if (!u.hash.startsWith('#/')) u.hash = '';
  return u.href;
}

async function fetchPublicHtml(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { credentials: 'omit', redirect: 'follow' });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || 'text/html')) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Pages on this machine or a private network are never shared: their addresses
// shouldn't leave the machine, and the library couldn't fetch them anyway.
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h.includes(':')) return h === '::1' || h === '::' || /^(f[cd]|fe[89ab])/.test(h) || h.startsWith('::ffff:');
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return !h.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h);
}

// Returns { site, pageUrl, title, sections, relatedLinks, isPublic, privateHost }.
// sections are [{ kind, label, url, content, bytes }] in priority order.
// isPublic is true only when every section came from a credential-less fetch;
// tabHtml (optional) supplies the signed-in tab's HTML when the public fetch
// yields nothing, and makes the result private.
// allowPrivateHosts is for testing against a local library only.
export async function scoopPage(url, { fetchImpl = fetch, parseHtml, title = '', tabHtml, allowPrivateHosts = false } = {}) {
  const pageUrl = pageUrlOf(url);
  const site = siteKey(pageUrl);
  const found = await discover(pageUrl, fetchImpl);
  const sections = [];
  let links = [];
  const privateHost = isPrivateHost(new URL(pageUrl).hostname);
  let isPublic = !privateHost || allowPrivateHosts;

  if (found['page-md']?.content) {
    const { url: mdUrl, content } = found['page-md'];
    sections.push({ kind: 'page-md', label: label(`This page: ${title || pageUrl}`), url: mdUrl, content, bytes: null });
  } else {
    // The library re-fetches pageUrl and checks our Markdown against it, so
    // extract from exactly that anonymous response.
    let doc = null;
    let md = '';
    const html = await fetchPublicHtml(pageUrl, fetchImpl);
    if (html) {
      doc = parseHtml(html);
      md = htmlToMarkdown(pickMain(doc), pageUrl);
    }
    if (md.length <= MIN_PAGE_CHARS && tabHtml) {
      const live = await tabHtml();
      if (live) {
        doc = parseHtml(live);
        md = htmlToMarkdown(pickMain(doc), pageUrl);
        isPublic = false;
      }
    }
    if (doc) {
      title ||= doc.querySelector('h1')?.textContent.trim() || doc.title || '';
      links = relatedLinks(doc, pageUrl);
    }
    if (md) sections.push({ kind: 'page-html', label: label(`This page: ${title || pageUrl}`), url: pageUrl, content: md, bytes: null });
  }

  if (found.llms?.content) {
    sections.push({ kind: 'llms', label: 'Site documentation index (llms.txt)', url: found.llms.url, content: found.llms.content, bytes: null });
  }
  const full = found['llms-full'];
  if (full) {
    sections.push({ kind: 'llms-full', label: 'Full documentation (llms-full.txt)', url: full.url, content: full.content ?? null, bytes: full.content == null ? full.bytes : null });
  }

  return { site, pageUrl, title: title.slice(0, 300), sections, relatedLinks: links, isPublic, privateHost };
}

// The page's own section (for putting it in front of a shared skill).
export function currentPageSection(scoop) {
  return scoop?.sections.find((s) => s.kind === 'page-md' || s.kind === 'page-html') ?? null;
}
