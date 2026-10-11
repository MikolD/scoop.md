const $ = (id) => document.getElementById(id);

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// The library URL is no longer a setting.
chrome.storage.sync.remove('libraryUrl');

chrome.storage.sync.get({ share: true }).then(({ share }) => { $('share').checked = share; });
$('share').onchange = () => chrome.storage.sync.set({ share: $('share').checked });

// Same key the popup's theme button uses; no key means follow the system.
chrome.storage.local.get('theme').then(({ theme }) => {
  document.querySelector(`input[name=theme][value=${theme || 'system'}]`).checked = true;
  applyTheme(theme);
});
for (const radio of document.querySelectorAll('input[name=theme]')) {
  radio.onchange = () => {
    const theme = radio.value === 'system' ? null : radio.value;
    applyTheme(theme);
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
