#!/usr/bin/env node
// Linux-only mirror of an already trusted release. This never signs or changes a version,
// and stable may only copy the exact signed manifest and scripts currently served by COS.
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { archiveName, PUBLISHED_TARGETS, SERVER_BASE_URL, SERVER_PREFIX, SERVER_SCRIPTS } from './server-constants.mjs';
import { MAX_ENVELOPE, compareVersions, installScriptBaseURL, installScriptKey, publicKeyForms, unsignedManifest, verifyServerManifest } from './server-manifest.mjs';
import { releaseRoute } from './r2-linux-worker.mjs';
import { assertMutableCdnResponse } from './release-cdn.mjs';

export const R2_SDK_VERSION = '3.1161.0';
export const R2_PLAN_FILE = 'r2-mirror-plan.json';
export const R2_UPLOAD_RECEIPT = 'r2-publish-receipt.json';
export const R2_STABLE_RECEIPT = 'r2-stable-receipt.json';
const SIGNED_MANIFEST = 'stable-manifest.json';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MUTABLE = 'no-store';
const SHA256 = /^[a-f0-9]{64}$/;
// Slow but progressing overseas transfers get a size-based budget, capped at one hour.
export const r2TransferTimeout = bytes => Math.min(3_600_000, 300_000 + Math.ceil(Math.max(0, bytes || 0) / 65_536) * 1000);
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys, label) => {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label}: unexpected fields`);
};

export function validateR2Config(config) {
  exact(config, ['endpoint', 'bucket', 'publicBaseURL', 'accessKeyIdEnv', 'secretAccessKeyEnv', 'sdkModule'], 'R2 config');
  if (!/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(config.endpoint ?? '')) throw new Error('R2 endpoint must be an HTTPS account S3 endpoint');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? '')) throw new Error('Invalid R2 bucket');
  let url;
  try { url = new URL(config.publicBaseURL); } catch { throw new Error('Invalid R2 publicBaseURL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/bot/server' || url.search || url.hash || url.origin === new URL(SERVER_BASE_URL).origin || url.hostname.endsWith('.r2.dev') || url.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error('R2 publicBaseURL must be an HTTPS read-only gateway ending /bot/server, not the canonical source or r2.dev');
  for (const key of ['accessKeyIdEnv', 'secretAccessKeyEnv']) if (!/^[A-Z_][A-Z0-9_]*$/.test(config[key] ?? '')) throw new Error(`${key} must name an environment variable, never contain a credential`);
  if (config.accessKeyIdEnv === config.secretAccessKeyEnv) throw new Error('R2 credential environment variable names must differ');
  if (!isAbsolute(config.sdkModule ?? '') || basename(config.sdkModule) !== 'client-s3' || basename(dirname(config.sdkModule)) !== '@aws-sdk' || basename(dirname(dirname(config.sdkModule))) !== 'node_modules') throw new Error('sdkModule must be an absolute node_modules/@aws-sdk/client-s3 directory');
  return { ...config };
}

export async function readR2Config(path) {
  return validateR2Config(JSON.parse(await readFile(path, 'utf8')));
}

export async function loadPinnedR2Sdk(sdkModule) {
  const configPath = join(sdkModule, 'package.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(configPath, 'utf8')); } catch { throw new Error('Cannot read the pinned R2 SDK package.json'); }
  if (manifest.name !== '@aws-sdk/client-s3' || manifest.version !== R2_SDK_VERSION) throw new Error(`R2 requires @aws-sdk/client-s3@${R2_SDK_VERSION}`);
  const expected = await readFile(new URL('./r2-sdk/package-lock.json', import.meta.url));
  let installed;
  try { installed = await readFile(join(dirname(dirname(dirname(sdkModule))), 'package-lock.json')); } catch { /* reported below */ }
  if (!installed?.equals(expected)) throw new Error('R2 SDK lockfile differs; install the repository r2-sdk manifest and lockfile in a private prefix with npm ci');
  try { return createRequire(import.meta.url)(sdkModule); } catch { throw new Error('Cannot load the pinned R2 SDK'); }
}

export async function loadR2Client(input, { env = process.env, sdk } = {}) {
  const config = validateR2Config(input);
  const accessKeyId = env[config.accessKeyIdEnv], secretAccessKey = env[config.secretAccessKeyEnv];
  if (!accessKeyId || !secretAccessKey) throw new Error('The named R2 credential environment variables must be set');
  const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = sdk ?? await loadPinnedR2Sdk(config.sdkModule);
  const client = new S3Client({ region: 'auto', endpoint: config.endpoint, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 3, requestHandler: { connectionTimeout: 15_000, socketTimeout: 60_000 }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const send = async (Command, args, timeoutMs = 15_000) => {
    const abortSignal = AbortSignal.timeout(timeoutMs);
    try { return await client.send(new Command({ Bucket: config.bucket, ...args }), { abortSignal }); }
    catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if (status === 404) return null;
      const timedOut = abortSignal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name) || error?.code === 'ETIMEDOUT';
      const safe = new Error(timedOut ? `R2 request timed out (connect/idle limit or ${Math.ceil(timeoutMs / 1000)}s transfer deadline)` : `R2 request failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}`);
      safe.status = status;
      throw safe;
    }
  };
  const metadata = value => value && ({ etag: value.ETag, size: value.ContentLength, cacheControl: value.CacheControl, contentType: value.ContentType });
  return {
    async head(key) { return metadata(await send(HeadObjectCommand, { Key: key })); },
    async get(key, { ifMatch, bytes = 0 } = {}) {
      const value = await send(GetObjectCommand, { Key: key, ...(ifMatch ? { IfMatch: ifMatch } : {}) }, r2TransferTimeout(bytes));
      return value && { ...metadata(value), body: value.Body };
    },
    async put(key, body, { ifMatch, ifNoneMatch, cacheControl, contentType } = {}) {
      const result = await send(PutObjectCommand, { Key: key, Body: body, ContentLength: body.length, ContentMD5: createHash('md5').update(body).digest('base64'), CacheControl: cacheControl, ContentType: contentType, ...(ifMatch ? { IfMatch: ifMatch } : {}), ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}) }, r2TransferTimeout(body.length));
      if (!result) throw new Error('R2 write failed (HTTP 404)');
      return { etag: result.ETag };
    },
    destroy() { client.destroy(); },
  };
}

const target = config => ({ endpoint: config.endpoint, bucket: config.bucket, publicBaseURL: config.publicBaseURL });
const objectURL = (base, key) => `${base}/${key.slice(SERVER_PREFIX.length)}`;
const modeObjects = (plan, mode) => {
  if (!['versioned', 'stable', 'all'].includes(mode)) throw new Error('R2 mode must be versioned, stable, or all');
  return [...(mode !== 'stable' ? plan.versioned : []), ...(mode !== 'versioned' ? plan.stable : [])];
};
export const r2PlanSHA256 = plan => hash(jsonBytes(plan));

function validatePlan(plan, config) {
  exact(plan, ['schemaVersion', 'kind', 'version', 'sourceSha', 'publicKey', 'publishedAt', 'target', 'versioned', 'stable'], 'R2 plan');
  if (plan.schemaVersion !== 1 || plan.kind !== 'r2-linux-mirror' || !/^\d+\.\d+\.\d+$/.test(plan.version ?? '') || !Number.isSafeInteger(plan.publishedAt) || plan.publishedAt <= 0) throw new Error('Invalid R2 plan identity');
  if (plan.sourceSha !== undefined && !/^[a-f0-9]{40}$/.test(plan.sourceSha)) throw new Error('Invalid R2 source SHA');
  publicKeyForms(plan.publicKey);
  if (JSON.stringify(plan.target) !== JSON.stringify(target(config))) throw new Error('R2 plan target differs from config');
  const archiveFiles = PUBLISHED_TARGETS.map(value => archiveName(plan.version, value));
  const requiredVersioned = archiveFiles.map(file => `${SERVER_PREFIX}${plan.version}/${file}`);
  const optionalManifest = `${SERVER_PREFIX}${plan.version}/manifest.json`;
  const stableKeys = [...SERVER_SCRIPTS.map(file => `${SERVER_PREFIX}${file}`), `${SERVER_PREFIX}stable/manifest.json`];
  for (const [kind, objects, required, allowed] of [['versioned', plan.versioned, requiredVersioned, [...requiredVersioned, optionalManifest]], ['stable', plan.stable, stableKeys, stableKeys]]) {
    if (!Array.isArray(objects) || new Set(objects.map(object => object.key)).size !== objects.length || required.some(key => !objects.some(object => object.key === key))) throw new Error(`Incomplete/duplicate R2 ${kind} plan`);
    for (const object of objects) {
      exact(object, ['file', 'key', 'url', 'contentType', 'bytes', 'sha256', 'sha512'], 'R2 object');
      const route = releaseRoute(`/${object.key}`);
      const expectedFile = object.key === `${SERVER_PREFIX}stable/manifest.json` ? SIGNED_MANIFEST : basename(object.key);
      if (!allowed.includes(object.key) || !route || object.file !== expectedFile || object.url !== objectURL(config.publicBaseURL, object.key) || object.contentType !== route.type || !Number.isSafeInteger(object.bytes) || object.bytes <= 0 || !SHA256.test(object.sha256 ?? '') || (object.sha512 !== undefined && !/^[a-f0-9]{128}$/.test(object.sha512))) throw new Error('R2 object is outside the exact Linux release allowlist');
    }
  }
  if (plan.stable.at(-1).file !== SIGNED_MANIFEST) throw new Error('R2 stable manifest must be last');
  return plan;
}

async function localBytes(dir, object) {
  if (basename(object.file) !== object.file) throw new Error('R2 local filename must be flat');
  const path = join(dir, object.file), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== object.bytes) throw new Error(`R2 local size/type changed: ${object.file}`);
  const bytes = await readFile(path);
  if (bytes.length !== object.bytes || hash(bytes) !== object.sha256 || (object.sha512 && hash(bytes, 'sha512') !== object.sha512)) throw new Error(`R2 local bytes changed: ${object.file}`);
  return bytes;
}

async function verifyLocalPlan(dir, plan, config) {
  validatePlan(plan, config);
  const manifestObject = plan.stable.find(object => object.file === SIGNED_MANIFEST);
  const envelope = await localBytes(dir, manifestObject);
  const payload = verifyServerManifest(envelope, plan.publicKey);
  if (payload.version !== plan.version || payload.publishedAt !== plan.publishedAt) throw new Error('R2 plan differs from its signed manifest');
  for (const object of modeObjects(plan, 'all')) {
    const bytes = object === manifestObject ? envelope : await localBytes(dir, object);
    const targetName = PUBLISHED_TARGETS.find(value => object.file === archiveName(plan.version, value));
    if (targetName && (object.bytes !== payload.files[targetName].size || object.sha512 !== payload.files[targetName].sha512 || hash(bytes, 'sha512') !== payload.files[targetName].sha512)) throw new Error(`R2 archive differs from signed manifest: ${object.file}`);
    if (object.key === `${SERVER_PREFIX}${plan.version}/manifest.json` && !bytes.equals(unsignedManifest(payload))) throw new Error('R2 public manifest differs from signed manifest');
    if (object.file === 'install.sh' && (publicKeyForms(installScriptKey(bytes.toString())).base64 !== publicKeyForms(plan.publicKey).base64 || installScriptBaseURL(bytes.toString()) !== SERVER_BASE_URL)) throw new Error('R2 installer key/base URL differs from signed canonical release');
  }
  return { envelope, payload };
}

export async function planR2Mirror({ dir, serverPlan, config: input }) {
  const config = validateR2Config(input);
  if (!plain(serverPlan) || !Array.isArray(serverPlan.versioned) || !Array.isArray(serverPlan.stable)) throw new Error('A trusted server publication plan is required');
  // The server build report is internal provenance, not a download; do not mirror it.
  const buildKey = `${SERVER_PREFIX}${serverPlan.version}/vonvon-server-${serverPlan.version}-build.json`;
  const convert = object => {
    if (object.url !== objectURL(SERVER_BASE_URL, object.key)) throw new Error('Server plan URL differs from canonical COS path');
    const { file, key, contentType, bytes, sha256, sha512 } = object;
    return { file, key, url: objectURL(config.publicBaseURL, key), contentType, bytes, sha256, ...(sha512 ? { sha512 } : {}) };
  };
  const plan = { schemaVersion: 1, kind: 'r2-linux-mirror', version: serverPlan.version, ...(serverPlan.sourceSha ? { sourceSha: serverPlan.sourceSha } : {}), publicKey: publicKeyForms(serverPlan.publicKey).base64, publishedAt: serverPlan.publishedAt, target: target(config), versioned: serverPlan.versioned.filter(object => object.key !== buildKey).map(convert), stable: serverPlan.stable.map(convert) };
  await verifyLocalPlan(dir, plan, config);
  return plan;
}

async function describeLocal(dir, file, key, contentType, sha512 = false) {
  const stat = await lstat(join(dir, file));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`R2 file must be regular: ${file}`);
  const bytes = await readFile(join(dir, file));
  return { file, key, url: objectURL(SERVER_BASE_URL, key), contentType, bytes: bytes.length, sha256: hash(bytes), ...(sha512 ? { sha512: hash(bytes, 'sha512') } : {}) };
}

/** Recover a minimal mirror plan from existing release output without signing or building anything. */
export async function planPublishedR2Mirror({ dir, config, publicKey, sourceSha, fetchImpl = fetch }) {
  const envelope = await readFile(join(dir, SIGNED_MANIFEST));
  const payload = verifyServerManifest(envelope, publicKey);
  const { version, publishedAt } = payload;
  const versioned = await Promise.all(PUBLISHED_TARGETS.map(value => {
    const file = archiveName(version, value);
    return describeLocal(dir, file, `${SERVER_PREFIX}${version}/${file}`, 'application/gzip', true);
  }));
  // Public unsigned metadata is optional; build reports and other output are never copied.
  try { versioned.push(await describeLocal(dir, 'manifest.json', `${SERVER_PREFIX}${version}/manifest.json`, 'application/json', true)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stable = await Promise.all([...SERVER_SCRIPTS.map(file => describeLocal(dir, file, `${SERVER_PREFIX}${file}`, 'text/plain; charset=utf-8')), describeLocal(dir, SIGNED_MANIFEST, `${SERVER_PREFIX}stable/manifest.json`, 'application/json')]);
  const plan = await planR2Mirror({ dir, serverPlan: { version, publishedAt, publicKey, ...(sourceSha ? { sourceSha } : {}), versioned, stable }, config });
  await assertCanonicalStable(plan, fetchImpl);
  return plan;
}

/** The SDK/fetch whole-request deadline is complemented by a per-chunk idle bound. */
export async function* r2BodyChunks(body, { idleTimeoutMs = 60_000 } = {}) {
  const reader = body?.getReader?.();
  const iterator = reader ? { next: () => reader.read(), return: () => reader.cancel() } : body?.[Symbol.asyncIterator]?.();
  if (!iterator) throw new Error('R2 response has no readable body');
  let complete = false;
  try {
    while (true) {
      let timer;
      try {
        const result = await Promise.race([iterator.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('R2 response body stalled (idle timeout)')), idleTimeoutMs); })]);
        if (result.done) { complete = true; return; }
        yield result.value;
      } finally { clearTimeout(timer); }
    }
  } finally {
    if (!complete) {
      body.destroy?.();
      Promise.resolve(iterator.return?.()).catch(() => {});
    }
    if (complete) reader?.releaseLock();
  }
}

function transferProgress({ file, bytes }, phase, { log, onProgress } = {}) {
  const start = Date.now();
  const report = () => {
    const event = { file, bytes, phase, elapsedSeconds: Math.floor((Date.now() - start) / 1000) };
    try { onProgress?.(event); log?.(`R2 ${phase}: ${file} (${bytes} bytes, ${event.elapsedSeconds}s)`); } catch { /* Logging must not change publication semantics. */ }
  };
  report();
  const timer = setInterval(report, 30_000); timer.unref?.();
  return () => clearInterval(timer);
}

async function consume(body, expected, { keep = false } = {}) {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512'), chunks = [];
  let bytes = 0;
  if (!body?.[Symbol.asyncIterator]) throw new Error('R2 response has no readable body');
  for await (const chunk of r2BodyChunks(body)) {
    bytes += chunk.length;
    if (bytes > expected.bytes) throw new Error('R2 remote object exceeds planned size');
    sha256.update(chunk); sha512.update(chunk);
    if (keep) chunks.push(Buffer.from(chunk));
  }
  const digest = sha256.digest('hex'), digest512 = sha512.digest('hex');
  if (bytes !== expected.bytes || digest !== expected.sha256 || (expected.sha512 && digest512 !== expected.sha512)) throw new Error(`R2 remote bytes differ: ${expected.file}`);
  return { bytes, sha256: digest, ...(keep ? { body: Buffer.concat(chunks) } : {}) };
}

async function publicObject(object, baseURL, fetchImpl, { mutable = false } = {}) {
  const url = objectURL(baseURL, object.key);
  // Ordinary exact URL GET: request no-cache or a nonce would hide a stale edge object.
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(r2TransferTimeout(object.bytes)) });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Public mirror verification failed (HTTP ${response.status}): ${object.file}`); }
  const control = response.headers.get('cache-control') ?? '';
  let validCache;
  if (mutable) {
    try { assertMutableCdnResponse(response, { provider: 'tencent', mutablePolicy: 'bypass' }); validCache = true; }
    catch { validCache = false; }
  } else validCache = /(?:^|,)\s*max-age=31536000\s*(?:,|$)/i.test(control) && /(?:^|,)\s*immutable\s*(?:,|$)/i.test(control);
  if (!validCache || response.headers.get('content-type')?.split(';')[0].trim() !== object.contentType.split(';')[0]) { await response.body?.cancel(); throw new Error(`Public mirror headers differ: ${object.file}`); }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== object.bytes) { await response.body?.cancel(); throw new Error(`Public mirror length differs: ${object.file}`); }
  return consume(response.body, object, { keep: object.file === SIGNED_MANIFEST });
}

