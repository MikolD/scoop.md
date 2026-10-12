// Page classification with Jev (src/lib/jev.ts) plus code, the default
// classifier (CLASSIFIER=jev; docs/BACKEND-DECISIONS.md, "Jev"). One Jev
// request, about 0.2-0.5 s, against 10-20 s for a generative model:
//   - slot: a Jev choice over the 14 slots;
//   - topic path: from the URL's path segments (normalised), and the page
//     title under a single segment. When the URL doesn't place the page (no
//     segment, or one that isn't a top-level topic yet), Jev chooses among
//     the site's existing top-level topics in the same request: one level of
//     the hierarchical-classification recipe (docs.typesafe.ai/cookbooks);
//   - summary: the page's first meaningful paragraph;
//   - entities: inline code identifiers, HTTP endpoints, CLI commands and
//     ENV_VARS found by pattern, each checked against the page.
// The page is untrusted: it goes to Jev only as state, and nothing it says
// becomes a slot or topic that isn't one of the given options or its own URL.

import { askJev, jevCostUsd, JevError } from '../lib/jev.ts';
import type { JevOptions, JevQuestion } from '../lib/jev.ts';
import { headingText, parseHeading, stripLinks } from './chunk.ts';
import { clean, ClassifyUnavailable, SLOTS, topicName } from './classify.ts';
import type { Classified, Entity, EntityKind, PageInput, Slot } from './classify.ts';

export interface JevClassifyOptions extends JevOptions {
  usdPerMTok: number;
}

const SLOT_CRITERIA: Record<Slot, string> = {
  install: 'Installing or setting up the tool',
  quickstart: 'A first end-to-end walkthrough',
  auth: 'API keys, OAuth and authentication',
  concepts: 'Explanations of how things work',
  'api-reference': 'HTTP/REST endpoint reference',
  'sdk-reference': 'Library, SDK, CLI or configuration reference',
  guide: 'Task-oriented how-tos',
  examples: 'Sample code and recipes',
  errors: 'Error codes and troubleshooting',
  limits: 'Quotas, rate limits and pricing limits',
  'webhooks-events': 'Webhooks and event types',
  'versioning-changelog': 'Versions, release notes and changelogs',
  migration: 'Upgrading, or moving from another product',
  other: 'Anything else (landing pages, indexes, legal, community)',
};
const NONE = 'none of these';
// A topic Jev picks is used from this probability on.
export const MIN_TOPIC_PROBABILITY = 0.5;
const STATE_CHARS = 4000;
const MAX_HEADINGS = 20;
const SUMMARY_MAX = 400;
const MAX_ENTITIES = 15;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Path segments that say nothing about the topic: docs prefixes, versions,
// locales (first segment only) and index pages.
const GENERIC = new Set(['docs', 'doc', 'documentation', 'latest', 'stable', 'current', 'next', 'main', 'master', 'index', 'readme', 'home']);
const LOCALES = new Set(['en', 'en-us', 'en-gb', 'ja', 'ja-jp', 'zh', 'zh-cn', 'zh-tw', 'zh-hans', 'zh-hant', 'ko', 'de', 'fr', 'es', 'pt', 'pt-br', 'ru', 'it']);
const VERSION = /^v?\d+(\.\d+)*(\.x)?$/i;

// The URL's topic segments: path then hash route (#/deploy), normalised to topic names.
export function urlTopicSegments(pageUrl: string): string[] {
  const u = new URL(pageUrl);
  const raw = u.pathname.split('/').filter(Boolean);
  if (u.hash.startsWith('#/')) raw.push(...u.hash.slice(2).split('/').filter(Boolean));
  const out: string[] = [];
  raw.forEach((seg, i) => {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* keep as is */ }
    s = s.replace(/\.(html?|mdx?|txt|php|aspx?)$/i, '').toLowerCase();
    if (!s || GENERIC.has(s) || VERSION.test(s) || (i === 0 && LOCALES.has(s))) return;
    const name = topicName(s);
    if (name && out[out.length - 1] !== name) out.push(name);
  });
  return out;
}

