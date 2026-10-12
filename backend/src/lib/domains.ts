// Registrable domains (the part a single owner controls), from a curated
// subset of the Public Suffix List: country second-level suffixes, and the
// multi-tenant hosting suffixes where every subdomain belongs to someone
// else (alice.github.io and bob.github.io are different owners). Enough for
// deciding what is "the same site" (/v1/quick's docs.<domain> probe, links to
// other domains in instructions for agents); not a full PSL.

// Hosting platforms whose subdomains are separate tenants.
export const MULTI_TENANT = [
  'vercel.app', 'netlify.app', 'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'r2.dev', 'herokuapp.com',
  'gitbook.io', 'readthedocs.io', 'readthedocs-hosted.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net',
  'azurestaticapps.net', 'cloudapp.net', 'fly.dev', 'onrender.com', 'railway.app', 'up.railway.app', 'deno.dev', 'surge.sh',
  'glitch.me', 'repl.co', 'replit.app', 'replit.dev', 'amplifyapp.com', 'appspot.com', 'cloudfront.net', 'blogspot.com',
  'wordpress.com', 'notion.site', 'webflow.io', 'framer.website', 'framer.app', 'mintlify.app', 'mintlify.dev', 'hashnode.dev',
  'substack.com', 'codeberg.page', 'bitbucket.io', 'pythonanywhere.com', 'ngrok.io', 'ngrok-free.app', 'ngrok.app',
  'trycloudflare.com', 'stackblitz.io', 'codesandbox.io', 'csb.app', 'wixsite.com',
  'myshopify.com', 'carrd.co', 'neocities.org', 'sourceforge.io', 'statuspage.io', 'zendesk.com', 'freshdesk.com',
] as const;

// Country second-level suffixes (example.co.uk is registrable, co.uk is not).
const CC_SECOND = /\.(co|com|org|net|ac|gov|edu|ltd|plc|or|ne|go|gen|nic|biz|info)\.[a-z]{2}$/i;

const tail = (host: string, n: number) => host.split('.').slice(-n).join('.');

// The public suffix of a host: a multi-tenant suffix, a country second level, or the TLD.
export function publicSuffix(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  const multi = MULTI_TENANT.filter((s) => h === s || h.endsWith(`.${s}`)).sort((a, b) => b.length - a.length)[0];
  if (multi) return multi;
  if (CC_SECOND.test(h)) return tail(h, 2);
  return tail(h, 1);
}

// The registrable domain: the public suffix and one label before it
// (docs.example.com → example.com, alice.github.io → alice.github.io).
export function registrable(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  const suffix = publicSuffix(h);
  if (h === suffix) return h;
  return tail(h, suffix.split('.').length + 1);
}

// A host on a hosting platform: its siblings belong to other owners.
export const isMultiTenant = (host: string) => (MULTI_TENANT as readonly string[]).includes(publicSuffix(host));