async function assertCanonicalStable(plan, fetchImpl) {
  for (const object of plan.stable) {
    const result = await publicObject(object, SERVER_BASE_URL, fetchImpl, { mutable: true });
    if (object.file === SIGNED_MANIFEST) assertSignedPlanPayload(plan, result.body);
  }
}

function assertSignedPlanPayload(plan, envelope) {
  const payload = verifyServerManifest(envelope, plan.publicKey);
  if (payload.version !== plan.version || payload.publishedAt !== plan.publishedAt) throw new Error('R2 public signed manifest differs from plan');
  for (const target of PUBLISHED_TARGETS) {
    const object = plan.versioned.find(object => object.file === archiveName(plan.version, target));
    if (object.bytes !== payload.files[target].size || object.sha512 !== payload.files[target].sha512) throw new Error('R2 public signed archive differs from plan');
  }
}

export async function verifyR2Mirror({ plan, config: input, fetchImpl = fetch, mode = 'all', log, onProgress }) {
  const config = validateR2Config(input);
  validatePlan(plan, config);
  const results = [];
  for (const object of modeObjects(plan, mode)) {
    const stop = transferProgress(object, 'verify-public', { log, onProgress });
    try {
      const { body, ...result } = await publicObject(object, config.publicBaseURL, fetchImpl, { mutable: plan.stable.includes(object) });
      if (body) assertSignedPlanPayload(plan, body);
      results.push({ file: object.file, url: object.url, ...result });
    } finally { stop(); }
  }
  return results;
}

