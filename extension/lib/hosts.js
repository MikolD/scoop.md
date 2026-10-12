// Hostnames that never leave the machine: not shared with the library, not
// sent in telemetry. Plain JS with no imports, so the backend (TypeScript) and
// the service worker can use the same rule.

// Pages on this machine or a private network are never shared: their addresses
// shouldn't leave the machine, and the library couldn't fetch them anyway.
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h.includes(':')) return h === '::1' || h === '::' || /^(f[cd]|fe[89ab])/.test(h) || h.startsWith('::ffff:');
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  // Reserved, special-use and common intranet suffixes (RFC 2606, 6761, 6762, 7686, 8375).
  return !h.includes('.') ||
    /\.(localhost|local|internal|lan|home\.arpa|home|corp|intranet|private|test|example|invalid|onion|i2p)$/.test(h);
}

// Second-level labels under which country-code TLDs register names (co.uk, com.au, …).
const CC_SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go', 'gob', 'nic', 'mil', 'ltd', 'plc']);

// The registrable domain (eTLD+1) from ICANN suffixes only: acme.atlassian.net
// → atlassian.net, docs.foo.co.uk → foo.co.uk. Hosting suffixes (github.io and
// the like) are deliberately not treated as public suffixes, so a tenant's name
// is dropped too. IP literals come back unchanged.
export function registrableDomain(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const [sld, tld] = labels.slice(-2);
  const n = tld.length === 2 && CC_SLD.has(sld) ? 3 : 2;
  return labels.slice(-n).join('.');
}
