import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFetchable, normalizeSite, siteOf } from '../src/lib/ssrf.ts';
import { validateSkill } from '../src/lib/validate.ts';

test('normalizeSite lowercases and strips one leading www.', () => {
  assert.equal(normalizeSite('WWW.Example.com'), 'example.com');
  assert.equal(siteOf('https://www.Example.com/docs'), 'example.com');
  assert.equal(siteOf('https://docs.stripe.com/x'), 'docs.stripe.com');
});

test('SSRF: private, local, non-https and odd-port targets are refused', () => {
  for (const u of [
    'http://ex.com/',
    'ftp://ex.com/',
    'file:///etc/passwd',
    'https://10.0.0.1/',
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://2130706433/',        // decimal 127.0.0.1
    'https://0x7f.0.0.1/',        // hex 127.0.0.1
    'https://[::1]/',
    'https://[fd00::1]/',
    'https://localhost/',
    'https://localhost./',
    'https://printer.local/',
    'https://db.internal/',
    'https://app.localhost/',
    'https://site.test/',
    'https://ex.com:8443/',
    'https://user:pass@ex.com/',
    'not a url',
  ]) {
    assert.throws(() => assertFetchable(u), { code: 'invalid_request' }, u);
  }
  assert.ok(assertFetchable('https://docs.stripe.com/webhooks.md'));
  assert.ok(assertFetchable('https://docs.stripe.com:443/webhooks.md'));
});

test('SSRF: ALLOW_LOCALHOST opens localhost and 127.0.0.1 only', () => {
  assert.ok(assertFetchable('http://localhost:3000/x', { allowLocalhost: true }));
  assert.ok(assertFetchable('http://127.0.0.1:3000/x', { allowLocalhost: true }));
  for (const u of ['http://192.168.1.1/', 'http://10.0.0.1:80/', 'http://[::1]:3000/', 'http://db.internal/', 'http://ex.com/']) {
    assert.throws(() => assertFetchable(u, { allowLocalhost: true }), { code: 'invalid_request' }, u);
  }
});

test('validateSkill applies the SSRF guard to pageUrl and every section before anything is fetched', () => {
  const body = (url: string) => ({ site: 'metadata.internal', pageUrl: url, sections: [{ kind: 'llms', label: 'x', url, content: 'x' }] });
  assert.throws(() => validateSkill(body('https://metadata.internal/'), false), { code: 'invalid_request' });
  const ok = { site: 'ex.com', pageUrl: 'https://ex.com/', sections: [{ kind: 'llms', label: 'x', url: 'https://10.0.0.1/llms.txt', content: 'x' }] };
  assert.throws(() => validateSkill(ok, false), { code: 'invalid_request' });
});

test('validateSkill: site checks, limits and shapes', () => {
  const base = { site: 'www.Ex.com', pageUrl: 'https://ex.com/a', sections: [{ kind: 'llms', label: 'L', url: 'https://ex.com/llms.txt', content: 'x' }] };
  const v = validateSkill(base, false);
  assert.equal(v.site, 'ex.com');
  assert.deepEqual(v.relatedLinks, []);
  assert.throws(() => validateSkill({ ...base, pageUrl: 'https://other.com/' }, false), { code: 'site_mismatch' });
  assert.throws(() => validateSkill({ ...base, sections: [{ ...base.sections[0], url: 'https://other.com/llms.txt' }] }, false), { code: 'site_mismatch' });
  assert.throws(() => validateSkill({ ...base, relatedLinks: [{ url: 'https://evil.com/', text: 'x' }] }, false), { code: 'site_mismatch' });
  assert.throws(() => validateSkill({ ...base, relatedLinks: Array(101).fill({ url: 'https://ex.com/', text: 'x' }) }, false), { code: 'invalid_request' });
  assert.throws(() => validateSkill({ ...base, sections: Array(7).fill(base.sections[0]) }, false), { code: 'invalid_request' });
  assert.throws(() => validateSkill({ ...base, sections: [{ ...base.sections[0], content: 'x'.repeat(2_000_001) }] }, false), { code: 'too_large', status: 413 });
  assert.throws(() => validateSkill({ ...base, sections: [{ ...base.sections[0], content: null }] }, false), { code: 'invalid_request' });
  assert.throws(() => validateSkill({ ...base, sections: [{ ...base.sections[0], kind: 'llms-full', content: null }] }, false), { code: 'invalid_request' });
  assert.ok(validateSkill({ ...base, sections: [{ ...base.sections[0], kind: 'llms-full', content: null, bytes: 3_000_000 }] }, false));
  assert.throws(() => validateSkill({ ...base, sections: [{ ...base.sections[0], label: '' }] }, false), { code: 'invalid_request' });
  assert.throws(() => validateSkill([], false), { code: 'invalid_request' });
});
