import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { assertCredentialEnvNames, cosCredentialEnvNames, loadPinnedSdk } from './release-cos-evidence.mjs';
import { assertSecureTransport, cachePolicy } from './verify-public-release.mjs';
import { validateWindowsInventory, verifyWindowsArtifacts } from './package-windows.mjs';
import { resolveDownloadEnvironment } from './release-network.mjs';
import { readReleaseCdnPolicy, releaseCdnDescription, withReleaseCdnVerification } from './release-cdn.mjs';
import { signWindowsUpdate, verifyWindowsUpdate, publicKeyFromPrivate, normalizeWindowsPublicKey } from './windows-update-signing.mjs';

const exec = promisify(execFile);
const repository = 'modelzen/vonvon-bot';
const baseURL = 'https://dl.vonvon.cc/bot/windows/';
const immutable = 'public, max-age=31536000, immutable';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const json = value => JSON.stringify(value, null, 2) + '\n';
const mime = { installer: 'application/octet-stream', zip: 'application/zip', blockmap: 'application/octet-stream' };

export function validateBuildRun(run) {
  if (run?.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.path !== '.github/workflows/windows-release.yml' || run.status !== 'completed' || run.conclusion !== 'success' ||
      !['push', 'workflow_dispatch'].includes(run.event) || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
    throw new Error('Expected a successful Windows release build from the owning repository');
  }
  if (run.display_title?.startsWith('windows-release ')) {
    const pinned = /^windows-release (\d+\.\d+\.\d+) ([a-f0-9]{40}) ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(run.display_title);
    if (!pinned || run.event !== 'workflow_dispatch' || run.head_branch !== 'main') throw new Error('Pinned Windows builds must be dispatched through main with complete source metadata');
    return pinned[2];
  }
  return run.head_sha;
}

export async function readWindowsCosConfig(path) {
  if (!isAbsolute(path ?? '')) throw new Error('Use an absolute external --cos-config path');
  const config = JSON.parse(await readFile(path, 'utf8'));
  const fields = ['bucket', 'region', 'prefix', 'publicBaseURL', 'secretIdEnv', 'secretKeyEnv', 'securityTokenEnv', 'sdkModule', 'updatePrivateKeyFile', 'cdn'];
  if (!config || Object.keys(config).some(key => !fields.includes(key)) ||
      !/^[a-z0-9-]+-\d+$/.test(config.bucket ?? '') || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(config.region ?? '') ||
      config.prefix !== 'bot/windows/' || config.publicBaseURL !== baseURL || !config.secretIdEnv || !config.secretKeyEnv) {
    throw new Error('Windows COS config must specify bot/windows/ and its fixed public base URL, with credential variable names only');
  }
  assertCredentialEnvNames(config);
  readReleaseCdnPolicy(config.cdn);
  if (config.updatePrivateKeyFile !== undefined && !isAbsolute(config.updatePrivateKeyFile)) throw new Error('Windows update signing key must use an absolute external file path');
  return config;
}

export function windowsObjectPlan(inventory) {
  validateWindowsInventory(inventory);
  return inventory.artifacts.filter(item => item.kind !== 'feed').map(item => ({
    ...item, key: `bot/windows/${inventory.version}/${item.file}`,
    url: `${baseURL}${inventory.version}/${item.file}`, contentType: mime[item.kind],
  }));
}

