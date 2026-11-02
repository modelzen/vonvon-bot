// The standalone server's signed manifest for the release scripts (docs/plans/server-3-update-engine.md C1, C2). The
// daemon checks the same shape in packages/daemon/src/service/standalone-manifest.ts, which a script cannot import;
// scripts/fixtures/server-manifest-cases.json holds the samples both sides are tested on. install.sh reads the payload
// with sed, so the bytes signed here are compact JSON with the keys in C1's order.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { PUBLISHED_TARGETS, SERVER_BASE_URL, archiveName } from './server-constants.mjs';

export const MAX_ENVELOPE = 64 * 1024;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA512 = /^[0-9a-f]{128}$/;
// The DER prefix of an Ed25519 SubjectPublicKeyInfo: the raw 32 bytes follow it.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Why a manifest is refused; the daemon's ManifestError uses the same words. */
export class ServerManifestError extends Error {
  constructor(reason, detail) {
    super(`server manifest refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.reason = reason;
  }
}

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strictBase64 = value => {
  const bytes = Buffer.from(value, 'base64');
  return typeof value === 'string' && value.length > 0 && bytes.toString('base64') === value ? bytes : undefined;
};
export const compareVersions = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * Checks a C1 payload exactly as the daemon does: these keys and no others, both Linux packages and no other target,
 * and every url the one `baseURL` gives for its version and target. Throws ServerManifestError ('schema' or 'url').
 */
export function validateServerPayload(payload, baseURL = SERVER_BASE_URL) {
  const schema = detail => new ServerManifestError('schema', detail);
  if (!plainObject(payload)) throw schema('not an object');
  const allowed = ['schemaVersion', 'product', 'channel', 'version', 'publishedAt', 'files', 'notes'];
  const extra = Object.keys(payload).find(key => !allowed.includes(key));
  if (extra) throw schema(`unexpected ${extra}`);
  if (payload.schemaVersion !== 1) throw schema('schemaVersion');
  if (payload.product !== 'vonvon-bot-server') throw schema('product');
  if (payload.channel !== 'stable') throw schema('channel');
  if (typeof payload.version !== 'string' || !VERSION.test(payload.version)) throw schema('version');
  if (!positiveInteger(payload.publishedAt)) throw schema('publishedAt');
  if (payload.notes !== undefined && (typeof payload.notes !== 'string' || payload.notes.length > 4096)) throw schema('notes');
  if (!plainObject(payload.files) || Object.keys(payload.files).sort().join() !== [...PUBLISHED_TARGETS].sort().join()) throw schema('files');
  for (const target of PUBLISHED_TARGETS) {
    const file = payload.files[target];
    if (!plainObject(file) || Object.keys(file).sort().join() !== 'sha512,size,url') throw schema(`files.${target}`);
    if (typeof file.url !== 'string' || !SHA512.test(file.sha512 ?? '') || !positiveInteger(file.size)) throw schema(`files.${target}`);
  }
  for (const target of PUBLISHED_TARGETS) {
    if (payload.files[target].url !== `${baseURL}/${payload.version}/${archiveName(payload.version, target)}`) throw new ServerManifestError('url', target);
  }
  return payload;
}

/** The compact bytes of a payload, keys in C1's order (install.sh matches them literally). */
export function canonicalPayload(payload) {
  const files = Object.fromEntries(PUBLISHED_TARGETS.map(target => {
    const { url, sha512, size } = payload.files[target];
    return [target, { url, sha512, size }];
  }));
  const ordered = { schemaVersion: payload.schemaVersion, product: payload.product, channel: payload.channel, version: payload.version,
    publishedAt: payload.publishedAt, files, ...(payload.notes !== undefined ? { notes: payload.notes } : {}) };
  return Buffer.from(JSON.stringify(ordered));
}

/** The versioned `<version>/manifest.json`: the payload without `channel`, unsigned, for people and the upload check. */
export function unsignedManifest(payload) {
  const { channel: _channel, ...rest } = JSON.parse(canonicalPayload(payload));
  return Buffer.from(`${JSON.stringify(rest, null, 2)}\n`);
}

/** An Ed25519 public key as a KeyObject, from the raw 32 bytes in base64 or an SPKI PEM. */
export function serverPublicKey(value) {
  const text = String(value ?? '').trim();
  if (text.startsWith('-----BEGIN')) {
    const key = createPublicKey(text);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 public key');
    return key;
  }
  const raw = strictBase64(text);
  if (raw?.length !== 32) throw new Error('not an Ed25519 public key (32 raw bytes in base64)');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

/** Both written forms of a public key: raw base64 for server-update.json, SPKI PEM for install.sh. */
export function publicKeyForms(key) {
  const object = typeof key === 'string' ? serverPublicKey(key) : key;
  return { base64: object.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'), pem: object.export({ type: 'spki', format: 'pem' }).toString().trim() };
}

export function publicKeyFromPrivate(privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
  return publicKeyForms(createPublicKey(key));
}

/** The signed envelope bytes, one line: `{"payload":…,"signature":…}` as install.sh's sed expects. */
export function signServerManifest(payload, privateKeyPem, baseURL = SERVER_BASE_URL) {
  validateServerPayload(payload, baseURL);
  const bytes = canonicalPayload(payload);
  const signature = sign(null, bytes, createPrivateKey(privateKeyPem));
  const envelope = Buffer.from(JSON.stringify({ payload: bytes.toString('base64'), signature: signature.toString('base64') }));
  if (envelope.length > MAX_ENVELOPE) throw new ServerManifestError('too_large');
  return envelope;
}

/** Checks an envelope's size, form, signature and payload; returns the payload. */
export function verifyServerManifest(bytes, publicKey, baseURL = SERVER_BASE_URL) {
  if (bytes.length > MAX_ENVELOPE) throw new ServerManifestError('too_large');
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ServerManifestError('envelope'); }
  if (!plainObject(envelope) || Object.keys(envelope).sort().join() !== 'payload,signature') throw new ServerManifestError('envelope');
  const payloadBytes = strictBase64(envelope.payload), signature = strictBase64(envelope.signature);
  if (!payloadBytes || signature?.length !== 64) throw new ServerManifestError('envelope');
  if (!verify(null, payloadBytes, serverPublicKey(publicKey), signature)) throw new ServerManifestError('signature');
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)); }
  catch { throw new ServerManifestError('schema'); }
  return validateServerPayload(payload, baseURL);
}

/** The PEM between install.sh's `# BEGIN VONVON PUBKEY` and `# END VONVON PUBKEY`; '' while it is the empty placeholder. */
export function installScriptKey(text) {
  const block = /# BEGIN VONVON PUBKEY\nPUBKEY_PEM='([^']*)'\n# END VONVON PUBKEY\n/.exec(text);
  if (!block) throw new Error('install.sh has no public key block');
  return block[1].trim();
}
export const installScriptBaseURL = text => /^BASE_URL="([^"]*)"$/m.exec(text)?.[1];
/** install.sh with the key block holding `pem` (tests and the CI smoke use their own key). */
export function withInstallScriptKey(text, pem) {
  installScriptKey(text);
  return text.replace(/# BEGIN VONVON PUBKEY\n[^]*?# END VONVON PUBKEY\n/, `# BEGIN VONVON PUBKEY\nPUBKEY_PEM='${pem.trim()}'\n# END VONVON PUBKEY\n`);
}
