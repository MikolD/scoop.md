// Ranking, dedupe, vote replacement, takedown and rate limiting against the
// real migrations and SQL (node:sqlite standing in for D1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/db/store.ts';
import { checkHourly } from '../src/db/ratelimit.ts';
import { best } from '../src/lib/ranking.ts';
import { fingerprint } from '../src/lib/ids.ts';
import type { NewSkill } from '../src/lib/types.ts';
import { fakeD1, fakeR2 } from './helpers.ts';

function setup() {
  const { d1, raw } = fakeD1();
  const { r2, objects } = fakeR2();
  return { store: new Store(d1, r2), d1, raw, objects };
}

const skill = (content: string, site = 'ex.com'): NewSkill => ({
  site,
  pageUrl: `https://${site}/a`,
  title: 'A',
  sections: [{ kind: 'llms', label: 'L', url: `https://${site}/llms.txt`, content, bytes: null }],
  relatedLinks: [{ url: `https://${site}/b`, text: 'B' }],
});
const at = (iso: string) => new Date(iso);

test('fingerprint depends on kind, url and content, and matches the reference encoding', async () => {
  const a = [{ kind: 'llms', url: 'https://ex.com/llms.txt', content: 'x' }];
  assert.equal(await fingerprint(a), await fingerprint(structuredClone(a)));
  assert.notEqual(await fingerprint(a), await fingerprint([{ ...a[0], content: 'y' }]));
  assert.notEqual(await fingerprint(a), await fingerprint([{ ...a[0], content: null }]));
  assert.notEqual(await fingerprint(a), await fingerprint([{ ...a[0], kind: 'page-md' }]));
  const referenceStore = '../../server/store.js';
  const { fingerprint: reference } = await import(referenceStore);
  assert.equal(await fingerprint(a), reference(a));
});

