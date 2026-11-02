import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { publicKeyFromRaw, SERVER_TARGETS, expectedURL, type ServerUpdateConfig } from '../../src/service/standalone-manifest';

/** A CDN in memory for the standalone update tests: no network. Each request is recorded. */
export type Served = { status?: number; body: Uint8Array | string; headers?: Record<string, string> };
export const BASE = 'http://127.0.0.1:9/bot/server';

export function fakeCdn() {
  const routes = new Map<string, Served>();
  const requests: string[] = [];
  const fetch = async (url: string | URL | Request): Promise<Response> => {
    const key = String(url);
    requests.push(key);
    const route = routes.get(key);
    if (!route) return new Response('missing', { status: 404 });
    const body = typeof route.body === 'string' ? Buffer.from(route.body) : route.body;
    return new Response(body, { status: route.status ?? 200, headers: { 'content-length': String(body.byteLength), ...route.headers } });
  };
  return { routes, requests, fetch };
}

/** A key pair made for the test run; never stored. */
export function testKeys(): { privateKey: KeyObject; raw: string; config: ServerUpdateConfig } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  return { privateKey, raw, config: { key: publicKeyFromRaw(raw), baseURL: BASE } };
}

type FileEntry = { url?: string; sha512?: string; size?: number };
export function manifestPayload(version: string, publishedAt: number, files: Partial<Record<string, FileEntry>> = {}, base = BASE): Record<string, unknown> {
  return {
    schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version, publishedAt,
    files: Object.fromEntries(SERVER_TARGETS.map(target => [target, { url: expectedURL(base, version, target), sha512: '0'.repeat(128), size: 1, ...files[target] }])),
  };
}

export function signManifest(payload: unknown, privateKey: KeyObject): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({ payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') });
}
