import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMutableCdnResponse, BYPASS_CDN, isMutableReleaseURL, NO_CDN, readReleaseCdnPolicy, releaseCdnDescription, withReleaseCdnVerification } from './release-cdn.mjs';

const cdn = { provider: 'tencent', mutablePolicy: 'bypass' };
const response = (headers, status = 200) => new Response('fixture', { status, headers });

test('CDN contract is explicit and accepts only the implemented mutable bypass mode', () => {
  assert.equal(readReleaseCdnPolicy(undefined), undefined);
  assert.deepEqual(readReleaseCdnPolicy(cdn), cdn);
  assert.equal(releaseCdnDescription(undefined), NO_CDN);
  assert.equal(releaseCdnDescription(cdn), BYPASS_CDN);
  for (const value of [null, false, [], {}, 'tencent', { provider: 'other', mutablePolicy: 'bypass' }, { provider: 'tencent', mutablePolicy: 'refresh' }, { ...cdn, token: 'do-not-print' }]) {
    assert.throws(() => readReleaseCdnPolicy(value), error => /CDN configuration/.test(error.message) && !error.message.includes('do-not-print'));
  }
});

test('CDN mutable responses cannot hide cached content behind permissive origin headers', () => {
  assertMutableCdnResponse(response({ 'cache-control': 'no-cache', age: '0', 'x-cache-lookup': 'Cache Miss' }), cdn);
  assertMutableCdnResponse(response({ 'cache-control': 'no-store, max-age=0, s-maxage=0' }), cdn);
  assertMutableCdnResponse(response({}, 404), cdn);
  for (const headers of [
    {}, { 'cache-control': 'max-age=60' }, { 'cache-control': 'no-cache, s-maxage=600' },
    { 'cache-control': 'no-cache, max-age="60"' }, { 'cache-control': 'no-cache, stale-if-error=300' },
    { 'cache-control': 'no-cache', age: '1' }, { 'cache-control': 'no-cache', age: 'invalid' },
    ...['Hit From MemCache', 'Hit From Disktank', 'Cache Refresh Hit', 'CacheHit', 'Cache Miss, Cache Hit'].map(value => ({ 'cache-control': 'no-cache', 'x-cache-lookup': value })),
  ]) assert.throws(() => assertMutableCdnResponse(response(headers), cdn), /CDN/);
  for (const headers of [{ age: '60' }, { 'cache-control': 'max-age=10' }, { 'x-cache-lookup': 'Cache Hit' }]) {
    assert.throws(() => assertMutableCdnResponse(response(headers, 404), cdn), /CDN/, 'negative cache must also bypass');
  }
  assert.doesNotThrow(() => assertMutableCdnResponse(response({ 'cache-control': 'max-age=60' }), undefined));
});

test('only mutable release URLs receive bypass checks; versioned Mac files under stable remain cacheable', () => {
  for (const path of ['/bot/mac/stable/manifest.json', '/bot/windows/stable/x64/update.json', '/bot/windows/stable/arm64/update.json', '/bot/server/stable/manifest.json', '/bot/server/install.sh', '/bot/server/uninstall.sh']) {
    assert.equal(isMutableReleaseURL(`https://dl.vonvon.cc${path}`), true, path);
  }
  for (const path of ['/bot/mac/stable/feed-0.9.1.json', '/bot/mac/stable/Vonvon-Bot-0.9.1-arm64.zip', '/bot/windows/0.9.1/app.exe', '/bot/server/0.9.1/manifest.json']) {
    assert.equal(isMutableReleaseURL(`https://dl.vonvon.cc${path}`), false, path);
  }
  assert.equal(isMutableReleaseURL('https://foreign.example/bot/mac/stable/manifest.json'), false);
});

test('verification keeps ordinary URL/request semantics and cancels rejected response bodies', async () => {
  let cancelled = false;
  const unsafe = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'cache-control': 'no-cache', 'x-cache-lookup': 'Cache Hit' } });
  const options = { redirect: 'error' }, url = 'https://dl.vonvon.cc/bot/mac/stable/manifest.json';
  const fetchImpl = async (seenURL, seenOptions) => { assert.equal(seenURL, url); assert.equal(seenOptions, options); return unsafe; };
  assert.equal(withReleaseCdnVerification(fetchImpl, undefined), fetchImpl);
  await assert.rejects(withReleaseCdnVerification(fetchImpl, cdn)(url, options), /cached mutable/);
  assert.equal(cancelled, true);
});