// The topic path: four URL levels at most; under a single (or no) segment,
// the page title (or 'overview') below it. `top` is a top-level topic Jev chose.
export function topicPathFor(segs: string[], title: string, top: string | null): string[] {
  if (segs.length >= 2 && !top) return segs.slice(0, 4);
  const first = top ?? segs[0] ?? (topicName(title) || 'overview');
  let leaf = top ? (segs[0] ?? topicName(title)) : segs[0] ? topicName(title) : 'overview';
  if (!leaf || leaf === first) leaf = 'overview';
  return [first, leaf];
}

// Whether Jev should choose the top-level topic: the URL has no segment, or
// one that isn't a top-level topic yet, and the site has topics to choose from.
export const urlAmbiguous = (segs: string[], topics: string[]) =>
  topics.length >= 2 && (segs.length === 0 || (segs.length === 1 && !topics.includes(segs[0])));

// Paragraphs outside code, front matter, headings, lists, tables and HTML.
function paragraphs(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = '';
  const lines = md.slice(0, 50_000).split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = lines.findIndex((l, j) => j > 0 && l.trim() === '---') + 1;
  }
  const flush = () => {
    if (cur.length) out.push(cur.join(' '));
    cur = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      continue;
    }
    if (f) { flush(); fence = f[1]; continue; }
    const t = line.trim();
    if (!t || parseHeading(line) || /^([|<!:+*-]|\d+[.)]\s|import |export |---|===)/.test(t)) { flush(); continue; }
    cur.push(t);
  }
  flush();
  return out;
}

const plain = (s: string) => stripLinks(s).replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

// The first paragraph of at least a sentence's length, cut at a sentence end
// within SUMMARY_MAX; a blockquote (an llms.txt summary) only when there is
// no other. Empty when the page has neither.
export function firstParagraph(md: string): string {
  const paras = paragraphs(md).map(plain);
  const quote = paras.find((p) => p.startsWith('>'));
  const pick = paras.find((p) => !p.startsWith('>') && p.length >= 60 && p.split(' ').length >= 8 && /\p{L}/u.test(p))
    ?? (quote ? quote.replace(/^>\s*/, '') : '');
  const text = clean(pick, 2000);
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  const end = cut.lastIndexOf('. ');
  return end > 80 ? cut.slice(0, end + 1) : cut.slice(0, SUMMARY_MAX - 1).trimEnd() + '…';
}

const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[^\s`]{0,200}$/;
const ENV_VAR = /^\$?[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const ERROR_CODE = /^(ERR_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_ERROR)$/;
const CALL = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\(\)$/;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
// A dotted name that is a file or host, not an identifier.
const FILE_OR_HOST = /\.(json|jsonc|ts|tsx|js|jsx|mjs|cjs|toml|ya?ml|md|mdx|txt|lock|html?|css|py|rs|go|rb|sh|env|com|org|net|dev|io|ai|app|sh)$/i;
const CLI = /^(?:sudo )?((?:npx|npm|pnpm|yarn|bun|bunx|uv|uvx|pip|pip3|pipx|poetry|cargo|go|deno|brew|docker|kubectl|helm|git|gh|wrangler|vercel|terraform|python3?|node|ruby|gem|composer|dotnet|mvn|gradle|make) (?!-)[\w@:.-]{1,40})/;
const SKIP_COMMANDS = /^(cd|ls|echo|export|cat|mkdir|cp|mv|rm|source|set|touch|chmod)\b/;
const SHELL_FENCE = /^(bash|sh|shell|zsh|console|terminal|shell-session|sh-session|powershell|ps1|cmd)$/i;

// What an inline code span names, if it is an identifier worth searching for.
function classifySpan(raw: string): Entity | null {
  const s = raw.trim();
  if (s.length < 2 || s.length > 120) return null;
  if (METHOD.test(s)) return { kind: 'endpoint', name: s };
  if (ERROR_CODE.test(s)) return { kind: 'error-code', name: s };
  if (ENV_VAR.test(s)) return { kind: 'env-var', name: s.replace(/^\$/, '') };
  const cli = CLI.exec(s);
  if (cli) return { kind: 'cli-command', name: cli[1].replace(/^sudo /, '') };
  if (CALL.test(s)) return { kind: 'sdk-method', name: s.slice(0, -2) };
  if (DOTTED.test(s) && !FILE_OR_HOST.test(s)) {
    // A camelCase last part (stripe.webhooks.constructEvent) reads as a method; otherwise a key (compilerOptions.strict).
    return { kind: /[a-z][A-Z]/.test(s.slice(s.lastIndexOf('.'))) ? 'sdk-method' : 'config-key', name: s };
  }
  return null;
}

// Entities by pattern: inline code spans outside fences, request lines and
// commands inside them. Every name is checked to appear in the page as written.
export function codeEntities(md: string): Entity[] {
  const text = md.slice(0, 200_000);
  const found: Entity[] = [];
  const seen = new Set<string>();
  const add = (e: Entity | null) => {
    if (!e || found.length >= MAX_ENTITIES) return;
    const name = clean(e.name, 200);
    if (!name || seen.has(name) || !text.includes(name)) return;
    seen.add(name);
    found.push({ kind: e.kind as EntityKind, name });
  };
  let fence = '';
  let lang = '';
  for (const line of text.split('\n')) {
    if (found.length >= MAX_ENTITIES) break;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { fence = ''; continue; }
      const t = line.trim().replace(/^\$ /, '');
      const m = /^(GET|POST|PUT|PATCH|DELETE) (\/[^\s?]{1,200})/.exec(t);
      if (m) add({ kind: 'endpoint', name: `${m[1]} ${m[2]}` });
      else if (SHELL_FENCE.test(lang) && !SKIP_COMMANDS.test(t)) {
        const c = CLI.exec(t);
        if (c) add({ kind: 'cli-command', name: c[1].replace(/^sudo /, '') });
      }
      continue;
    }
    if (f) {
      fence = f[1];
      lang = line.trim().slice(fence.length).trim().split(/\s/)[0] ?? '';
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]{2,120})`/g)) add(classifySpan(m[1]));
  }
  return found;
}

