// Runs the real options page (options.html + options.js) with chrome.* stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

async function openOptions({ theme, sync = {} } = {}) {
  const { document } = parseHTML(read('../extension/options.html'));
  const local = theme === undefined ? {} : { theme };
  const opened = [];
  const chrome = {
    storage: {
      sync: { get: async (d) => ({ ...d, ...sync }), set: async (o) => Object.assign(sync, o), remove: async (k) => { delete sync[k]; } },
      local: { get: async (k) => (k in local ? { [k]: local[k] } : {}), set: async (o) => Object.assign(local, o), remove: async (k) => { delete local[k]; } },
    },
    commands: { getAll: async () => [{ name: '_execute_action', shortcut: '⌥⇧C' }] },
    tabs: { create: async (o) => opened.push(o.url) },
    runtime: { getManifest: () => ({ version: '0.2.0' }) },
  };
  vm.runInNewContext(read('../extension/options.js'), { document, chrome });
  await new Promise((r) => setTimeout(r, 10));
  const checkedTheme = () => document.querySelector('input[name=theme][checked]')?.value
    ?? [...document.querySelectorAll('input[name=theme]')].find((i) => i.checked)?.value;
  return { document, local, sync, opened, checkedTheme };
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
