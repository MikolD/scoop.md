// AWS Signature V4 query presigning for R2's S3-compatible API, over Web
// Crypto only (no SDK). The Workflow presigns one PUT per browser crawl so the
// sandbox can upload its result without holding any credentials.

export interface PresignInput {
  method: 'GET' | 'PUT';
  // https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>/<key>
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn: number; // seconds, 1..604800
  region?: string; // R2: 'auto'
  service?: string;
  now?: Date;
  // Extra headers the uploader must send exactly (signed), e.g. content-type.
  headers?: Record<string, string>;
}

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// RFC 3986 unreserved characters stay; everything else is %XX (uppercase).
export function uriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const b of enc.encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export async function presign(p: PresignInput): Promise<string> {
  if (!(p.expiresIn >= 1 && p.expiresIn <= 604_800)) throw new Error('expiresIn must be 1..604800 seconds');
  const u = new URL(p.url);
  const region = p.region ?? 'auto';
  const service = p.service ?? 's3';
  const datetime = amzDate(p.now ?? new Date());
  const date = datetime.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;

  const headers: Record<string, string> = { host: u.host };
  for (const [k, v] of Object.entries(p.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${p.accessKeyId}/${scope}`],
    ['X-Amz-Date', datetime],
    ['X-Amz-Expires', String(p.expiresIn)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // S3 signs the path as sent, each segment encoded once.
  const canonicalPath = uriEncode(decodeURIComponent(u.pathname), true);
  const canonicalRequest = [
    p.method,
    canonicalPath,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, hex(await crypto.subtle.digest('SHA-256', enc.encode(canonicalRequest)))].join('\n');
  const kDate = await hmac(enc.encode(`AWS4${p.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));
  return `${u.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export const r2Endpoint = (accountId: string, bucket: string, key: string) =>
  `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key.split('/').map((s) => uriEncode(s)).join('/')}`;
