// Jev, TypeSafe's System One model (docs.typesafe.ai/api.md): a state plus
// typed questions (noul: yes/no probability, choice: one option of a set,
// score: a level on a scale) answered in a fraction of a second. Used for the
// devtool gate, page classification and /v1/quick. Plain TS over fetch, so it
// runs anywhere (Workers, Node, E2B).

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const JEV_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 200;

export type JevQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

export interface JevResult {
  model: string; // the version that answered, e.g. jev-1.13.0
  answers: Record<string, JevAnswer>;
  tokens: number; // input + output
}

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface JevOptions {
  apiKey: string;
  fetchImpl?: FetchImpl;
  // Per attempt.
  timeoutMs?: number;
  // Further attempts after a timeout, a dropped connection, 429 or 5xx.
  retries?: number;
  model?: string;
  // Checked before every request: false (the daily token cap is spent) fails it without a call.
  allow?: () => Promise<boolean>;
}

// `status` is the HTTP status, null when no answer came back.
export class JevError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

// USD for `tokens` at `usdPerMTok` per million. Jev's price isn't published:
// tokens are always recorded, and JEV_USD_PER_MTOK (default 0) prices them.
export const jevCostUsd = (tokens: number, usdPerMTok: number) => (tokens / 1_000_000) * usdPerMTok;

export function usdPerMTok(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : 0;
}

const retryable = (status: number) => status === 429 || status >= 500;

// Checks every asked question came back with an answer of its type; a choice
// must be one of its options.
function checkAnswers(questions: Record<string, JevQuestion>, answers: unknown): Record<string, JevAnswer> {
  if (!answers || typeof answers !== 'object') throw new JevError('no answers in the response');
  const out: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = (answers as Record<string, Record<string, unknown>>)[id];
    if (!a || a.type !== q.type) throw new JevError(`no ${q.type} answer for ${id}`);
    if (q.type === 'noul' && !(typeof a.noul === 'number' && a.noul >= 0 && a.noul <= 1)) throw new JevError(`${id}: noul out of range`);
    if (q.type === 'choice' && !(typeof a.choice === 'string' && a.choice in q.criteria)) throw new JevError(`${id}: choice is not an option`);
    if (q.type === 'score' && typeof a.score !== 'number') throw new JevError(`${id}: score is not a number`);
    out[id] = a as unknown as JevAnswer;
  }
  return out;
}

// One request with every question in it (one call is far faster and cheaper
// than one per question). Throws JevError when no valid answer came back.
export async function askJev(state: unknown, questions: Record<string, JevQuestion>, o: JevOptions): Promise<JevResult> {
  const fetchImpl = o.fetchImpl ?? fetch;
  if (o.allow && !(await o.allow())) throw new JevError('daily Jev token cap reached');
  const attempts = 1 + (o.retries ?? 1);
  let last: JevError = new JevError('not attempted');
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    let res: Response;
    try {
      res = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: o.model ?? JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(o.timeoutMs ?? JEV_TIMEOUT_MS),
      });
    } catch (e) {
      last = new JevError(`jev: ${(e as Error).message}`);
      continue;
    }
    const body = (await res.json().catch(() => null)) as {
      model?: string;
      answers?: unknown;
      usage?: { input_tokens?: number; output_tokens?: number };
    } | null;
    if (!res.ok) {
      last = new JevError(`jev answered ${res.status}`, res.status);
      if (retryable(res.status)) continue;
      throw last;
    }
    if (!body) {
      last = new JevError('jev: unreadable response body', res.status);
      continue;
    }
    const tokens = (Number(body.usage?.input_tokens) || 0) + (Number(body.usage?.output_tokens) || 0);
    return { model: String(body.model ?? o.model ?? JEV_MODEL), answers: checkAnswers(questions, body.answers), tokens };
  }
  throw last;
}
