// Runs the real options page (options.html + options.js) with chrome.* stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

async function openOptions({ theme, sync = {} } = {}) {
  const { document } = parseHTML(read('../extension/options.html'));
  const local = theme === undefined ? {} : { theme };
  const opened = [];
  const uninstallUrls = [];
  const posts = [];
  globalThis.document = document;
  globalThis.chrome = {
    storage: {
      sync: { get: async (d) => ({ ...d, ...sync }), set: async (o) => Object.assign(sync, o), remove: async (k) => { delete sync[k]; } },
      local: {
        get: async (k) => (k in local ? { [k]: local[k] } : {}),
        set: async (o) => Object.assign(local, o),
        remove: async (k) => { for (const x of [k].flat()) delete local[x]; },
      },
    },
    commands: { getAll: async () => [{ name: '_execute_action', shortcut: '⌥⇧C' }] },
    tabs: { create: async (o) => opened.push(o.url) },
    runtime: { getManifest: () => ({ version: '0.3.0' }), setUninstallURL: async (u) => { uninstallUrls.push(u); } },
    management: { getSelf: async () => ({ installType: 'normal' }) },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posts.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(null, { status: 202 }); };
  try {
    await import(`../extension/options.js?${Math.random()}`);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = realFetch;
  }
  const checkedTheme = () => document.querySelector('input[name=theme][checked]')?.value
    ?? [...document.querySelectorAll('input[name=theme]')].find((i) => i.checked)?.value;
  return { document, local, sync, opened, checkedTheme, uninstallUrls, posts };
}

test('an unknown stored theme falls back to System', async () => {
  const { document, checkedTheme } = await openOptions({ theme: 'sepia' });
  assert.equal(checkedTheme(), 'system');
  assert.equal(document.documentElement.dataset.theme, undefined);
});

test('options: theme, sharing, shortcut and the old library URL', async () => {
  const { document, checkedTheme, sync, opened } = await openOptions({ theme: 'dark', sync: { libraryUrl: 'http://x/v1', share: false } });
  assert.equal(checkedTheme(), 'dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.getElementById('share').checked, false);
  assert.equal(sync.libraryUrl, undefined, 'old setting removed');
  assert.equal(document.getElementById('shortcut').textContent, '⌥⇧C opens scoop.md');
  document.getElementById('shortcuts').onclick();
  assert.deepEqual(opened, ['chrome://extensions/shortcuts']);
});

test('options: usage statistics default on; switching off sends one opt-out event and drops the queue', async () => {
  const { document, local, sync, uninstallUrls, posts } = await openOptions({ sync: { share: true } });
  const toggle = document.getElementById('telemetry');
  assert.equal(toggle.checked, true, 'on by default');
  assert.match(document.body.textContent, /Send usage statistics/);
  assert.ok(local.telemetryQueue.some((e) => e.name === 'options_open'), 'options_open queued');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posts.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(null, { status: 202 }); };
  try {
    toggle.checked = false;
    await toggle.onchange();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sync.telemetry, false);
  assert.equal(local.telemetryQueue, undefined, 'queue dropped');
  assert.equal(posts.length, 1, 'exactly one request');
  assert.equal(posts[0].url, 'https://api.scoop.md/v1/events');
  assert.deepEqual(posts[0].body.events.map((e) => e.name), ['telemetry_opt_out']);
  assert.equal(posts[0].body.installId, local.installId);
  assert.equal(uninstallUrls.at(-1), 'https://scoop.md/bye', 'the uninstall page no longer gets the install ID');

  // Off: nothing else is queued or sent.
  document.querySelector('input[name=theme][value=dark]').onchange();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(local.telemetryQueue, undefined);
  assert.equal(posts.length, 1);
});
