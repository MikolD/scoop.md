import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const ext = (p) => new URL(`../extension/${p}`, import.meta.url);
const manifest = JSON.parse(readFileSync(ext('manifest.json'), 'utf8'));

test('manifest is MV3 and every file it references exists', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const files = [
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assert.ok(existsSync(ext(f)), f);
});

test('only the permissions STORE.md justifies', () => {
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'clipboardWrite', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  const store = readFileSync(ext('STORE.md'), 'utf8');
  for (const p of [...manifest.permissions, '<all_urls>']) assert.ok(store.includes(`\`${p}\``), p);
});

test('pages keep styling in their stylesheets, so a restyle is CSS-only', () => {
  for (const f of readdirSync(ext('')).filter((n) => n.endsWith('.html'))) {
    const html = readFileSync(ext(f), 'utf8');
    assert.ok(!/\sstyle=|<style/i.test(html), `${f} has inline styles`);
  }
  for (const f of readdirSync(ext('')).filter((n) => n.endsWith('.js'))) {
    assert.ok(!/\.style\b/.test(readFileSync(ext(f), 'utf8')), `${f} sets styles from script`);
  }
});

test('the library URL is not a user setting', () => {
  assert.ok(!readFileSync(ext('options.html'), 'utf8').includes('libraryUrl'), 'no library URL field');
  const js = readFileSync(ext('options.js'), 'utf8');
  assert.deepEqual(js.match(/.*libraryUrl.*/g), ["chrome.storage.sync.remove('libraryUrl');"], 'options.js only deletes the old setting');
  assert.ok(!manifest.permissions.includes('management'), 'management.getSelf needs no permission');
});

test('the privacy page matches what the extension does (no library off switch)', () => {
  const privacy = readFileSync(new URL('../site/src/pages/privacy.astro', import.meta.url), 'utf8');
  for (const gone of ['library can be turned off', 'Clear the library address', 'no network calls', 'Only when the library is on']) {
    assert.ok(!privacy.includes(gone), gone);
  }
  assert.match(privacy, /api\.scoop\.md\/v1\/skills\/best/);
  assert.match(privacy, /theme stays on this device/);
});
