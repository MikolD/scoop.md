// robots.txt (RFC 9309) for our crawler's user agent. Plain TS, no I/O: the
// caller fetches the file and decides what an unreachable one means.

export const CRAWLER_UA = 'scoop.md-bot (+https://scoop.md/bot)';
const PRODUCT = 'scoop.md-bot';

// The file is the site's, so bound what we parse.
const MAX_ROBOTS_BYTES = 500_000;
const MAX_PATTERN = 512;

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  allowed(pathAndQuery: string): boolean;
  // Seconds between requests the site asks of us (Crawl-delay), if any.
  crawlDelay: number | null;
  sitemaps: string[];
}

interface Group {
  agents: string[];
  rules: Rule[];
  delay: number | null;
}

export function parseRobots(text: string, product = PRODUCT): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [], delay: null }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // rules before any user-agent line apply to nobody
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value && value.length <= MAX_PATTERN) current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  // Groups naming us (by product token, case-insensitively) win over '*'; all
  // matching groups are merged (RFC 9309 §2.2.1).
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && (a === product || product.startsWith(a))));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);

  return {
    sitemaps,
    crawlDelay: delays.length ? Math.max(...delays) : null,
    allowed(pathAndQuery: string) {
      if (pathAndQuery === '/robots.txt') return true;
      // Longest matching pattern wins; on a tie, allow (RFC 9309 §2.2.2).
      let best: Rule | null = null;
      for (const r of rules) {
        if (!matches(r.pattern, pathAndQuery)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

// Everything allowed: a missing robots.txt (4xx) means no restrictions.
export const ALLOW_ALL: Robots = { allowed: () => true, crawlDelay: null, sitemaps: [] };
// Unreachable or 5xx: assume complete disallow (RFC 9309 §2.3.1.4).
export const DISALLOW_ALL: Robots = { allowed: (p) => p === '/robots.txt', crawlDelay: null, sitemaps: [] };

// '*' matches any run of characters, a trailing '$' anchors the end; anything
// else is a prefix match. A two-pointer glob match (no regex), since the
// patterns come from the site.
export function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < path.length) {
    if (pi < p.length && p[pi] !== '*' && p[pi] === path[si]) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (pi === p.length && !anchored) {
      return true; // the pattern is a prefix of the rest
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}
