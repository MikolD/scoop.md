import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { pickMain, htmlToMarkdown, relatedLinks, stripTracking } from '../extension/lib/extract.js';
import { containment } from '../server/verify.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

function extract(name, url = 'https://ex.com/docs/page') {
  const html = fixture(name);
  const doc = parse(html);
  return { html, doc, md: htmlToMarkdown(pickMain(doc), url) };
}

test('pages without <main>/<article> do not leak the top bar, sidebar or footer', () => {
  const { md } = extract('nav-leak.html');
  assert.match(md, /^Installation\n\n# Get started with Widgets\n/);
  for (const leak of ['Showcase', 'Editor setup', 'Core concepts', 'Trademark Policy', 'Copyright', 'Copy\n']) {
    assert.ok(!md.includes(leak), `leaked ${JSON.stringify(leak)}`);
  }
  assert.match(md, /## Install the plugin/);
  assert.match(md, /Install `widgets` and its build plugin with \*\*npm\*\*, then add the plugin to your \*build configuration\*\./);
  assert.match(md, /```bash\nnpm install widgets @widgets\/vite\nnpm run dev\n```/);
  assert.match(md, /## Configure it/);
});

test('leading permalink markers are dropped too (VuePress: chartjs.org)', () => {
  const doc = parse('<main><h1>T</h1><h2 id="why"><a href="#why" class="header-anchor">#</a> Why Chart.js</h2><p>Body text.</p></main>');
  assert.match(htmlToMarkdown(pickMain(doc), 'https://ex.com/docs/page'), /^## Why Chart\.js$/m);
});

test('a heading that starts with # but is not a marker keeps it (#include)', () => {
  const doc = parse('<main><h1>T</h1><h2>#include directives</h2><h3>#</h3><p>Body text.</p></main>');
  const md = htmlToMarkdown(pickMain(doc), 'https://ex.com/docs/page');
  assert.match(md, /^## #include directives$/m);
});

test('related link text keeps block children apart (bbc.com "4 hrs agoChildren…")', () => {
  const doc = parse('<nav><a href="/news/a"><span>4 hrs ago</span><h3>Children rescued</h3><p>Summary</p></a><a href="/news/b">Get<b>ting</b> started</a></nav>');
  assert.deepEqual(relatedLinks(doc, 'https://ex.com/news/x').map((l) => l.text), ['4 hrs ago Children rescued Summary', 'Getting started']);
});

test('data: and javascript: links keep their text but not their target', () => {
  const doc = parse('<main><h1>T</h1><p><a href="data:text/plain,<!doctype html>%0A<html>">Download Template</a> and <a href="mailto:a@ex.com">mail</a> and <a href="/x">x</a></p></main>');
  const md = htmlToMarkdown(pickMain(doc), 'https://ex.com/docs/page');
  assert.match(md, /^Download Template and \[mail\]\(mailto:a@ex\.com\) and \[x\]\(https:\/\/ex\.com\/x\)$/m);
  assert.ok(!md.includes('data:'));
});

test('heading permalink markers are dropped', () => {
  const { md } = extract('nav-leak.html');
  assert.match(md, /^# Get started with Widgets$/m);
});

test('per-line highlighters keep one line per line and lose their gutters', () => {
  const { md } = extract('highlighters.html');
  assert.match(md, /```\nconst a = 1;\nconst b = 2;\n```/, 'Shiki');
  assert.match(md, /```\n\$\.ajax\(\{\n\}\);\n```/, 'SyntaxHighlighter table with gutter');
  assert.match(md, /```js\nlet x = 1;\nx\+\+;\n```/, 'Prism lines ending in <br>');
  assert.match(md, /```py\nprint\("hi"\)\nprint\("bye"\)\n```/, 'line numbers inside lines');
  assert.ok(!/^\s*[12]\s*$/m.test(md), 'no bare line numbers');
});

test('tables become Markdown tables with a header separator', () => {
  const { md } = extract('table.html');
  assert.match(md, /\| Name \| Type \| Description \|\n\| --- \| --- \| --- \|\n\| `timeout` \| number \| Milliseconds/);
  assert.match(md, /retry a failed request \\\| at most five\. \|/);
});

test('an article header holding the title is kept; lists nest; quotes stay quotes', () => {
  const { md } = extract('table.html');
  assert.match(md, /^# Options\n\nEvery option the client accepts\./);
  assert.match(md, /- First item\n  - Nested item\n- Second item/);
  assert.match(md, /^> Deprecated since version two\.$/m);
  assert.ok(!md.includes('Edit this page'));
});

test('relatedLinks lists same-site navigation under the docs prefix only', () => {
  const { doc } = extract('table.html');
  assert.deepEqual(relatedLinks(doc, 'https://ex.com/docs/page'), [
    { url: 'https://ex.com/docs/a', text: 'A' },
    { url: 'https://ex.com/docs/b', text: 'B' },
    { url: 'https://ex.com/docs/d', text: 'D' },
  ]);
});

// highlighters.html is left out: it is almost all gutters and line numbers,
// and each one removed breaks the shingles around it. scripts/check-live.js
// covers real pages with code.
test('prose fixtures pass the library\'s containment check against their own HTML', () => {
  for (const name of ['nav-leak.html', 'table.html']) {
    const { html, md } = extract(name);
    const { ratio, count } = containment(md, html);
    assert.ok(ratio >= (count < 20 ? 1 : 0.85), `${name}: ${ratio} of ${count} shingles`);
  }
});

test('stripTracking drops utm_*, click IDs and ref, and keeps real parameters', () => {
  assert.equal(stripTracking('https://ex.com/docs/a?utm_source=x&utm_medium=y&_gl=1&gclid=2&fbclid=3&mc_cid=4&mc_eid=5&ref_src=t&ref_url=u'), 'https://ex.com/docs/a');
  assert.equal(stripTracking('https://ex.com/docs/a?ref=main&utm_source=x'), 'https://ex.com/docs/a?ref=main', 'ref=<branch> selects content');
  assert.equal(stripTracking('https://ex.com/docs/a?tab=js&UTM_Campaign=z&page=2#install'), 'https://ex.com/docs/a?tab=js&page=2#install');
  assert.equal(stripTracking('https://ex.com/docs/a'), 'https://ex.com/docs/a');
  assert.equal(stripTracking('https://ex.com/s?q=a%20b&utm_source=x'), 'https://ex.com/s?q=a%20b', 'the rest is not re-encoded');
});

test('related links keep their query (minus tracking) and drop fragments except #/ routes', () => {
  const doc = parse(`<nav>
    <a href="/docs/api?lang=js">API (JS)</a>
    <a href="/docs/api?lang=py#intro">API (Python)</a>
    <a href="/docs/api?lang=js&utm_source=nav">API again</a>
    <a href="/docs/#/guide">Guide</a>
    <a href="/docs/page?utm_source=x">This page</a>
    <a href="mailto:a@ex.com">Mail</a>
  </nav>`);
  assert.deepEqual(relatedLinks(doc, 'https://ex.com/docs/page').map((l) => l.url), [
    'https://ex.com/docs/api?lang=js',
    'https://ex.com/docs/#/guide',
  ], 'one link per path: the first query variant wins');
});

test('docsify heading anchors are the route, not more related links', () => {
  const doc = parse(`<aside>
    <a href="#/quickstart">Quick start</a>
    <a href="#/quickstart?id=initialize">Initialize</a>
    <a href="#/quickstart?id=preview">Preview</a>
    <a href="#/configuration?id=el">el</a>
    <a href="#/configuration">Configuration</a>
    <a href="#/more-pages?id=x">This page's heading</a>
  </aside>`);
  assert.deepEqual(relatedLinks(doc, 'https://ex.com/#/more-pages').map((l) => l.url), [
    'https://ex.com/#/quickstart',
    'https://ex.com/#/configuration',
  ]);
});
