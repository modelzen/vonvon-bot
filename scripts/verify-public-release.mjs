import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_MANIFEST_URL = 'https://dl.vonvon.cc/bot/mac/stable/manifest.json';
const immutableCache = 'public, max-age=31536000, immutable';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hashPattern = /^[a-f0-9]{64}$/;
const parseJSON = value => { try { return JSON.parse(value); } catch { throw new Error('Invalid JSON in release evidence or HTTP response'); } };

// Each of these either disables verification, swaps the trust store, or preloads code that can.
const trustStoreOverrides = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_USE_SYSTEM_CA'];
const forbiddenNodeFlag = /insecure|^--use-(?:openssl|system)-ca$|^--openssl-config(?:=|$)|^--require(?:=|$)|^-r(?:=|$)|^--import(?:=|$)|^--(?:experimental-)?loader(?:=|$)/i;
export function assertSecureTransport(env = process.env, execArgv = process.execArgv) {
  const flags = [...String(env.NODE_OPTIONS ?? '').split(/\s+/), ...execArgv].filter(Boolean);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || trustStoreOverrides.some(name => env[name]) || flags.some(flag => forbiddenNodeFlag.test(flag))) {
    throw new Error('TLS verification bypasses and trust-store overrides are forbidden; repair the endpoint certificate');
  }
}

function httpsURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Expected a credential-free HTTPS release URL');
  return url;
}

export function cachePolicy(headers, kind) {
  const cache = headers.get('cache-control')?.toLowerCase() ?? '';
  const directives = cache.split(',').map(part => part.trim());
  const age = directives.find(part => /^max-age=\d+$/.test(part));
  if (kind === 'manifest') {
    if (!directives.includes('no-cache') && !(age && Number(age.slice(8)) <= 60)) throw new Error('Manifest requires Cache-Control: no-cache or max-age <= 60');
    const shared = directives.find(part => /^s-maxage=\d+$/.test(part));
    if (shared && Number(shared.slice(9)) > 60) throw new Error('Manifest CDN cache TTL exceeds 60 seconds');
  } else if (!directives.includes('public') || !directives.includes('immutable') || !age || Number(age.slice(8)) < 31536000) {
    throw new Error(`Versioned objects require Cache-Control: ${immutableCache}`);
  }
}

async function limitedBody(response, maximum = 16384) {
  const chunks = []; let size = 0;
  if (!response.body) throw new Error('HTTP response has no body');
  for await (const value of response.body) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > maximum) { await response.body.cancel().catch(() => {}); throw new Error('Release JSON exceeds 16384 bytes'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonHeaders(response) {
  if (!/^application\/(?:json|[^;\s]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Release JSON requires an application/json Content-Type');
}

export function validateManifest(manifest, url = DEFAULT_MANIFEST_URL) {
  const source = httpsURL(url);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== 'feedURL,version'
    || typeof manifest.version !== 'string' || !versionPattern.test(manifest.version) || typeof manifest.feedURL !== 'string') throw new Error('Invalid strict {version, feedURL} manifest');
  const feed = httpsURL(manifest.feedURL);
  if (feed.origin !== source.origin || feed.href !== new URL(`feed-${manifest.version}.json`, source).href) throw new Error('Manifest feed must use its version in the same HTTPS directory');
  return manifest;
}

/** Strict TLS and no redirects also apply to the explicit first-release missing result. */
export async function readStableManifest({ fetchImpl = fetch, url = DEFAULT_MANIFEST_URL, env = process.env } = {}) {
  assertSecureTransport(env); httpsURL(url);
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (response.redirected) throw new Error('Release endpoint redirected');
  // COS answers NoSuchKey with 404; every other status, including 400, 403 and 5xx, fails closed.
  if (response.status === 404) return { kind: 'missing', status: 404, code: 'HTTP404' };
  if (response.status !== 200) throw new Error(`Stable manifest HTTP ${response.status}; no empty baseline may be inferred`);
  jsonHeaders(response);
  // The exact bytes are kept so a publisher can snapshot, hash and later restore the previous manifest.
  const bytes = await limitedBody(response);
  return { kind: 'present', manifest: validateManifest(parseJSON(bytes.toString('utf8')), url), bytes, responseHeaders: response.headers };
}

async function fileRecord(path) {
  const info = await fs.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error('Release artifact must be a nonempty regular file');
  const handle = await fs.open(path, 'r');
  const hash = createHash('sha256');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); }
  return { file: basename(path), size: info.size, sha256: hash.digest('hex') };
}

function validRecord(record) {
  return record && typeof record.file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.file)
    && hashPattern.test(record.sha256 ?? '') && Number.isSafeInteger(record.size) && record.size > 0;
}

