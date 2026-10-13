// HTML → Markdown for server-rendered docs (html sites), with the extension's
// own extractor (shared/extract.js) over linkedom, so a crawled page
// reads the same as a scooped one. Plain JS DOM, no Workers APIs.

import { DOMParser } from 'linkedom';
import { htmlToMarkdown, pickMain, relatedLinks } from '../../../shared/extract.js';
import type { DomNode } from '../../../shared/extract.js';

// Below this many words the extraction is treated as having failed: a client
// shell, a login wall or a page that is mostly navigation.
export const MIN_WORDS = 50;

export interface ExtractedPage {
  title: string | null;
  markdown: string;
  words: number;
  // Same-site links from the page's navigation and main content.
  links: string[];
}

const EMPTY: ExtractedPage = { title: null, markdown: '', words: 0, links: [] };

// Never throws: a body that can't be read as a page extracts to nothing (0
// words), which the callers treat as a failed page, not a failed crawl.
export function extractPage(html: string, url: string): ExtractedPage {
  try {
    return extract(html, url);
  } catch {
    return EMPTY;
  }
}

function extract(html: string, url: string): ExtractedPage {
  // linkedom builds no document element for input without an <html> tag
  // (an empty body, a comment, a fragment, plain text), and the extractor
  // then throws; wrap such input in a document.
  const source = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`;
  const doc = new DOMParser().parseFromString(source, 'text/html') as unknown as DomNode;
  const main = pickMain(doc);
  const markdown = htmlToMarkdown(main, url);
  // The extractor's h1 has permalink markers ("¶") stripped; <title> otherwise.
  const heading = /^# (.+)$/m.exec(markdown)?.[1];
  const title = (heading ?? doc.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  const origin = new URL(url).origin;
  const links = new Set(relatedLinks(doc, url, 200).map((l) => l.url));
  for (const a of main.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.getAttribute('href') ?? '', url);
      u.hash = '';
      if (u.origin === origin) links.add(u.href);
    } catch {
      // not a URL
    }
  }
  const words = (markdown.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length;
  return { title, markdown, words, links: [...links] };
}
