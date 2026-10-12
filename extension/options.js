import { createTelemetry, getInstallId, setTelemetry, telemetryEnabled } from './lib/telemetry.js';

const $ = (id) => document.getElementById(id);
let telemetry = createTelemetry();
telemetry.track('options_open');

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// Once, in Settings too: pinning shows on the icon whether each site is developer docs.
const PIN_KEY = 'pinHintSettingsSeen';
Promise.all([chrome.storage.local.get(PIN_KEY), chrome.action?.getUserSettings?.()]).then(([{ [PIN_KEY]: seen }, user]) => {
  if (seen || user?.isOnToolbar !== false) return;
  $('pin-hint').hidden = false;
  $('pin-ok').onclick = () => {
    $('pin-hint').hidden = true;
    chrome.storage.local.set({ [PIN_KEY]: true });
  };
}).catch(() => {});

// The library URL is no longer a setting.
chrome.storage.sync.remove('libraryUrl');

chrome.storage.sync.get({ share: true }).then(({ share }) => { $('share').checked = share; });
$('share').onchange = () => {
  telemetry.track('settings_change', { key: 'share', value: String($('share').checked) });
  return chrome.storage.sync.set({ share: $('share').checked });
};

// Off sends one telemetry_opt_out event, then nothing (lib/telemetry.js).
telemetryEnabled(chrome).then((on) => { $('telemetry').checked = on; });
getInstallId(chrome).then((id) => { $('install-id').textContent = id; });
$('telemetry').onchange = async () => {
  const on = $('telemetry').checked;
  if (!on) telemetry.disable();
  await setTelemetry(chrome, on);
  if (on) telemetry = createTelemetry();
};

// Same key the popup's theme button uses; no key means follow the system.
chrome.storage.local.get('theme').then(({ theme }) => {
  if (theme !== 'light' && theme !== 'dark') theme = null;
  document.querySelector(`input[name=theme][value=${theme || 'system'}]`).checked = true;
  applyTheme(theme);
});
for (const radio of document.querySelectorAll('input[name=theme]')) {
  radio.onchange = () => {
    const theme = radio.value === 'system' ? null : radio.value;
    applyTheme(theme);
    telemetry.track('settings_change', { key: 'theme', value: radio.value });
    if (theme) chrome.storage.local.set({ theme });
    else chrome.storage.local.remove('theme');
  };
}

chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
  $('shortcut').textContent = shortcut ? `${shortcut} opens scoop.md` : 'Not set';
});
$('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

$('version').textContent = `Version ${chrome.runtime.getManifest().version}`;

// Sent when the page closes; whatever doesn't go stays queued for the service worker.
globalThis.addEventListener?.('pagehide', () => telemetry.flushOnClose());
