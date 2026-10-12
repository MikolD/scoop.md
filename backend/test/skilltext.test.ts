// Server-written skill text: labels, titles and related-link text come from
// verified sources and URLs, never from the client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, markdownTitle, pathTitle, sectionLabel, withServerText } from '../src/lib/skilltext.ts';
import { htmlTitle, verifyAll } from '../src/lib/verify.ts';
import type { NewSkill } from '../src/lib/types.ts';
import { fakeFetch } from './helpers.ts';

test('htmlTitle reads <title>, else the first <h1>, as decoded plain text', () => {
  assert.equal(htmlTitle('<html><head><title>Webhooks &amp; events | Docs</title></head><body><h1>Other</h1></body></html>'), 'Webhooks & events | Docs');
  assert.equal(htmlTitle('<html><head><title>  </title></head><body><h1 class="x">Check <code>signatures</code></h1></body></html>'), 'Check signatures');
  // An SVG <title> in the body isn't the page title; <titlebar> isn't <title>.
  assert.equal(htmlTitle('<html><head><titlebar>no</titlebar></head><body><svg><title>Logo</title></svg><h1>Real</h1></body></html>'), 'Real');
  assert.equal(htmlTitle('<p>no headings</p>'), '');
  assert.equal(htmlTitle('<title>unterminated'), '');
  assert.equal(htmlTitle('<head><title>' + 'A'.repeat(1000) + '</title></head>').length, 300);
});

test('htmlTitle stays linear on crafted input', () => {
  const t = performance.now();
  htmlTitle('<title'.repeat(300_000) + '<h1'.repeat(300_000));
  assert.ok(performance.now() - t < 2000);
});

test('markdownTitle takes the first H1 outside code', () => {
  assert.equal(markdownTitle('```\n# not this\n```\n\n# Check **webhook** signatures\n\n## Sub'), 'Check webhook signatures');
  assert.equal(markdownTitle('no heading'), '');
});

test('cleanText drops control and format characters and caps length', () => {
  assert.equal(cleanText('Safe‮ title​\n\n# Injected\u0007', 100), 'Safe title # Injected');
  assert.equal(cleanText('x'.repeat(500), 120).length, 120);
});

test('pathTitle humanises the last path segment', () => {
  assert.equal(pathTitle('https://docs.stripe.com/webhooks/quickstart'), 'Quickstart');
  assert.equal(pathTitle('https://developers.cloudflare.com/d1/get-started/index.md'), 'Get started');
  assert.equal(pathTitle('https://bun.com/docs/runtime/environment_variables.md'), 'Environment variables');
  assert.equal(pathTitle('https://ex.com/a/%C3%A9t%C3%A9-guide/'), 'Été guide');
  assert.equal(pathTitle('https://ex.com/'), 'ex.com');
  assert.equal(pathTitle('https://ex.com/%E0%A4%A'), '%E0%A4%A');
});

test('section labels come from the kind and the verified title', () => {
  assert.equal(sectionLabel('page-md', 'Webhooks', 'https://ex.com/w.md'), 'This page: Webhooks');
  assert.equal(sectionLabel('page-html', '', 'https://ex.com/docs/rate-limits'), 'This page: Rate limits');
  assert.equal(sectionLabel('llms', 'ignored', 'https://ex.com/llms.txt'), 'Site documentation index (llms.txt)');
  assert.equal(sectionLabel('llms-full', '', 'https://ex.com/llms-full.txt'), 'Full documentation (llms-full.txt)');
});

const skill = (): NewSkill => ({
  site: 'ex.com',
  pageUrl: 'https://ex.com/docs/webhooks',
  title: '',
  sections: [
    { kind: 'llms', label: '', url: 'https://ex.com/llms.txt', content: 'x', bytes: null },
    { kind: 'page-md', label: '', url: 'https://ex.com/docs/webhooks.md', content: '# W', bytes: null },
  ],
  relatedLinks: [{ url: 'https://ex.com/docs/auth-keys', text: '' }, { url: 'https://ex.com/', text: '' }],
});

test('withServerText fills title, labels and link text from sources and URLs', () => {
  const s = withServerText(skill(), ['', 'Receive webhooks']);
  assert.equal(s.title, 'Receive webhooks');
  assert.deepEqual(s.sections.map((x) => x.label), ['Site documentation index (llms.txt)', 'This page: Receive webhooks']);
  assert.deepEqual(s.relatedLinks, [{ url: 'https://ex.com/docs/auth-keys', text: 'Auth keys' }, { url: 'https://ex.com/', text: 'ex.com' }]);
  // No page title anywhere: the page URL's last segment.
  assert.equal(withServerText(skill(), ['', '']).title, 'Webhooks');
});

test('verifyAll returns the titles read from the fetched sources', async () => {
  const md = '# Markdown title\n\nbody text here';
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const html = `<!doctype html><html><head><title>HTML title</title></head><body><p>${words}</p></body></html>`;
  const { impl } = fakeFetch({
    'https://ex.com/a.md': () => new Response(md, { headers: { 'content-type': 'text/markdown' } }),
    'https://ex.com/a': () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    'https://ex.com/llms.txt': () => new Response('index', { headers: { 'content-type': 'text/plain' } }),
  });
  const titles = await verifyAll([
    { kind: 'page-md', label: '', url: 'https://ex.com/a.md', content: md, bytes: null },
    { kind: 'page-html', label: '', url: 'https://ex.com/a', content: words, bytes: null },
    { kind: 'llms', label: '', url: 'https://ex.com/llms.txt', content: 'index', bytes: null },
  ], 'ex.com', { fetchImpl: impl });
  assert.deepEqual(titles, ['Markdown title', 'HTML title', '']);
});

test("the extension's package renders server labels as before", async () => {
  // A variable path keeps tsc from type-checking the extension's plain JS.
  const extensionPackage = '../../extension/lib/package.js';
  const { buildPackage } = await import(extensionPackage);
  const s = withServerText(skill(), ['', 'Receive webhooks']);
  const md = buildPackage({
    site: s.site,
    pageUrl: s.pageUrl,
    sections: s.sections.map((x) => ({ ...x, content: 'body' })),
    relatedLinks: s.relatedLinks,
    now: new Date('2026-10-12T00:00:00Z'),
  });
  assert.match(md, /^- Site documentation index \(llms\.txt\): https:\/\/ex\.com\/llms\.txt$/m);
  assert.match(md, /^## This page: Receive webhooks$/m);
  assert.match(md, /^- \[Auth keys\]\(https:\/\/ex\.com\/docs\/auth-keys\)$/m);
});
