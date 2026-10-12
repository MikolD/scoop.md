// The website's usage events (docs/TELEMETRY.md): page views, call-to-action
// clicks and the uninstall page. No cookies, no storage, no third-party
// scripts; the API derives the country and a daily-rotating visitor hash.
// Browsers that send Global Privacy Control or Do Not Track get no page views
// or clicks.

const API = (import.meta.env.PUBLIC_API_URL || 'https://api.scoop.md').replace(/\/+$/, '');
const ENDPOINT = `${API}/v1/events`;
const session = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Math.random()).slice(2);
let seq = 0;

type Props = Record<string, string | undefined>;

export function analyticsOff(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1';
}

export function send(events: { name: string; props: Props }[]): void {
  const body = JSON.stringify({
    source: 'site',
    sessionId: session,
    events: events.map((e) => ({
      name: e.name,
      ts: Date.now(),
      seq: ++seq,
      props: Object.fromEntries(Object.entries(e.props).filter(([, v]) => v)),
    })),
  });
  // text/plain keeps it a simple request: no CORS preflight.
  const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
  try {
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;
  } catch {}
  fetch(ENDPOINT, { method: 'POST', body: blob, keepalive: true, credentials: 'omit' }).catch(() => {});
}

function referrerHost(): string | undefined {
  try {
    const host = document.referrer ? new URL(document.referrer).hostname : '';
    return host && host !== location.hostname ? host : undefined;
  } catch {
    return undefined;
  }
}

export function pageView(): void {
  if (analyticsOff()) return;
  const q = new URLSearchParams(location.search);
  send([{
    name: 'page_view',
    props: {
      path: location.pathname,
      referrerHost: referrerHost(),
      utmSource: q.get('utm_source') ?? undefined,
      utmMedium: q.get('utm_medium') ?? undefined,
      utmCampaign: q.get('utm_campaign') ?? undefined,
    },
  }]);
}

// Links marked data-cta="<target>".
export function trackCtas(): void {
  if (analyticsOff()) return;
  for (const a of document.querySelectorAll<HTMLElement>('[data-cta]')) {
    a.addEventListener('click', () => send([{ name: 'cta_click', props: { target: a.dataset.cta, path: location.pathname } }]));
  }
}
