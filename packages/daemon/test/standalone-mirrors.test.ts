import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchManifestFromSources, readServerUpdateConfig, type Fetch } from '../src/service/standalone-manifest';
import { downloadServerArtifact } from '../src/service/standalone-transport';
import { BASE, manifestPayload, signManifest, testKeys } from './helpers/fake-cdn';

const MIRROR = 'https://mirror.example.test/bot/server';
const keys = testKeys();
const config = { ...keys.config, mirrorBaseURLs: [MIRROR] };
const signed = signManifest(manifestPayload('1.0.1', 10), keys.privateKey);
const directories: string[] = [];
const temporary = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), 'vonvon-mirror-')); directories.push(dir); return dir; };
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('parallel signed manifest selection', () => {
  it('uses the valid mirror after 300 ms grace even when domestic fetch ignores abort', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher: Fetch = async (url, init) => {
      signals.push(init!.signal!);
      if (url.startsWith(BASE)) return new Promise<Response>(() => undefined);
      return new Response(signed);
    };
    let settled = false;
    const selected = fetchManifestFromSources(config, fetcher).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    expect(signals).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await selected).sourceBaseURL).toBe(MIRROR);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('prefers domestic when it becomes usable during the short grace', async () => {
    vi.useFakeTimers();
    const fetcher: Fetch = async url => {
      if (url.startsWith(BASE)) await new Promise(resolve => setTimeout(resolve, 200));
      return new Response(signed);
    };
    const selected = fetchManifestFromSources(config, fetcher);
    await vi.advanceTimersByTimeAsync(200);
    expect((await selected).sourceBaseURL).toBe(BASE);
  });

  it('does not wait for the grace when domestic has already failed', async () => {
    vi.useFakeTimers();
    const selected = fetchManifestFromSources(config, async url => new Response(url.startsWith(BASE) ? '' : signed, { status: url.startsWith(BASE) ? 503 : 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await selected).sourceBaseURL).toBe(MIRROR);
  });

  it('ignores a mirror with another signing key, while retaining canonical URLs on a good mirror', async () => {
    const bad = signManifest(manifestPayload('1.0.1', 10), testKeys().privateKey);
    const selected = await fetchManifestFromSources(config, async url => new Response(url.startsWith(BASE) ? signed : bad));
    expect(selected.sourceBaseURL).toBe(BASE);
    const goodMirror = await fetchManifestFromSources(config, async url => new Response(url.startsWith(BASE) ? '' : signed, { status: url.startsWith(BASE) ? 503 : 200 }));
    expect(goodMirror.manifest.files['linux-x64'].url.startsWith(BASE)).toBe(true);
  });

  it('rejects a signed manifest that rewrites package URLs to its mirror or any other origin', async () => {
    const redirected = signManifest(manifestPayload('1.0.1', 10, {}, MIRROR), keys.privateKey);
    await expect(fetchManifestFromSources(config, async url => new Response(url.startsWith(BASE) ? '' : redirected, { status: url.startsWith(BASE) ? 503 : 200 }))).rejects.toMatchObject({ reason: 'url' });
  });

  it('bounds a stalled response body and closes a response arriving after its source lost', async () => {
    vi.useFakeTimers();
    let cancel = false;
    const hangingBody = new ReadableStream<Uint8Array>({ cancel() { cancel = true; } });
    const selected = fetchManifestFromSources(config, async url => new Response(url.startsWith(BASE) ? hangingBody : signed));
    await vi.advanceTimersByTimeAsync(300);
    expect((await selected).sourceBaseURL).toBe(MIRROR);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toBe(true);

    let deliver!: (response: Response) => void;
    const late = fetchManifestFromSources(config, async url => url.startsWith(BASE) ? new Promise<Response>(resolve => { deliver = resolve; }) : new Response(signed));
    await vi.advanceTimersByTimeAsync(300);
    expect((await late).sourceBaseURL).toBe(MIRROR);
    let lateCancelled = false;
    deliver(new Response(new ReadableStream({ cancel() { lateCancelled = true; } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(lateCancelled).toBe(true);
  });

  it('bounds all-source failures even when every fetch adapter ignores abort', async () => {
    vi.useFakeTimers();
    const failed = expect(fetchManifestFromSources(config, async () => new Promise<Response>(() => undefined))).rejects.toMatchObject({ reason: 'http' });
    await vi.advanceTimersByTimeAsync(8_000);
    await failed;
  });
});

describe('packaged trusted mirror configuration', () => {
  it('accepts the old shape and explicit HTTPS mirrors, rejects unsafe or extra settings', async () => {
    const file = join(await temporary(), 'server-update.json');
    const original = { publicKey: keys.raw, baseURL: 'https://dl.vonvon.cc/bot/server' };
    await writeFile(file, JSON.stringify(original));
    expect(readServerUpdateConfig(file)?.mirrorBaseURLs).toBeUndefined();
    await writeFile(file, JSON.stringify({ ...original, mirrorBaseURLs: [MIRROR] }));
    expect(readServerUpdateConfig(file)?.mirrorBaseURLs).toEqual([MIRROR]);
    for (const mirrorBaseURLs of [[MIRROR, MIRROR], [original.baseURL], ['http://mirror.example.test/bot/server'],
      ['https://user:pass@mirror.example.test/bot/server'], [`${MIRROR}?redirect=1`], [`${MIRROR}#fragment`],
      ['https://mirror.example.test/../bot/server'], [`${MIRROR}/`], [`${MIRROR}/%2e%2e`]]) {
      await writeFile(file, JSON.stringify({ ...original, mirrorBaseURLs }));
      expect(readServerUpdateConfig(file), JSON.stringify(mirrorBaseURLs)).toBeNull();
    }
    await writeFile(file, JSON.stringify({ ...original, mirrorBaseURLs: [MIRROR], sourceFromEnv: 'URL' }));
    expect(readServerUpdateConfig(file)).toBeNull();
  });
});

describe('artifact transport with safe restart', () => {
  const bytes = Buffer.from('signed artifact contents');
  const file = { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') };
  const urls = [`${BASE}/1.0.1/archive.tar.gz`, `${MIRROR}/1.0.1/archive.tar.gz`];
  const fixture = async () => ({ file, urls, destination: join(await temporary(), 'download.tar.gz') });

  it('restarts after a partial source failure, without mixing bytes, and disables redirects', async () => {
    const options = await fixture();
    const requests: { url: string; init?: RequestInit }[] = [];
    let calls = 0;
    const fetcher: Fetch = async (url, init) => {
      requests.push({ url, init });
      if (calls++) return new Response(bytes);
      let pulls = 0;
      return new Response(new ReadableStream({ pull(controller) { if (pulls++) controller.error(new Error('reset')); else controller.enqueue(Buffer.from('bad partial')); } }), { headers: { 'content-length': String(bytes.length) } });
    };
    await downloadServerArtifact({ ...options, fetcher });
    expect(await readFile(options.destination)).toEqual(bytes);
    expect(requests.map(request => request.url)).toEqual(urls);
    expect(requests.every(request => request.init?.redirect === 'error')).toBe(true);
  });

  it('can recover from corrupted bytes on one source, but refuses corruption on every source', async () => {
    const options = await fixture();
    await downloadServerArtifact({ ...options, fetcher: async url => new Response(url.startsWith(BASE) ? Buffer.alloc(bytes.length) : bytes) });
    expect(await readFile(options.destination)).toEqual(bytes);
    await expect(downloadServerArtifact({ ...await fixture(), fetcher: async () => new Response(Buffer.alloc(bytes.length)) })).rejects.toThrow('下载内容和发布清单不一致');
  });

  it('fails over a request that ignores abort and a body that stops producing bytes', async () => {
    for (const mode of ['headers', 'body']) {
      const options = await fixture();
      let cancelled = false;
      const fetcher: Fetch = async url => {
        if (!url.startsWith(BASE)) return new Response(bytes);
        if (mode === 'headers') return new Promise<Response>(() => undefined);
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 3)); }, cancel() { cancelled = true; } }));
      };
      await downloadServerArtifact({ ...options, fetcher, policy: { connectMs: 40, idleMs: 40 } });
      expect(await readFile(options.destination)).toEqual(bytes);
      if (mode === 'body') expect(cancelled).toBe(true);
    }
  });

  it('permits a progressing download longer than its connection and idle deadlines', async () => {
    const options = await fixture();
    const fetcher: Fetch = async () => {
      let offset = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        await new Promise(resolve => setTimeout(resolve, 15));
        controller.enqueue(bytes.subarray(offset, ++offset));
      } }));
    };
    await downloadServerArtifact({ ...options, fetcher, policy: { connectMs: 100, idleMs: 100 } });
    expect(await readFile(options.destination)).toEqual(bytes);
  });

  it('refuses redirects, oversized streams and lengths inconsistent with the signed artifact', async () => {
    for (const response of [() => new Response('', { status: 302, headers: { location: 'https://untrusted.test/' } }),
      () => new Response(Buffer.concat([bytes, bytes])),
      () => new Response(bytes, { headers: { 'content-length': String(bytes.length - 1) } })]) {
      await expect(downloadServerArtifact({ ...await fixture(), fetcher: async () => response() })).rejects.toThrow();
    }
  });
});