// Second-level headings, for Jev's state.
function headings(md: string): string[] {
  const out: string[] = [];
  let fence = '';
  for (const line of md.slice(0, 100_000).split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const h = parseHeading(line);
    if (h && h.level >= 2 && h.level <= 3) out.push(headingText(h.text));
    if (out.length === MAX_HEADINGS) break;
  }
  return out;
}

export async function classifyWithJev(page: PageInput, o: JevClassifyOptions): Promise<Classified> {
  const segs = urlTopicSegments(page.url);
  const topics = (page.topics ?? []).filter((t) => t && t !== NONE);
  const ask = urlAmbiguous(segs, topics);
  const questions: Record<string, JevQuestion> = {
    slot: { type: 'choice', instructions: 'Which kind of developer documentation page is `state`?', criteria: SLOT_CRITERIA },
  };
  if (ask) {
    questions.topic = {
      type: 'choice',
      instructions: 'Which top-level section of this documentation site does the page in `state` belong to?',
      criteria: { ...Object.fromEntries(topics.map((t) => [t, null])), [NONE]: 'The page belongs to none of these sections' },
    };
  }
  const state = { url: page.url, title: page.title, headings: headings(page.markdown), text: page.markdown.slice(0, STATE_CHARS) };
  let r;
  try {
    r = await askJev(state, questions, o);
  } catch (e) {
    // Transient for the indexer: the queue retries, and late in the retries the page is indexed unclassified.
    throw new ClassifyUnavailable(`classifier unavailable (${e instanceof JevError ? e.message : String(e)})`, 0);
  }
  const slotAnswer = r.answers.slot;
  const slot = slotAnswer.type === 'choice' && SLOTS.includes(slotAnswer.choice as Slot) ? (slotAnswer.choice as Slot) : 'other';
  let top: string | null = null;
  const t = r.answers.topic;
  if (t?.type === 'choice' && t.choice !== NONE && (t.probabilities[t.choice] ?? 0) >= MIN_TOPIC_PROBABILITY) top = t.choice;
  return {
    classification: {
      slot,
      topic_path: topicPathFor(segs, page.title, top),
      summary: firstParagraph(page.markdown) || clean(page.title, SUMMARY_MAX),
      tasks: [],
      entities: codeEntities(page.markdown),
    },
    model: `jev:${r.model}`,
    costUsd: jevCostUsd(r.tokens, o.usdPerMTok),
    jevTokens: r.tokens,
  };
}