async function readTargetManifest(client, plan) {
  const key = `${SERVER_PREFIX}stable/manifest.json`;
  const head = await client.head(key);
  if (!head) return null;
  if (!Number.isSafeInteger(head.size) || head.size <= 0 || head.size > MAX_ENVELOPE || !head.etag) throw new Error('R2 stable manifest metadata is invalid');
  const remote = await client.get(key, { ifMatch: head.etag, bytes: head.size });
  if (!remote || remote.etag !== head.etag) throw new Error('R2 stable manifest changed while reading');
  let size = 0;
  const chunks = [];
  for await (const chunk of r2BodyChunks(remote.body)) { size += chunk.length; if (size > MAX_ENVELOPE) throw new Error('R2 stable manifest too large'); chunks.push(Buffer.from(chunk)); }
  if (size !== head.size) throw new Error('R2 stable manifest size changed');
  const bytes = Buffer.concat(chunks), payload = verifyServerManifest(bytes, plan.publicKey);
  const candidate = plan.stable.find(object => object.file === SIGNED_MANIFEST);
  if (compareVersions(payload.version, plan.version) > 0 || payload.publishedAt > plan.publishedAt || (payload.version === plan.version && hash(bytes) !== candidate.sha256)) throw new Error('R2 stable regression or same-version signed bytes replacement refused');
  return { etag: head.etag, sha256: hash(bytes) };
}

