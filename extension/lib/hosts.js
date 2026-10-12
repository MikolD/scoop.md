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
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return !h.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h);
}