/** This gate only reads local evidence. It grants no upload or stable-switch authorization. */
export async function validateReleaseInventory(out, { version, sha } = {}) {
  if (!versionPattern.test(version ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Supply the expected version and full source SHA');
  try { await fs.lstat(join(out, 'DO-NOT-PUBLISH')); throw new Error('Rehearsal output cannot be published'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const inventory = parseJSON(await fs.readFile(join(out, 'release-inventory.json'), 'utf8'));
  const state = parseJSON(await fs.readFile(join(out, 'notarization-state.json'), 'utf8'));
  if (inventory.complete !== true || inventory.mode !== 'release' || state.context?.mode !== 'release' || state.complete !== true
    || inventory.version !== version || state.context.version !== version || inventory.sourceCommit !== sha || state.context.sourceCommit !== sha) throw new Error('Only a complete formal release matching this version and source SHA may be published');
  const required = ['manifest.json', `feed-${version}.json`, `Vonvon-Bot-${version}-universal.zip`, `Vonvon-Bot-${version}-universal.dmg`].sort();
  if (!Array.isArray(inventory.files) || inventory.files.some(record => !validRecord(record))
    || inventory.files.map(record => record.file).sort().join(',') !== required.join(',')) throw new Error('Inventory must contain exactly the four public release artifacts');
  if (!Array.isArray(state.files) || state.files.some(record => !validRecord(record))
    || state.files.map(record => record.file).sort().join(',') !== [...required, 'release-inventory.json'].sort().join(',')) throw new Error('Completed state must bind all public files and inventory');
  const sums = new Map();
  for (const line of (await fs.readFile(join(out, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/);
    if (!match || sums.has(match[2])) throw new Error('Malformed or duplicate SHA256SUMS entry');
    sums.set(match[2], match[1]);
  }
  if (sums.size !== state.files.length) throw new Error('SHA256SUMS does not cover the completed release exactly');
  for (const record of state.files) {
    const actual = await fileRecord(join(out, record.file));
    if (actual.sha256 !== record.sha256 || actual.size !== record.size || sums.get(record.file) !== actual.sha256) throw new Error('Release bytes do not match completed state and SHA256SUMS');
    const publicRecord = inventory.files.find(item => item.file === record.file);
    if (publicRecord && (publicRecord.sha256 !== actual.sha256 || publicRecord.size !== actual.size)) throw new Error('Inventory hashes differ from release bytes');
  }
  validateManifest(parseJSON(await fs.readFile(join(out, 'manifest.json'), 'utf8')));
  return { inventory, state, files: inventory.files };
}

async function verifyDownload(url, record, fetchImpl, json = false) {
  const response = await fetchImpl(httpsURL(url).href, { redirect: 'error', signal: AbortSignal.timeout(json ? 15000 : 20 * 60_000) });
  if (response.status !== 200 || response.redirected || !response.body) throw new Error(`Public artifact ${record.file} must return HTTP 200 without redirects`);
  cachePolicy(response.headers, record.file === 'manifest.json' ? 'manifest' : 'versioned');
  if (json) jsonHeaders(response);
  const hash = createHash('sha256'); let size = 0; const chunks = [];
  for await (const value of response.body) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > record.size || (json && size > 16384)) throw new Error(`Public artifact ${record.file} exceeds its expected size`);
    hash.update(chunk); if (json) chunks.push(chunk);
  }
  if (size !== record.size || hash.digest('hex') !== record.sha256) throw new Error(`Public artifact ${record.file} SHA-256 or size mismatch`);
  return json ? parseJSON(Buffer.concat(chunks).toString('utf8')) : undefined;
}

function checkFeed(feed, version) {
  if (!feed || Object.keys(feed).sort().join(',') !== 'name,notes,pub_date,url' || typeof feed.notes !== 'string'
    || feed.name !== `Vonvon Bot ${version}` || !Number.isFinite(Date.parse(feed.pub_date))
    || feed.url !== new URL(`Vonvon-Bot-${version}-universal.zip`, DEFAULT_MANIFEST_URL).href) throw new Error('Public Squirrel feed differs from this release');
}

/** Feed, ZIP and DMG: HTTP 200, no redirects, headers, exact size and full SHA-256. */
async function verifyVersionedObjects(evidence, version, manifest, fetchImpl) {
  const byName = name => evidence.files.find(record => record.file === name);
  const urls = { [`feed-${version}.json`]: manifest.feedURL };
  checkFeed(await verifyDownload(manifest.feedURL, byName(`feed-${version}.json`), fetchImpl, true), version);
  for (const extension of ['zip', 'dmg']) {
    const record = byName(`Vonvon-Bot-${version}-universal.${extension}`);
    urls[record.file] = new URL(record.file, DEFAULT_MANIFEST_URL).href;
    await verifyDownload(urls[record.file], record, fetchImpl);
  }
  return evidence.files.filter(record => urls[record.file]).map(record => ({ ...record, url: urls[record.file] }));
}

export async function verifyPublicRelease({ out, version, sha, fetchImpl = fetch, env = process.env } = {}) {
  assertSecureTransport(env);
  const evidence = await validateReleaseInventory(out, { version, sha });
  const manifest = validateManifest(await verifyDownload(DEFAULT_MANIFEST_URL, evidence.files.find(record => record.file === 'manifest.json'), fetchImpl, true));
  if (manifest.version !== version) throw new Error('Public manifest differs from the expected release version');
  await verifyVersionedObjects(evidence, version, manifest, fetchImpl);
  return { version, sourceCommit: sha, verifiedAt: new Date().toISOString(), files: evidence.files, publiclyVerified: true };
}

/**
 * Before the stable switch the live manifest is 404 or an older release, so it is not read.
 * URLs come from the local manifest; the result is the evidence shown to the owner.
 */
export async function verifyVersionedRelease({ out, version, sha, fetchImpl = fetch, env = process.env } = {}) {
  assertSecureTransport(env);
  const evidence = await validateReleaseInventory(out, { version, sha });
  const manifest = validateManifest(parseJSON(await fs.readFile(join(out, 'manifest.json'), 'utf8')));
  if (manifest.version !== version) throw new Error('Local manifest differs from the expected release version');
  const files = await verifyVersionedObjects(evidence, version, manifest, fetchImpl);
  return { version, sourceCommit: sha, verifiedAt: new Date().toISOString(), notarization: evidence.inventory.notarization ?? null, files,
    stableManifest: 'not read or changed', versionedObjectsVerified: true };
}

// macOS mktemp paths live under the /var -> /private/var link; ESM entry URLs are
// realpaths, so compare realpaths or the CLI is silently skipped with exit 0.
const invokedPath = process.argv[1] ? await fs.realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath && invokedPath === await fs.realpath(fileURLToPath(import.meta.url))) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' }, version: { type: 'string' }, sha: { type: 'string' }, 'local-only': { type: 'boolean' }, 'versioned-only': { type: 'boolean' } } });
    if (!values.out || !values.version || !values.sha || (values['local-only'] && values['versioned-only'])) throw new Error('Use --out /persistent/evidence --version X.Y.Z --sha FULL_SHA [--local-only | --versioned-only]');
    if (values['local-only']) { await validateReleaseInventory(values.out, values); console.log('Local formal-release evidence verified. No upload or stable switch authorized.'); }
    else if (values['versioned-only']) console.log(JSON.stringify(await verifyVersionedRelease(values), null, 2));
    else console.log(JSON.stringify(await verifyPublicRelease(values), null, 2));
  } catch (error) { console.error(error.message.replace(/\/Users\/[^/\s"']+/g, '/Users/<u>')); process.exitCode = 1; }
}
