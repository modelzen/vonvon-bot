import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The signed stable manifest of the standalone server (server-3 C1, C2): `{ payload, signature }`, both base64, the
 * signature an Ed25519 one over the decoded payload bytes, with the server's own key (not the Windows desktop one).
 * Nothing in a payload is used before its signature and every field are checked.
 */
export const SERVER_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win-x64', 'win-arm64'] as const;
export type ServerTarget = (typeof SERVER_TARGETS)[number];
const MAX_ENVELOPE = 64 * 1024;

/** scripts/build-server.mjs `archiveName`: zip for Windows, tar.gz for the rest. */
export const archiveName = (version: string, target: string): string => `vonvon-server-${version}-${target}.${target.startsWith('win-') ? 'zip' : 'tar.gz'}`;
export const expectedURL = (baseURL: string, version: string, target: string): string => `${baseURL}/${version}/${archiveName(version, target)}`;
export const manifestURL = (baseURL: string): string => `${baseURL}/stable/manifest.json`;

/** This machine's package, or undefined where no server package is built. */
export function serverTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ServerTarget | undefined {
  const name = `${platform === 'win32' ? 'win' : platform}-${arch}`;
  return (SERVER_TARGETS as readonly string[]).includes(name) ? name as ServerTarget : undefined;
}

const safeInteger = z.number().refine(value => Number.isSafeInteger(value) && value > 0);
const fileSchema = z.object({ url: z.string(), sha512: z.string().regex(/^[0-9a-f]{128}$/), size: safeInteger }).strict();
const payloadSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal('vonvon-bot-server'),
  channel: z.literal('stable'),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  publishedAt: safeInteger,
  files: z.object(Object.fromEntries(SERVER_TARGETS.map(target => [target, fileSchema])) as Record<ServerTarget, typeof fileSchema>).strict(),
  notes: z.string().max(4096).optional(),
}).strict();
export type Manifest = z.infer<typeof payloadSchema>;

export type ManifestFailure = 'too_large' | 'envelope' | 'signature' | 'schema' | 'url' | 'http';
export class ManifestError extends Error {
  constructor(readonly reason: ManifestFailure) { super(`standalone manifest refused: ${reason}`); }
}

/** `packages/daemon/server-update.json`, copied into each package as `app/server-update.json` (C2). */
export type ServerUpdateConfig = { key: KeyObject; baseURL: string };
const configSchema = z.object({ publicKey: z.string(), baseURL: z.string().regex(/^https?:\/\/[^\s/]+(\/[^\s]*[^\s/])?$/) }).strict();
// The DER prefix of an Ed25519 SubjectPublicKeyInfo; desktop/windows-update-manifest.mjs takes PEM keys. Copied, not
// imported: the daemon does not depend on the desktop package.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const strictBase64 = (value: string): Buffer | undefined => {
  const bytes = Buffer.from(value, 'base64');
  return value.length > 0 && bytes.toString('base64') === value ? bytes : undefined;
};

export function publicKeyFromRaw(base64: string): KeyObject {
  const raw = strictBase64(base64);
  if (raw?.length !== 32) throw new Error('server update key is not 32 raw bytes in base64');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

/** null when the file is missing or not a usable key and address: the check then answers `refused: 'config'`. */
export function readServerUpdateConfig(file: string): ServerUpdateConfig | null {
  try {
    const config = configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    return { key: publicKeyFromRaw(config.publicKey), baseURL: config.baseURL };
  } catch { return null; }
}

export function parseSignedManifest(bytes: Uint8Array, config: ServerUpdateConfig): Manifest {
  if (bytes.byteLength > MAX_ENVELOPE) throw new ManifestError('too_large');
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ManifestError('envelope'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new ManifestError('envelope');
  const { payload, signature, ...rest } = envelope as Record<string, unknown>;
  if (Object.keys(rest).length || typeof payload !== 'string' || typeof signature !== 'string') throw new ManifestError('envelope');
  const payloadBytes = strictBase64(payload);
  const signatureBytes = strictBase64(signature);
  if (!payloadBytes || signatureBytes?.length !== 64) throw new ManifestError('envelope');
  if (!verify(null, payloadBytes, config.key, signatureBytes)) throw new ManifestError('signature');
  let parsed: ReturnType<typeof payloadSchema.safeParse>;
  try { parsed = payloadSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes))); }
  catch { throw new ManifestError('schema'); }
  if (!parsed.success) throw new ManifestError('schema');
  const manifest = parsed.data;
  for (const target of SERVER_TARGETS) if (manifest.files[target].url !== expectedURL(config.baseURL, manifest.version, target)) throw new ManifestError('url');
  return manifest;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Reads the stable manifest: no redirects (its address is fixed), 15 s, at most 64 KiB. */
export async function fetchManifest(config: ServerUpdateConfig, fetcher: Fetch = fetch): Promise<Manifest> {
  let response: Response;
  try { response = await fetcher(manifestURL(config.baseURL), { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { 'cache-control': 'no-cache' } }); }
  catch { throw new ManifestError('http'); }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new ManifestError('http');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ENVELOPE) { await reader.cancel().catch(() => undefined); throw new ManifestError('too_large'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError('http');
  }
  return parseSignedManifest(Buffer.concat(chunks), config);
}