async function ghJSON(args, env) {
  const result = await exec('gh', args, { env, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
}

export async function downloadBuild({ runId, out, env, execute = exec, api = ghJSON, expectedSha, expectedVersion, downloadEnvironment = resolveDownloadEnvironment }) {
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error('Use a GitHub Actions --run-id');
  const run = await api(['api', `repos/${repository}/actions/runs/${runId}`], env);
  const sourceSha = validateBuildRun(run);
  if (expectedSha && expectedSha !== sourceSha) throw new Error('Windows run differs from the expected release SHA');
  if (run.display_title?.startsWith('windows-release ')) {
    // The Actions head SHA identifies the workflow definition; the input identifies checkout source.
    // Both must remain on main. Keep both in provenance rather than weakening head_sha to a label.
    for (const sha of new Set([sourceSha, run.head_sha])) {
      const comparison = await api(['api', `repos/${repository}/compare/${sha}...main`], env);
      if (!['ahead', 'identical'].includes(comparison.status) || comparison.merge_base_commit?.sha !== sha) throw new Error('Pinned Windows source or workflow definition is not on main');
    }
    if (expectedVersion && run.display_title.split(' ')[1] !== expectedVersion) throw new Error('Pinned Windows run version differs from the expected version');
  }
  // A rerun may produce a different attempt; retain its exact provenance alongside the bytes.
  const listing = await api(['api', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`], env);
  const artifacts = listing.artifacts?.filter(item => !item.expired && new RegExp(`^windows-unsigned-\\d+\\.\\d+\\.\\d+-${sourceSha.slice(0, 12)}$`).test(item.name));
  if (artifacts?.length !== 1) throw new Error('Expected exactly one unexpired Windows build artifact');
  await mkdir(dirname(out), { recursive: true });
  const provenancePath = join(out, 'github-build.json');
  const entries = await readdir(out).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!entries?.length) {
    const staging = await mkdtemp(join(dirname(out), '.windows-download-'));
    try {
      const downloadEnv = await downloadEnvironment(env);
      try {
        await execute('gh', ['run', 'download', String(runId), '--repo', repository, '--name', artifacts[0].name, '--dir', staging],
          { env: downloadEnv, timeout: 15 * 60_000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        if (error.killed) throw new Error('Windows artifact download exceeded 15 minutes; check the configured network route, then resume the same release and run. No rebuild or publication was started.');
        throw new Error('Windows artifact download failed; check the configured network route, then resume the same release and run. Partial download was discarded; no rebuild or publication was started.');
      }
      await verifyWindowsArtifacts(staging, { sourceSha, version: expectedVersion });
      await writeFile(join(staging, 'github-build.json'), json({ runId: Number(runId), runAttempt: run.run_attempt, sourceSha, workflowSha: run.head_sha, artifactId: artifacts[0].id, artifactName: artifacts[0].name, artifactDigest: artifacts[0].digest, url: run.html_url }), { flag: 'wx' });
      if (entries) await rmdir(out); // Only an empty dedicated destination can be removed.
      await rename(staging, out);
    } finally { await rm(staging, { recursive: true, force: true }); }
  } else {
    const saved = JSON.parse(await readFile(provenancePath, 'utf8'));
    if (saved.runId !== Number(runId) || saved.sourceSha !== sourceSha || (saved.workflowSha && saved.workflowSha !== run.head_sha) || saved.artifactId !== artifacts[0].id || saved.artifactDigest !== artifacts[0].digest) throw new Error('Output directory belongs to a different build; use a fresh directory');
  }
  const inventory = await verifyWindowsArtifacts(out, { sourceSha, version: expectedVersion });
  if (run.display_title?.startsWith('windows-release ') && inventory.version !== run.display_title.split(' ')[1]) throw new Error('Pinned run version does not match artifact inventory');
  if (artifacts[0].name !== `windows-unsigned-${inventory.version}-${sourceSha.slice(0, 12)}`) throw new Error('Artifact version does not match inventory');
  return inventory;
}

function call(client, method, params) {
  return new Promise((resolvePromise, reject) => {
    try { client[method](params, (error, data) => error ? reject(Object.assign(new Error(`COS ${method} failed (HTTP ${Number(error.statusCode) || 'unknown'})`), { status: error.statusCode })) : resolvePromise(data)); }
    catch { reject(new Error(`COS ${method} failed; inspect account privately`)); }
  });
}

export async function verifyWindowsPublic(objects, { fetchImpl = fetch } = {}) {
  const results = [];
  for (const object of objects) {
    const response = await fetchImpl(object.url, { redirect: 'error', signal: AbortSignal.timeout(300000) });
    if (response.status !== 200 || response.redirected || !response.body) throw new Error(`Public download failed: ${object.file} (HTTP ${response.status})`);
    if (response.headers.get('content-type')?.split(';')[0] !== object.contentType) throw new Error(`Wrong Content-Type: ${object.file}`);
    if (Number(response.headers.get('content-length')) !== object.bytes) throw new Error(`Public size mismatch: ${object.file}`);
    cachePolicy(response.headers, 'versioned');
    let bytes = 0;
    const digest = createHash('sha256');
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > object.bytes) throw new Error(`Public download is larger than inventory: ${object.file}`);
      digest.update(chunk);
    }
    if (bytes !== object.bytes || digest.digest('hex') !== object.sha256) throw new Error(`Public SHA-256 mismatch: ${object.file}`);
    results.push({ file: object.file, url: object.url, bytes, sha256: object.sha256 });
  }
  return results;
}

async function assertNotCancelled(cancelFile) {
  if (cancelFile === undefined) return;
  if (!isAbsolute(cancelFile)) throw new Error('Use an absolute --cancel-file path');
  try { await access(cancelFile); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Windows publication stopped by CANCEL before writing the next object.');
}

export async function publishWindowsObjects({ out, inventory, config, client, fetchImpl = fetch, log = console.log, cancelFile }) {
  fetchImpl = withReleaseCdnVerification(fetchImpl, config.cdn);
  await assertNotCancelled(cancelFile);
  const lockPath = join(out, '.windows-publish.lock');
  const lock = await open(lockPath, 'wx');
  try {
    const target = { Bucket: config.bucket, Region: config.region };
    const versioning = await call(client, 'getBucketVersioning', target);
    const configuration = versioning?.VersioningConfiguration;
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || !['', undefined].includes(configuration.Status)) throw new Error('Bucket versioning must never have been enabled for atomic overwrite protection');
    const objects = windowsObjectPlan(inventory);
    for (const object of objects) {
      await assertNotCancelled(cancelFile);
      // Rehash immediately before writing; mutable local files cannot bypass the verified inventory.
      const body = await readFile(join(out, object.file));
      if (body.length !== object.bytes || hash(body) !== object.sha256) throw new Error(`Local file changed: ${object.file}`);
      let exists = false;
      try { await call(client, 'headObject', { ...target, Key: object.key }); exists = true; }
      catch (error) { if (error.status !== 404) throw error; }
      if (exists) {
        await verifyWindowsPublic([object], { fetchImpl });
        log(`Reusing identical public object: ${object.file}`);
        continue;
      }
      log(`Uploading ${object.file} (${object.bytes} bytes)`);
      await assertNotCancelled(cancelFile);
      await call(client, 'putObject', { ...target, Key: object.key, Body: body, ContentLength: body.length,
        ContentMD5: hash(body, 'md5', 'base64'), ContentType: object.contentType, CacheControl: immutable,
        Headers: { 'x-cos-forbid-overwrite': 'true' } });
    }
    await assertNotCancelled(cancelFile);
    const verified = await verifyWindowsPublic(objects, { fetchImpl });
    const receipt = { version: inventory.version, sourceSha: inventory.sourceSha, architecture: inventory.architecture, signed: false,
      updatesEnabled: inventory.updatesEnabled, cdn: releaseCdnDescription(config.cdn), verifiedAt: new Date().toISOString(), objects: verified };
    await assertNotCancelled(cancelFile);
    await writeFile(join(out, 'windows-publish-receipt.json'), json(receipt));
    return receipt;
  } finally { await lock.close(); await unlink(lockPath); }
}

/** Prepare exact signed bytes locally; stable URLs are part of the owner-reviewed plan. */
export async function planWindowsUpdates({ out, inventory, env = process.env, privateKeyFile, notes, previous, fetchImpl = fetch, cdn }) {
  fetchImpl = withReleaseCdnVerification(fetchImpl, cdn);
  validateWindowsInventory(inventory);
  if (!inventory.updatesEnabled) return [];
  const feeds = [];
  for (const architecture of ['x64', 'arm64']) {
    const installer = windowsObjectPlan(inventory).find(item => item.file === `Vonvon-Bot-Setup-${inventory.version}-${architecture}.exe`);
    if (!installer) throw new Error('Both native Windows installers are required for update publication');
    const file = `update-${architecture}.json`, path = join(out, file);
    let body;
    try { body = await readFile(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const privatePath = env.VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE ?? privateKeyFile;
      if (!isAbsolute(privatePath ?? '')) throw new Error('Configure an external VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE before planning Windows updates');
      const privateKey = await readFile(privatePath, 'utf8');
      if (publicKeyFromPrivate(privateKey) !== normalizeWindowsPublicKey(inventory.publicKey)) throw new Error('Windows signing key does not match the key embedded in this candidate');
      body = Buffer.from(json(signWindowsUpdate({ schemaVersion: 1, product: 'vonvon-bot', version: inventory.version, architecture,
        url: installer.url, size: installer.bytes, sha512: installer.sha512, ...(notes ? { notes } : {}) }, privateKey)));
      await writeFile(path, body, { flag: 'wx' });
    }
    const payload = verifyWindowsUpdate(JSON.parse(body), inventory.publicKey, architecture);
    if (payload.version !== inventory.version || payload.url !== installer.url || payload.size !== installer.bytes || payload.sha512 !== installer.sha512 || payload.notes !== (notes || undefined)) throw new Error('Signed Windows update differs from this candidate');
    const url = `${baseURL}stable/${architecture}/update.json`;
    const saved = previous?.find(item => item.architecture === architecture);
    const snapshot = saved?.previous ?? await windowsFeedSnapshot(url, fetchImpl);
    if (snapshot.status === 200) verifyWindowsUpdate(JSON.parse(Buffer.from(snapshot.body, 'base64')), inventory.publicKey, architecture);
    if (snapshot.status === 200 && snapshot.version && compareVersion(snapshot.version, inventory.version) >= 0 && snapshot.sha256 !== hash(body)) throw new Error('Windows stable would not advance; review its existing version');
    feeds.push({ architecture, file, key: `bot/windows/stable/${architecture}/update.json`, url, bytes: body.length, sha256: hash(body), previous: snapshot });
  }
  return feeds;
}
const compareVersion = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
async function windowsFeedSnapshot(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return { status: 404 };
  if (response.status !== 200 || response.redirected) throw new Error('Cannot read the existing Windows update feed');
  if (!response.body) throw new Error('Windows update feed has no body');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 32768) throw new Error('Windows update feed is too large'); chunks.push(Buffer.from(chunk)); }
  const body = Buffer.concat(chunks);
  let version;
  try { version = JSON.parse(Buffer.from(JSON.parse(body).payload, 'base64')).version; } catch { /* Preserve unknown old bytes as the snapshot. */ }
  return { status: 200, bytes: body.length, sha256: hash(body), body: body.toString('base64'), ...typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? { version } : {} };
}
/** Called only by the unified reviewed promote stage, after public installer verification. */
export async function promoteWindowsUpdates({ out, inventory, feeds, config, env = process.env, ownerConfirmation, planSHA256, notes, client, fetchImpl = fetch, cancelFile }) {
  fetchImpl = withReleaseCdnVerification(fetchImpl, config.cdn);
  if (!inventory.updatesEnabled) return;
  const expected = await planWindowsUpdates({ out, inventory, env, privateKeyFile: config.updatePrivateKeyFile, notes, previous: feeds, fetchImpl });
  if (json(expected) !== json(feeds) || !/^[a-f0-9]{64}$/.test(planSHA256 ?? '')) throw new Error('Windows update plan changed since owner review');
  await verifyWindowsPublic(windowsObjectPlan(inventory), { fetchImpl });
  const receipt = { version: inventory.version, sourceSha: inventory.sourceSha, updatesEnabled: true, planSHA256, cdn: releaseCdnDescription(config.cdn), feeds: [], ownerConfirmation };
  for (const feed of feeds) {
    await assertNotCancelled(cancelFile);
    const body = await readFile(join(out, feed.file));
    if (body.length !== feed.bytes || hash(body) !== feed.sha256) throw new Error('Local Windows update feed changed after review');
    const live = await windowsFeedSnapshot(feed.url, fetchImpl);
    if (live.status !== 200 || live.sha256 !== feed.sha256 || live.bytes !== feed.bytes) {
      if (!ownerConfirmation?.trim()) throw new Error('Windows stable requires the owner confirmation for this reviewed candidate');
      if (json(live) !== json(feed.previous)) throw new Error('Windows stable changed since review; nothing was overwritten');
      if (!client) {
        for (const name of cosCredentialEnvNames(config)) if (!env[name]) throw new Error('Windows publication credentials are unavailable');
        const COS = await loadPinnedSdk(config.sdkModule);
        client = new COS({ SecretId: env[config.secretIdEnv], SecretKey: env[config.secretKeyEnv], ...(config.securityTokenEnv ? { SecurityToken: env[config.securityTokenEnv] } : {}), Protocol: 'https:', Timeout: 300000 });
      }
      // The public byte snapshot is read immediately before each replacement, as for Mac stable.
      await assertNotCancelled(cancelFile);
      if (json(await windowsFeedSnapshot(feed.url, fetchImpl)) !== json(feed.previous)) throw new Error('Windows stable changed immediately before publication');
      await writeFile(join(out, 'windows-update-publish-receipt.json'), json({ ...receipt, status: 'feed-write-started' }));
      await call(client, 'putObject', { Bucket: config.bucket, Region: config.region, Key: feed.key, Body: body, ContentLength: body.length,
        ContentMD5: hash(body, 'md5', 'base64'), ContentType: 'application/json', CacheControl: 'no-cache',
        ...(feed.previous.status === 404 ? { Headers: { 'x-cos-forbid-overwrite': 'true' } } : {}) });
    }
    const verified = await windowsFeedSnapshot(feed.url, async (...args) => { const response = await fetchImpl(...args); if (response.status === 200) {
      if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('Windows update feed Content-Type mismatch');
      cachePolicy(response.headers, 'manifest');
    } return response; });
    if (verified.status !== 200 || verified.sha256 !== feed.sha256 || verified.bytes !== feed.bytes) throw new Error('Windows feed public verification failed; resume the same reviewed plan');
    receipt.feeds.push({ architecture: feed.architecture, url: feed.url, bytes: feed.bytes, sha256: feed.sha256 });
  }
  await assertNotCancelled(cancelFile);
  await writeFile(join(out, 'windows-update-publish-receipt.json'), json({ ...receipt, status: 'published' }));
  return receipt;
}

async function main() {
  const { values } = parseArgs({ options: {
    'run-id': { type: 'string' }, out: { type: 'string' }, 'cos-config': { type: 'string' }, sha: { type: 'string' }, version: { type: 'string' },
    'download-only': { type: 'boolean' }, 'cancel-file': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node scripts/publish-windows.mjs --run-id ID --out /absolute/evidence --cos-config /absolute/windows-cos.json [--download-only] [--cancel-file /absolute/CANCEL]\nDownloads a successful trusted Windows Actions artifact, verifies it, uploads versioned unsigned downloads and fully verifies public bytes. Never writes stable/latest.yml or changes the website.');
    return;
  }
  assertSecureTransport();
  if (!isAbsolute(values.out ?? '')) throw new Error('Supply an absolute dedicated --out directory');
  await assertNotCancelled(values['cancel-file']);
  const out = resolve(values.out);
  const config = values['download-only'] ? undefined : await readWindowsCosConfig(values['cos-config']);
  const privateNames = config ? cosCredentialEnvNames(config) : [];
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !privateNames.includes(name)));
  const inventory = await downloadBuild({ runId: values['run-id'], out, env: childEnv, expectedSha: values.sha, expectedVersion: values.version });
  if (values['download-only']) { console.log(json(inventory)); return; }
  for (const name of privateNames) if (!process.env[name]) throw new Error(`Missing credential environment variable: ${name}`);
  const COS = await loadPinnedSdk(config.sdkModule);
  const client = new COS({ SecretId: process.env[config.secretIdEnv], SecretKey: process.env[config.secretKeyEnv],
    ...(config.securityTokenEnv ? { SecurityToken: process.env[config.securityTokenEnv] } : {}), Protocol: 'https:', Timeout: 300000 });
  console.log(json(await publishWindowsObjects({ out, inventory, config, client, cancelFile: values['cancel-file'] })));
}

const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath && invokedPath === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
