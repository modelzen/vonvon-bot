import { describe, expect, it } from 'vitest';
import { fetchManifest, ManifestError, parseSignedManifest, readServerUpdateConfig, SERVER_TARGETS } from '../src/service/standalone-manifest';
import { BASE, fakeCdn, manifestPayload, signManifest, testKeys } from './helpers/fake-cdn';

// main 必败: the standalone manifest did not exist (server-3 C1)
const keys = testKeys();
const reason = (run: () => unknown): string => {
  try { run(); } catch (error) { if (error instanceof ManifestError) return error.reason; throw error; }
  return 'accepted';
};
const parse = (envelope: string, config = keys.config) => parseSignedManifest(Buffer.from(envelope), config);
const signed = (payload: unknown) => signManifest(payload, keys.privateKey);

describe('parseSignedManifest', () => {
  it('reads a signed stable manifest with its six packages', () => {
    const manifest = parse(signed(manifestPayload('1.0.1', 1_700_000_000_000)));
    expect(manifest.version).toBe('1.0.1');
    expect(Object.keys(manifest.files)).toEqual([...SERVER_TARGETS]);
    expect(manifest.files['win-x64'].url).toBe(`${BASE}/1.0.1/vonvon-server-1.0.1-win-x64.zip`);
  });
  it('refuses a changed byte, a short signature, another key and anything a field does not allow', () => {
    const good = JSON.parse(signed(manifestPayload('1.0.1', 1))) as { payload: string; signature: string };
    const bytes = Buffer.from(good.payload, 'base64');
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 2) ^ 1, bytes.length - 2);
    expect(reason(() => parse(JSON.stringify({ ...good, payload: bytes.toString('base64') })))).toBe('signature');
    expect(reason(() => parse(JSON.stringify({ ...good, signature: Buffer.alloc(63).toString('base64') })))).toBe('envelope');
    expect(reason(() => parse(signManifest(manifestPayload('1.0.1', 1), testKeys().privateKey)))).toBe('signature');
    expect(reason(() => parse(JSON.stringify({ ...good, extra: 1 })))).toBe('envelope');
    expect(reason(() => parse(signed({ ...manifestPayload('1.0.1', 1), channel: 'beta' })))).toBe('schema');
    expect(reason(() => parse(signed({ ...manifestPayload('1.0.1', 1), extra: true })))).toBe('schema');
    expect(reason(() => parse(signed(manifestPayload('1.0', 1))))).toBe('schema');
    expect(reason(() => parse(signed(manifestPayload('1.0.1', 1.5))))).toBe('schema');
    const five = manifestPayload('1.0.1', 1) as { files: Record<string, unknown> };
    delete five.files['win-arm64'];
    expect(reason(() => parse(signed(five)))).toBe('schema');
    expect(reason(() => parse(signed(manifestPayload('1.0.1', 1, { 'linux-x64': { url: 'https://example.invalid/bot/server/1.0.1/vonvon-server-1.0.1-linux-x64.tar.gz' } }))))).toBe('url');
    expect(reason(() => parse(signed(manifestPayload('1.0.1', 1, { 'linux-x64': { url: `${BASE}/1.0.0/vonvon-server-1.0.1-linux-x64.tar.gz` } }))))).toBe('url');
    expect(reason(() => parse(signed(manifestPayload('1.0.1', 1, { 'linux-x64': { sha512: 'AB'.repeat(64) } }))))).toBe('schema');
    expect(reason(() => parseSignedManifest(Buffer.alloc(65_537, 32), keys.config))).toBe('too_large');
  });
  it('reads the packaged key and address, and nothing that is not one', () => {
    expect(readServerUpdateConfig(new URL('../server-update.json', import.meta.url).pathname)).toBeNull(); // the placeholder until the signing key exists
  });
});

describe('fetchManifest', () => {
  it('refuses a redirect and stops reading past 64 KiB', async () => {
    const cdn = fakeCdn();
    cdn.routes.set(`${BASE}/stable/manifest.json`, { status: 301, body: '', headers: { location: 'https://elsewhere.invalid/' } });
    await expect(fetchManifest(keys.config, cdn.fetch)).rejects.toMatchObject({ reason: 'http' });
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { sent += 1024; controller.enqueue(new Uint8Array(1024).fill(32)); } });
    const stream = async (): Promise<Response> => new Response(endless, { status: 200 });
    await expect(fetchManifest(keys.config, stream)).rejects.toMatchObject({ reason: 'too_large' });
    expect(sent).toBeLessThan(80 * 1024);
    cdn.routes.set(`${BASE}/stable/manifest.json`, { body: signed(manifestPayload('1.0.2', 5)) });
    expect((await fetchManifest(keys.config, cdn.fetch)).version).toBe('1.0.2');
  });
});