async function assertTargetUnchanged(client, snapshot) {
  const current = await client.head(`${SERVER_PREFIX}stable/manifest.json`);
  if ((current?.etag ?? null) !== (snapshot?.etag ?? null)) throw new Error('R2 stable changed concurrently; re-plan before writing');
}

async function verifyStored(client, object, head, mutable) {
  if (!head || head.size !== object.bytes || !head.etag || head.cacheControl !== (mutable ? MUTABLE : IMMUTABLE) || head.contentType !== object.contentType) throw new Error(`Existing R2 object metadata differs: ${object.file}`);
  const remote = await client.get(object.key, { ifMatch: head.etag, bytes: object.bytes });
  if (!remote || remote.etag !== head.etag) throw new Error(`R2 object changed during verification: ${object.file}`);
  await consume(remote.body, object);
}

async function assertNotCancelled(path) {
  if (path === undefined) return;
  if (!isAbsolute(path)) throw new Error('R2 cancelFile must be absolute');
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('R2 publication stopped by CANCEL');
}

/** Exact plan hash is required even when a caller injects a client. Stable is always last. */
export async function syncR2Mirror({ dir, plan, planSHA256, config: input, client: injectedClient, env = process.env, fetchImpl = fetch, mode = 'all', cancelFile, log, onProgress }) {
  await assertNotCancelled(cancelFile);
  const config = validateR2Config(input);
  if (!SHA256.test(planSHA256 ?? '') || planSHA256 !== r2PlanSHA256(plan)) throw new Error('R2 sync requires the exact reviewed mirror plan SHA-256');
  await verifyLocalPlan(dir, plan, config);
  const objects = modeObjects(plan, mode);
  // Finish every preflight before any cloud write.
  if (mode !== 'versioned') await assertCanonicalStable(plan, fetchImpl);
  const client = injectedClient ?? await loadR2Client(config, { env });
  const results = [];
  try {
    const stableSnapshot = mode !== 'versioned' ? await readTargetManifest(client, plan) : undefined;
    // stable-only also proves all immutable dependencies already exist with exact bytes.
    if (mode === 'stable') for (const object of plan.versioned) await verifyStored(client, object, await client.head(object.key), false);
    for (const object of objects) {
      await assertNotCancelled(cancelFile);
      const mutable = plan.stable.includes(object);
      if (mutable) {
        await assertCanonicalStable(plan, fetchImpl);
        await assertTargetUnchanged(client, stableSnapshot);
      }
      const previous = await client.head(object.key);
      if (object.key === `${SERVER_PREFIX}stable/manifest.json` && (previous?.etag ?? null) !== (stableSnapshot?.etag ?? null)) throw new Error('R2 stable changed concurrently before its conditional write');
      if (previous) {
        try {
          await verifyStored(client, object, previous, mutable);
          results.push({ file: object.file, action: 'already-exact' });
          continue;
        } catch (error) { if (!mutable) throw error; }
      }
      if (previous && !previous.etag) throw new Error('R2 conditional update requires an ETag');
      const body = await localBytes(dir, object);
      const stop = transferProgress(object, 'upload', { log, onProgress });
      try {
        await assertNotCancelled(cancelFile);
        await client.put(object.key, body, { ...(previous ? { ifMatch: previous.etag } : { ifNoneMatch: '*' }), contentType: object.contentType, cacheControl: mutable ? MUTABLE : IMMUTABLE });
      } catch (error) {
        if (error.status !== 412 || mutable) throw error;
        // Another publisher may have concurrently uploaded the exact immutable file.
        await verifyStored(client, object, await client.head(object.key), false);
        results.push({ file: object.file, action: 'already-exact' });
        continue;
      } finally { stop(); }
      const stopVerify = transferProgress(object, 'verify-stored', { log, onProgress });
      try { await verifyStored(client, object, await client.head(object.key), mutable); } finally { stopVerify(); }
      results.push({ file: object.file, action: 'uploaded' });
    }
    await assertNotCancelled(cancelFile);
    if (mode !== 'versioned') await assertCanonicalStable(plan, fetchImpl);
    const verification = await verifyR2Mirror({ plan, config, fetchImpl, mode, log, onProgress });
    return { schemaVersion: 1, status: 'verified', version: plan.version, planSHA256, mode, objects: results, verification };
  } finally { if (!injectedClient) client.destroy?.(); }
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!['plan', 'sync', 'verify'].includes(command)) throw new Error('Usage: release-r2.mjs plan|sync|verify --dir DIR --r2-config CONFIG [--server-plan JSON | --public-key-file FILE] [--plan JSON --plan-sha256 SHA --mode all|versioned|stable]');
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--dir', '--r2-config', '--server-plan', '--public-key-file', '--plan', '--plan-sha256', '--mode'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || flags[args[i]]) throw new Error('Unknown, duplicate, or missing CLI argument');
    flags[args[i]] = args[i + 1];
  }
  if (!flags['--dir'] || !flags['--r2-config']) throw new Error('--dir and --r2-config are required');
  const dir = resolve(flags['--dir']), config = await readR2Config(flags['--r2-config']);
  const planPath = resolve(flags['--plan'] ?? join(dir, R2_PLAN_FILE));
  if (command === 'plan') {
    if (Boolean(flags['--server-plan']) === Boolean(flags['--public-key-file'])) throw new Error('Plan requires exactly one of --server-plan and --public-key-file');
    const plan = flags['--server-plan'] ? await planR2Mirror({ dir, config, serverPlan: JSON.parse(await readFile(flags['--server-plan'], 'utf8')) }) : await planPublishedR2Mirror({ dir, config, publicKey: (await readFile(flags['--public-key-file'], 'utf8')).trim() });
    await writeFile(planPath, jsonBytes(plan), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ plan: planPath, planSHA256: r2PlanSHA256(plan), version: plan.version }));
    return;
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  await verifyLocalPlan(dir, plan, config);
  const options = { dir, plan, config, mode: flags['--mode'] ?? 'all', log: message => console.error(message) };
  const result = command === 'verify' ? await verifyR2Mirror(options) : await syncR2Mirror({ ...options, planSHA256: flags['--plan-sha256'] });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
