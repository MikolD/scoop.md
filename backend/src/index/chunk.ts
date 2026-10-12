// Heading-aware Markdown chunking. A chunk is ~300-800 tokens of one section
// (small neighbouring sections are packed together), carries the heading trail
// it sits under, and never splits a fenced code block. Tokens are estimated at
// four characters each, which is close for English prose and code.

export const CHARS_PER_TOKEN = 4;
export const MIN_TOKENS = 300;
export const MAX_TOKENS = 800;
export const MAX_CHUNKS = 400;

export interface Chunk {
  ord: number;
  headingPath: string[];
  text: string;
}

interface Block {
  text: string;
  fence: boolean;
}

interface Section {
  trail: string[];
  blocks: Block[];
}

// Fences are recognised at any indent: docs often nest them in list items.
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

// Heading text without inline Markdown: links keep their text, emphasis and code markers go.
export function headingText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// The page title: the first level-1 heading outside code, else the first heading.
export function pageTitle(md: string): string {
  let fence = '';
  let first = '';
  for (const line of md.split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = '';
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const h = HEADING.exec(line);
    if (!h) continue;
    if (h[1].length === 1) return headingText(h[2]);
    first ||= headingText(h[2]);
  }
  return first;
}

// Splits Markdown into sections (one per heading) of paragraph and fence blocks.
function sections(md: string): Section[] {
  const out: Section[] = [{ trail: [], blocks: [] }];
  const levels: string[] = [];
  let para: string[] = [];
  let fence: { marker: string; lines: string[] } | null = null;
  const cur = () => out[out.length - 1];
  const flush = () => {
    const text = para.join('\n').trim();
    if (text) cur().blocks.push({ text, fence: false });
    para = [];
  };

  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      fence.lines.push(line);
      const f = FENCE.exec(line);
      if (f && f[1][0] === fence.marker[0] && f[1].length >= fence.marker.length && !line.trim().slice(f[1].length).trim()) {
        cur().blocks.push({ text: fence.lines.join('\n'), fence: true });
        fence = null;
      }
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      flush();
      fence = { marker: f[1], lines: [line] };
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      levels.length = level - 1;
      levels[level - 1] = headingText(h[2]);
      out.push({ trail: levels.filter(Boolean), blocks: [{ text: line.trim(), fence: false }] });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  // An unclosed fence runs to the end of the document, as in CommonMark.
  if (fence) cur().blocks.push({ text: fence.lines.join('\n'), fence: true });
  flush();
  return out.filter((s) => s.blocks.length);
}

// A prose block over the maximum is cut at line, then sentence, then word boundaries.
function splitProse(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! ')) + 1;
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function chunkMarkdown(md: string, { minTokens = MIN_TOKENS, maxTokens = MAX_TOKENS } = {}): Chunk[] {
  const max = maxTokens * CHARS_PER_TOKEN;
  const min = minTokens * CHARS_PER_TOKEN;
  const chunks: { trail: string[]; parts: string[]; size: number }[] = [];
  let open: { trail: string[]; parts: string[]; size: number } | null = null;

  for (const s of sections(md)) {
    // A new section continues the open chunk only while that chunk is still small.
    if (open && open.size >= min) open = null;
    // A chunk holding only headings so far ("## Webhooks" right before "### Verify") takes the deeper trail.
    if (open && open.parts.every((p) => HEADING.test(p))) open.trail = s.trail;
    for (const b of s.blocks) {
      const pieces = b.fence ? [b.text] : splitProse(b.text, max);
      for (const p of pieces) {
        const add = p.length + (open?.parts.length ? 2 : 0);
        if (open && open.size + add > max) open = null;
        if (!open) {
          open = { trail: s.trail, parts: [], size: 0 };
          chunks.push(open);
        }
        open.size += p.length + (open.parts.length ? 2 : 0);
        open.parts.push(p);
      }
    }
  }

  // A small last chunk joins the one before it when that stays under the maximum.
  const last = chunks[chunks.length - 1];
  const prev = chunks[chunks.length - 2];
  if (last && prev && last.size < min && prev.size + last.size + 2 <= max) {
    prev.parts.push(...last.parts);
    prev.size += last.size + 2;
    chunks.pop();
  }

  return chunks.slice(0, MAX_CHUNKS).map((c, ord) => ({ ord, headingPath: c.trail, text: c.parts.join('\n\n') }));
}
