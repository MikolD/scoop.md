// IDs and hashes. Web Crypto only, so this runs in Workers and Node alike.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ULID: 48-bit millisecond time + 80 random bits, Crockford base32. Sorts by time.
export function ulid(now = Date.now()): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let tail = '';
  for (const b of rand) tail += CROCKFORD[b % 32];
  return time + tail;
}

export const newId = (prefix: 'sk' | 'rp', now = Date.now()) => `${prefix}_${ulid(now)}`;

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Dedupe key (docs/BACKEND.md §5): SHA-256 of the canonical JSON of
// [kind, url, sha256(content)] per section, in order. Same encoding as the
// reference server, so fingerprints agree across implementations.
export async function fingerprint(sections: { kind: string; url: string; content: string | null }[]): Promise<string> {
  const parts = await Promise.all(sections.map(async (s) => [s.kind, s.url, s.content === null ? null : await sha256Hex(s.content)]));
  return sha256Hex(JSON.stringify(parts));
}

// Constant-time string comparison: compare fixed-length digests byte by byte.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}
