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
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assert.ok(existsSync(ext(f)), f);
});

test('only the permissions STORE.md justifies', () => {
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'alarms', 'clipboardWrite', 'scripting', 'storage']);
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
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

test('the options switch is visible when off: track to card contrast is at least 3:1', () => {
  const css = readFileSync(ext('theme.css'), 'utf8');
  const token = (block, name) => block.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const light = css.slice(0, css.indexOf('@media'));
  const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
  for (const [name, block] of [['light', light], ['dark', dark]]) {
    const r = ratio(token(block, 'switch-off'), token(block, 'card'));
    assert.ok(r >= 3, `${name}: ${r.toFixed(2)}`);
  }
  assert.match(readFileSync(ext('options.css'), 'utf8'), /\.toggle \{[^}]*background: var\(--switch-off\)/);
});

test('every usage event the backend accepts is disclosed on the privacy page and in STORE.md', () => {
  const schema = readFileSync(new URL('../backend/src/telemetry/schema.ts', import.meta.url), 'utf8');
  const names = [...schema.matchAll(/^ {2}(\w+): \['(extension|site)'/gm)].map((m) => m[1]);
  assert.ok(names.length >= 20, `found ${names.length} events`);
  const privacy = readFileSync(new URL('../site/src/pages/privacy.astro', import.meta.url), 'utf8');
  for (const n of names.filter((n) => !['page_view', 'cta_click', 'uninstall', 'uninstall_reason'].includes(n))) assert.ok(privacy.includes(n), `privacy: ${n}`);
  for (const s of ['Send usage statistics', '180 days', 'team@ddamoah.com', 'country', 'Global Privacy Control', 'scoop.md/bye']) {
    assert.ok(privacy.includes(s) || privacy.includes('DELETION_EMAIL'), s);
  }
  const store = readFileSync(ext('STORE.md'), 'utf8');
  for (const s of ['| Location | Yes', '| Web history | Yes', '| User activity | Yes', '`alarms`', 'Send usage statistics']) assert.ok(store.includes(s), s);
});

test('the reference server accepts the same event names as the backend', async () => {
  const { EVENT_NAMES } = await import('../server/app.js');
  const schema = readFileSync(new URL('../backend/src/telemetry/schema.ts', import.meta.url), 'utf8');
  for (const source of ['extension', 'site']) {
    const names = [...schema.matchAll(new RegExp(`^ {2}(\\w+): \\['${source}'`, 'gm'))].map((m) => m[1]).sort();
    assert.deepEqual([...EVENT_NAMES[source]].sort(), names, source);
  }
});

test('the store zip leaves out store artwork, docs, types, tests and source maps', () => {
  const pack = readFileSync(new URL('../scripts/pack-extension.js', import.meta.url), 'utf8');
  for (const pattern of ["'store-assets/*'", "'*.md'", "'*.d.ts'", "'*.test.js'", "'*.map'"]) assert.ok(pack.includes(pattern), pattern);
});

test('the link checks are disclosed on the privacy page and in STORE.md', () => {
  const privacy = readFileSync(new URL('../site/src/pages/privacy.astro', import.meta.url), 'utf8');
  const store = readFileSync(ext('STORE.md'), 'utf8');
  for (const doc of [privacy, store]) assert.match(doc, /links\/check/);
  assert.match(privacy, /When sharing is on, their addresses/);
});