test('add stores metadata in D1 and content in R2; summaries come from D1 alone', async () => {
  const { store, objects } = setup();
  const { id, duplicate } = await store.add(skill('hello'), 'install-a');
  assert.match(id, /^sk_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(duplicate, false);
  assert.ok(objects.has(`skills/${id}.json`));
  const row = (await store.getRow(id))!;
  const full = await store.load(row);
  assert.equal(full.sections[0].content, 'hello');
  assert.deepEqual(full.relatedLinks, [{ url: 'https://ex.com/b', text: 'B' }]);
  assert.equal(full.worked, 0);
  assert.equal(full.status, 'verified');
  const [summary] = (await store.recent('ex.com')).map((r) => ({ sources: JSON.parse(r.sources_json), size: r.size_bytes }));
  assert.deepEqual(summary, { sources: [{ kind: 'llms', label: 'L', url: 'https://ex.com/llms.txt' }], size: 5 });
});

test('dedupe: same site and sections return the existing skill; removal frees the fingerprint', async () => {
  const { store, objects } = setup();
  const first = await store.add(skill('same'), 'install-a');
  const again = await store.add(skill('same'), 'install-b');
  assert.deepEqual(again, { id: first.id, duplicate: true });
  assert.equal(objects.size, 1, 'no orphaned R2 object');
  assert.equal((await store.add(skill('different'), 'install-a')).duplicate, false);
  assert.equal((await store.add(skill('same', 'other.com'), 'install-a')).duplicate, false, 'fingerprints are per site');

  await store.remove(first.id);
  const reshared = await store.add(skill('same'), 'install-a');
  assert.equal(reshared.duplicate, false);
  assert.notEqual(reshared.id, first.id);
});

test('votes: one per install, a second vote replaces the first, counters stay consistent', async () => {
  const { store, raw } = setup();
  const { id } = await store.add(skill('v'), 'install-a');
  assert.deepEqual(await store.vote(id, 'a', true, at('2026-10-01T00:00:00Z')), { worked: 1, failed: 0 });
  assert.deepEqual(await store.vote(id, 'b', true, at('2026-10-02T00:00:00Z')), { worked: 2, failed: 0 });
  assert.equal((await store.getRow(id))!.last_worked_at, '2026-10-02T00:00:00.000Z');

  // b changes their mind: lastWorkedAt falls back to a's standing vote.
  assert.deepEqual(await store.vote(id, 'b', false, at('2026-10-03T00:00:00Z')), { worked: 1, failed: 1 });
  assert.equal((await store.getRow(id))!.last_worked_at, '2026-10-01T00:00:00.000Z');
  assert.equal(await store.bestRow('ex.com'), null, 'worked must exceed failed');

  assert.deepEqual(await store.vote(id, 'a', false, at('2026-10-04T00:00:00Z')), { worked: 0, failed: 2 });
  assert.equal((await store.getRow(id))!.last_worked_at, null);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM votes WHERE skill_id = ?').get(id) as { n: number }).n, 2);
});

test('ranking: SQL and the pure function agree on "the most recent skill that worked"', async () => {
  const { store } = setup();
  const make = async (name: string, site = 'ex.com', createdAt = '2026-01-01T00:00:00Z') =>
    (await store.add(skill(name, site), 'install', at(createdAt))).id;
  const ids = {
    old: await make('old'),
    recent: await make('recent'),
    unconfirmed: await make('unconfirmed'),
    tied: await make('tied'),
    removed: await make('removed'),
    other: await make('other', 'other.com'),
    tieA: await make('tieA', 'tie.com', '2026-01-01T00:00:00Z'),
    tieB: await make('tieB', 'tie.com', '2026-01-02T00:00:00Z'),
  };
  const vote = (id: string, worked: boolean, when: string) => store.vote(id, randomUUID(), worked, at(when));
  for (let i = 0; i < 5; i++) await vote(ids.old, true, '2026-01-01T00:00:00Z');
  await vote(ids.recent, true, '2026-09-01T00:00:00Z');
  await vote(ids.tied, true, '2026-09-29T00:00:00Z');
  await vote(ids.tied, false, '2026-09-29T00:00:00Z');
  await vote(ids.removed, true, '2026-09-30T00:00:00Z');
  await store.remove(ids.removed);
  await vote(ids.other, true, '2026-09-30T00:00:00Z');
  await vote(ids.tieA, true, '2026-05-05T00:00:00Z');
  await vote(ids.tieB, true, '2026-05-05T00:00:00Z');

  assert.equal((await store.bestRow('ex.com'))!.id, ids.recent);
  assert.equal((await store.bestRow('tie.com'))!.id, ids.tieB, 'ties break by createdAt descending');
  assert.equal(await store.bestRow('nothing.com'), null);

  // Same data through the portable ranking function.
  const rows = (await Promise.all(Object.values(ids).map((id) => store.getRow(id)))).map((r) => ({
    id: r!.id, site: r!.site, worked: r!.worked, failed: r!.failed, lastWorkedAt: r!.last_worked_at, createdAt: r!.created_at, removedAt: r!.removed_at,
  }));
  for (const site of ['ex.com', 'other.com', 'tie.com']) assert.equal(best(rows, site)?.id, (await store.bestRow(site))?.id, site);

  // Site listing: one best per site, most recently confirmed first, paginated.
  const page1 = await store.sites(2, 0);
  assert.deepEqual(page1.rows.map((r) => r.id), [ids.other, ids.recent]);
  assert.equal(page1.more, true);
  const page2 = await store.sites(2, 2);
  assert.deepEqual(page2.rows.map((r) => r.id), [ids.tieB]);
  assert.equal(page2.more, false);
});

test('takedown keeps the row, deletes the content and hides the skill everywhere', async () => {
  const { store, objects } = setup();
  const { id } = await store.add(skill('t'), 'install');
  await store.vote(id, 'a', true);
  assert.equal((await store.bestRow('ex.com'))!.id, id);
  await store.remove(id);
  assert.ok((await store.getRow(id))!.removed_at);
  assert.equal(objects.size, 0);
  assert.equal(await store.bestRow('ex.com'), null);
  assert.equal((await store.sites(10, 0)).rows.length, 0);
  assert.equal((await store.recent('ex.com')).length, 0);
  assert.equal(await store.hasSite('ex.com'), true, 'the site page still 404s only for sites never seen');
});

test('reports are stored and listed newest first until resolved', async () => {
  const { store } = setup();
  await store.report({ skillId: 'sk_1', reason: 'wrong', details: null }, 'i', at('2026-10-01T00:00:00Z'));
  await store.report({ skillId: 'sk_2', reason: 'malicious', details: 'bad' }, 'i', at('2026-10-02T00:00:00Z'));
  assert.deepEqual((await store.openReports()).map((r) => r.skillId), ['sk_2', 'sk_1']);
});

test('hourly rate limits count per subject, reset each hour and never store the raw subject', async () => {
  const { d1, raw } = fakeD1();
  const now = Date.UTC(2026, 9, 1, 10, 15);
  const limits = [{ bucket: 'share:install', subject: 'inst', limit: 2 }, { bucket: 'share:ip', subject: '203.0.113.9', limit: 3 }];
  await checkHourly(d1, limits, now);
  await checkHourly(d1, limits, now);
  await assert.rejects(checkHourly(d1, limits, now), (e: { code: string; status: number; retryAfter: number }) => {
    assert.equal(e.code, 'rate_limited');
    assert.equal(e.status, 429);
    assert.equal(e.retryAfter, 45 * 60);
    return true;
  });
  // A different install from the same IP is still capped by the IP limit.
  await assert.rejects(checkHourly(d1, [{ bucket: 'share:install', subject: 'other', limit: 2 }, limits[1]], now), { code: 'rate_limited' });
  assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM rate_counters').all()).includes('203.0.113.9'));

  const nextHour = now + 3_600_000;
  await checkHourly(d1, limits, nextHour);
  const hours = raw.prepare('SELECT DISTINCT hour FROM rate_counters').all() as { hour: number }[];
  assert.deepEqual(hours.map((h) => h.hour), [Math.floor(nextHour / 3_600_000)], 'past windows are pruned');
});
