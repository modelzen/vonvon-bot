import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { releaseRoute, byteRange } from './r2-linux-worker.mjs';

const base = 'https://example.workers.dev';
const archive = '/bot/server/0.9.1/vonvon-server-0.9.1-linux-x64.tar.gz';
function fixture(overrides = {}) {
  const data = new TextEncoder().encode('0123456789');
  const object = { size: data.length, etag: 'abc', httpEtag: '"abc"', uploaded: new Date('2026-11-04T01:02:03.123Z') };
  const calls = [];
  const binding = {
    async head(key) { calls.push(['head', key]); return object; },
    async get(key, options) {
      calls.push(['get', key, options]);
      const { range } = options;
      const body = new ReadableStream({ start(controller) { controller.enqueue(range ? data.slice(range.offset, range.offset + range.length) : data); controller.close(); } });
      return { ...object, body };
    },
    ...overrides,
  };
  return { env: { LINUX_RELEASES: binding }, calls, object };
}
const request = (path = archive, options = {}) => new Request(base + path, options);

test('route allowlist contains only exact Linux artifacts and public metadata', () => {
  for (const path of [archive, archive.replace('x64', 'arm64'), '/bot/server/0.9.1/manifest.json', '/bot/server/install.sh', '/bot/server/uninstall.sh', '/bot/server/stable/manifest.json']) assert.ok(releaseRoute(path), path);
  for (const path of ['/', '/bot/server/', '/bot/mac/stable/manifest.json', '/bot/windows/stable/x64/update.json', '/bot/server/0.9.1/vonvon-server-0.9.2-linux-x64.tar.gz', '/bot/server/0.9.1/vonvon-server-0.9.1-build.json', '/bot/server/0.9.1/file.tar.gz', '/bot/server/%69nstall.sh', '/bot/server/install.sh/']) assert.equal(releaseRoute(path), null, path);
});

test('GET streams exact bytes and immutable headers without leaking R2 metadata', async () => {
  const { env, calls } = fixture();
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(response.headers.get('Content-Type'), 'application/gzip');
  assert.equal(response.headers.get('ETag'), '"abc"');
  assert.equal(response.headers.get('Last-Modified'), 'Wed, 04 Nov 2026 01:02:03 GMT');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(await response.text(), '0123456789');
  assert.deepEqual(calls[1], ['get', archive.slice(1), { onlyIf: { etagMatches: 'abc' } }]);
});

test('stream response is returned before the producer supplies any body bytes', async () => {
  let controller;
  const { env, object } = fixture({ async get() { return { ...object, body: new ReadableStream({ start(value) { controller = value; } }) }; } });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  controller.enqueue(new TextEncoder().encode('first'));
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  controller.enqueue(new TextEncoder().encode('later'));
  controller.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'later');
  assert.equal((await reader.read()).done, true);
});

test('HEAD reads metadata only and ignores Range', async () => {
  const { env, calls } = fixture();
  const response = await worker.fetch(request(archive, { method: 'HEAD', headers: { Range: 'bytes=1-2' } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(calls.length, 1);
});

test('single ranges include bounded, open-ended and suffix', async () => {
  for (const [value, content, contentRange] of [['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=8-', '89', 'bytes 8-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10'], ['bytes=-99', '0123456789', 'bytes 0-9/10']]) {
    const response = await worker.fetch(request(archive, { headers: { Range: value } }), fixture().env);
    assert.equal(response.status, 206, value);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(content.length));
    assert.equal(await response.text(), content);
  }
});

test('invalid ranges return 416 with full size and no cache', async () => {
  for (const value of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'items=1-2', 'bytes=a-b']) {
    const { env, calls } = fixture();
    const response = await worker.fetch(request(archive, { headers: { Range: value } }), env);
    assert.equal(response.status, 416, value);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls.length, 1);
  }
  assert.equal(byteRange('bytes=0-', 0), null);
});

test('If-Range accepts matching strong etag/date and ignores stale or invalid validators', async () => {
  for (const [value, status] of [['"abc"', 206], ['Wed, 04 Nov 2026 01:02:03 GMT', 206], ['Wed, 04 Nov 2026 01:02:04 GMT', 206], ['"old"', 200], ['W/"abc"', 200], ['Wed, 04 Nov 2026 01:02:02 GMT', 200], ['0', 200]]) {
    const response = await worker.fetch(request(archive, { headers: { Range: 'bytes=2-4', 'If-Range': value } }), fixture().env);
    assert.equal(response.status, status, value);
    assert.equal(await response.text(), status === 206 ? '234' : '0123456789');
  }
});

test('mutable resources and every error bypass caches', async () => {
  for (const path of ['/bot/server/install.sh', '/bot/server/uninstall.sh', '/bot/server/stable/manifest.json']) {
    const response = await worker.fetch(request(path), fixture().env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const [req, env, status] of [
    [request('/bot/mac/stable/manifest.json'), fixture().env, 404],
    [request(archive, { method: 'POST' }), fixture().env, 405],
    [request(), fixture({ async head() { return null; } }).env, 404],
    [request(), fixture({ async head() { throw new Error('SECRET account bucket'); } }).env, 502],
    [request(), fixture({ async get() { return null; } }).env, 404],
    [request(), fixture({ async get() { return { etag: 'changed', size: 10 }; } }).env, 503],
  ]) {
    const response = await worker.fetch(req, env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), `${status}\n`);
  }
  const response = await worker.fetch(request('/unknown', { method: 'HEAD' }), fixture().env);
  assert.equal(response.body, null);
});

test('query strings cannot select another bucket or fetch an arbitrary URL', async () => {
  const { env, calls } = fixture();
  const response = await worker.fetch(request(archive + '?url=https://secret.invalid/&key=bot/mac/file'), env);
  assert.equal(response.status, 200);
  assert.equal(calls[0][1], archive.slice(1));
});
