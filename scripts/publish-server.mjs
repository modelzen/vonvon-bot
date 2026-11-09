// The standalone server's part of a release (docs/plans/server-5-release.md 4.1, 4.3). release-publish.mjs drives it:
// plan → upload (versioned objects under bot/server/<version>/, never overwritten, then checked on the public address)
// → promote (install.sh, uninstall.sh and last the signed stable/manifest.json, only with the owner's confirmation of
// the reviewed plan, at the same gate as macOS and Windows stable). Nothing here touches the Mac or Windows objects.
import { createHash, randomUUID } from 'node:crypto';
import { access, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertCredentialEnvNames, cosCredentialEnvNames, loadPinnedSdk } from './release-cos-evidence.mjs';
import { cachePolicy } from './verify-public-release.mjs';
import { readReleaseCdnPolicy, releaseCdnDescription, withReleaseCdnVerification } from './release-cdn.mjs';
import { PUBLISHED_TARGETS, SERVER_BASE_URL, SERVER_PREFIX, SERVER_SCRIPTS, archiveName } from './server-constants.mjs';
import { compareVersions, installScriptBaseURL, installScriptKey, publicKeyForms, publicKeyFromPrivate, signServerManifest, unsignedManifest, verifyServerManifest } from './server-manifest.mjs';

const immutable = 'public, max-age=31536000, immutable';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const buildReport = version => `vonvon-server-${version}-build.json`;
/** Local names in release-all's <out>/server/ for what promote writes; the COS keys are in the plan. */
export const SIGNED_MANIFEST = 'stable-manifest.json';
export const UPLOAD_RECEIPT = 'server-publish-receipt.json';
export const STABLE_RECEIPT = 'server-stable-receipt.json';

async function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
async function optionalBytes(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
/** Writes `bytes` once; a later plan finds them and must find the same. */
async function keep(path, bytes, what) {
  const existing = await optionalBytes(path);
  if (!existing) { await writeFile(path, bytes, { flag: 'wx' }); return; }
  if (!existing.equals(bytes)) throw new Error(`${what}和这次计划的不一样（${path}）：候选变了，停下查清楚`);
}

/** cos-server.json, an external file like cos-windows.json: the target, credential variable names and the signing key's path. */
export async function readServerCosConfig(path) {
  if (!isAbsolute(path ?? '')) throw new Error('服务端的 COS 配置要用外部文件的绝对路径（--server-cos-config）');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('读不了服务端的 COS 配置'); }
  const fields = ['bucket', 'region', 'prefix', 'publicBaseURL', 'secretIdEnv', 'secretKeyEnv', 'securityTokenEnv', 'sdkModule', 'updatePrivateKeyFile', 'cdn'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !fields.includes(key))
      || !/^[a-z0-9-]+-\d+$/.test(config.bucket ?? '') || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(config.region ?? '')
      || config.prefix !== SERVER_PREFIX || config.publicBaseURL !== SERVER_BASE_URL || !config.secretIdEnv || !config.secretKeyEnv) {
    throw new Error(`服务端的 COS 配置只能写 ${SERVER_PREFIX} 和 ${SERVER_BASE_URL}，凭据只写环境变量名`);
  }
  assertCredentialEnvNames(config);
  readReleaseCdnPolicy(config.cdn);
  // Only this path, no environment variable: one way in for the key (4.2).
  if (!isAbsolute(config.updatePrivateKeyFile ?? '')) throw new Error('updatePrivateKeyFile 要写服务端签名私钥文件的绝对路径');
  let info;
  try { info = await stat(config.updatePrivateKeyFile); } catch { throw new Error('服务端签名私钥文件不在 updatePrivateKeyFile 写的位置'); }
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('服务端签名私钥文件只能本人读写（0600）');
  return config;
}

function readSummary(summary, { version, sha }) {
  if (summary.updateKey === 'test') throw new Error('测试钥匙构建不能发布：这批服务端包是用 --update-public-key 或 --update-base-url 打的');
  if (summary.updateKey !== 'release') throw new Error('这批服务端包构建时仓库里还没有发布公钥（updateKey 不是 release），不能发布');
  if (summary.version !== version) throw new Error(`服务端包的版本 ${summary.version} 不是这次发布的 ${version}`);
  if (summary.sourceHead !== sha || summary.sourceDirty !== false) throw new Error('服务端包不是从这次发布的源码 SHA 干净构建的');
  const targets = Object.keys(summary.files ?? {});
  if (targets.length !== PUBLISHED_TARGETS.length || PUBLISHED_TARGETS.some(target => !targets.includes(target))) throw new Error(`服务端只发 ${PUBLISHED_TARGETS.join('、')} 两个 Linux 包，构建记录里是 ${targets.join('、') || '空的'}`);
}

/** The live object at `url`: 404, or its bytes (at most `limit`). Never follows a redirect. */
async function publicSnapshot(url, fetchImpl, limit) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return { status: 404 }; }
  if (response.status !== 200 || response.redirected || !response.body) throw new Error(`读不到线上的 ${url}（HTTP ${response.status}）`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error(`线上的 ${url} 太大`);
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return { status: 200, bytes: body.length, sha256: hash(body), body };
}
/** The live signed stable manifest, with its version and time when it verifies with `publicKey`. */
export async function stableSnapshot(fetchImpl, publicKey) {
  const live = await publicSnapshot(`${SERVER_BASE_URL}/stable/manifest.json`, fetchImpl, 64 * 1024);
  if (live.status === 404) return live;
  const { body, ...snapshot } = live;
  try {
    const payload = verifyServerManifest(body, publicKey);
    return { ...snapshot, version: payload.version, publishedAt: payload.publishedAt };
  } catch { return { ...snapshot, verified: false }; }
}

/**
 * Everything a release puts under bot/server/ for `version`, from release-all's `<out>/server` (`dir`). The build must be a
 * release-key build of exactly the release SHA; the private key, the committed server-update.json, the packages' key
 * and install.sh's key must be one key. The signed manifest is made once and kept in `dir` (its publishedAt is the time
 * of the first plan), so plan, upload and promote all see the same bytes. `readSource(path)` gives a file's bytes at
 * the release SHA; the scripts published are those, not the working copy's. `previous` is the saved plan's server part:
 * the live stable seen when the owner reviewed it is kept, not read again.
 */
export async function planServerPublication({ dir, version, sha, config, readSource, previous, notes, fetchImpl = fetch, now = Date.now }) {
  fetchImpl = withReleaseCdnVerification(fetchImpl, config.cdn);
  let summary;
  try { summary = JSON.parse(await readFile(join(dir, buildReport(version)), 'utf8')); }
  catch { throw new Error(`没有 ${buildReport(version)}：先用 release-all build 打服务端包`); }
  readSummary(summary, { version, sha });
  const privateKey = await readFile(config.updatePrivateKeyFile, 'utf8');
  const key = publicKeyFromPrivate(privateKey);
  const committed = JSON.parse(await readSource('packages/daemon/server-update.json'));
  const scripts = Object.fromEntries(await Promise.all(SERVER_SCRIPTS.map(async name => [name, await readSource(`scripts/${name}`)])));
  const install = scripts['install.sh'].toString('utf8');
  const scriptKey = installScriptKey(install);
  if (committed.publicKey !== key.base64 || summary.update?.publicKey !== key.base64 || !scriptKey || publicKeyForms(scriptKey).base64 !== key.base64) {
    throw new Error('签名私钥、packages/daemon/server-update.json、服务端包里的公钥和 install.sh 里的公钥不是同一把，不能发布');
  }
  if (committed.baseURL !== SERVER_BASE_URL || summary.update?.baseURL !== SERVER_BASE_URL || installScriptBaseURL(install) !== SERVER_BASE_URL) {
    throw new Error(`服务端包、server-update.json 或 install.sh 的下载地址不是 ${SERVER_BASE_URL}，不能发布`);
  }

  const mirrors = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 2 || new Set(value).size !== value.length) throw new Error('Invalid server mirrorBaseURLs');
    for (const address of value) {
      let url; try { url = new URL(address); } catch { throw new Error('Invalid server mirrorBaseURLs'); }
      if (url.protocol !== 'https:' || url.origin === new URL(SERVER_BASE_URL).origin || url.username || url.password || url.port || url.pathname !== '/bot/server' || url.search || url.hash || url.href !== address) throw new Error('Invalid server mirrorBaseURLs');
    }
    return value;
  };
  const mirrorBaseURLs = mirrors(committed.mirrorBaseURLs);
  if (JSON.stringify(mirrorBaseURLs) !== JSON.stringify(mirrors(summary.update?.mirrorBaseURLs))) throw new Error('服务端包的 mirrorBaseURLs 和发布源码 SHA 不一致，不能省略已启用的镜像');

  const packages = [];
  for (const target of PUBLISHED_TARGETS) {
    const entry = summary.files[target], file = archiveName(version, target);
    const bytes = entry?.name === file ? await readFile(join(dir, file)) : undefined;
    if (!bytes || bytes.length !== entry.size || hash(bytes, 'sha512') !== entry.sha512 || hash(bytes) !== entry.sha256) throw new Error(`${file} 和构建记录对不上：构建之后被改过，或者不是这次构建的`);
    packages.push({ target, file, bytes: bytes.length, sha256: entry.sha256, sha512: entry.sha512 });
  }
  const files = Object.fromEntries(packages.map(item => [item.target, { url: `${SERVER_BASE_URL}/${version}/${item.file}`, sha512: item.sha512, size: item.bytes }]));

  let envelope = await optionalBytes(join(dir, SIGNED_MANIFEST)), payload;
  if (envelope) payload = verifyServerManifest(envelope, key.base64);
  else {
    payload = { schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version, publishedAt: now(), files, ...(notes ? { notes } : {}) };
    envelope = signServerManifest(payload, privateKey);
    await writeFile(join(dir, SIGNED_MANIFEST), envelope, { flag: 'wx' });
  }
  if (payload.version !== version || JSON.stringify(payload.files) !== JSON.stringify(files) || payload.notes !== (notes || undefined)) {
    throw new Error(`已经签过的 ${SIGNED_MANIFEST} 和这次的包或说明不一样：候选变了，停下查清楚`);
  }
  await keep(join(dir, 'manifest.json'), unsignedManifest(payload), '未签名的 manifest.json');
  for (const name of SERVER_SCRIPTS) await keep(join(dir, name), scripts[name], name);

  const live = previous?.previousManifest ?? await stableSnapshot(fetchImpl, key.base64);
  if (live.status === 200 && live.sha256 !== hash(envelope)) {
    if (live.verified === false) throw new Error('线上的服务端 stable 清单用这把公钥验不过：先查清楚是谁写的');
    if (compareVersions(live.version, version) > 0) throw new Error(`服务端 stable 已经是更新的版本 ${live.version}，不能换回 ${version}`);
    if (live.version === version) throw new Error(`服务端 stable 已经是 ${version} 的另一份清单：先查清楚`);
    if (live.publishedAt >= payload.publishedAt) throw new Error('线上服务端 stable 清单的发布时间不比这次早，不能切');
  }

  const object = (file, key, contentType, bytes, extra = {}) => ({ file, key, url: `${SERVER_BASE_URL}/${key.slice(SERVER_PREFIX.length)}`, contentType, bytes: bytes.length, sha256: hash(bytes), ...extra });
  const report = await readFile(join(dir, buildReport(version)));
  const unsigned = await readFile(join(dir, 'manifest.json'));
  return {
    version, sourceSha: sha, publicKey: key.base64, publishedAt: payload.publishedAt,
    ...(mirrorBaseURLs.length ? { mirrorBaseURLs } : {}),
    ...(config.cdn ? { cdn: releaseCdnDescription(config.cdn) } : {}),
    versioned: [
      ...packages.map(item => ({ file: item.file, key: `${SERVER_PREFIX}${version}/${item.file}`, url: files[item.target].url, contentType: 'application/gzip', bytes: item.bytes, sha256: item.sha256, sha512: item.sha512 })),
      object(buildReport(version), `${SERVER_PREFIX}${version}/${buildReport(version)}`, 'application/json', report, { sha512: hash(report, 'sha512') }),
      object('manifest.json', `${SERVER_PREFIX}${version}/manifest.json`, 'application/json', unsigned, { sha512: hash(unsigned, 'sha512') }),
    ],
    // In this order: the scripts carry the key and address the manifest is checked with, so the manifest goes last.
    stable: [
      ...SERVER_SCRIPTS.map(name => object(name, `${SERVER_PREFIX}${name}`, 'text/plain; charset=utf-8', scripts[name])),
      object(SIGNED_MANIFEST, `${SERVER_PREFIX}stable/manifest.json`, 'application/json', envelope),
    ],
    previousManifest: live,
  };
}

function call(client, method, params) {
  return new Promise((resolvePromise, reject) => {
    // SDK errors can carry signed request details: keep only the HTTP status.
    try { client[method](params, (error, data) => error ? reject(Object.assign(new Error(`COS ${method} 失败（HTTP ${Number(error.statusCode) || '未知'}）`), { status: error.statusCode })) : resolvePromise(data)); }
    catch { reject(new Error(`COS ${method} 失败；私下查看账号`)); }
  });
}
async function assertNotCancelled(cancelFile) {
  if (cancelFile === undefined) return;
  if (!isAbsolute(cancelFile)) throw new Error('--cancel-file 要用绝对路径');
  try { await access(cancelFile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('有 CANCEL：服务端在写下一个对象之前停下了');
}
export async function serverCosClient(config, env) {
  for (const name of cosCredentialEnvNames(config)) if (!env[name]) throw new Error('服务端 COS 写入凭据不在这个进程的环境变量里');
  const COS = await loadPinnedSdk(config.sdkModule);
  return new COS({ SecretId: env[config.secretIdEnv], SecretKey: env[config.secretKeyEnv], ...(config.securityTokenEnv ? { SecurityToken: env[config.securityTokenEnv] } : {}),
    Protocol: 'https:', StrictSsl: true, FollowRedirect: false, KeepAlive: false, Timeout: 30 * 60_000 });
}

/**
 * Downloads each object from its public address and checks status, type, length, cache headers and every byte.
 * `kind` 'versioned' wants the long immutable cache, 'stable' no-cache. Small objects come back with their body.
 */
export async function verifyServerPublic(objects, { fetchImpl = fetch, kind = 'versioned' } = {}) {
  const results = [];
  for (const object of objects) {
    const response = await fetchImpl(object.url, { redirect: 'error', headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(300_000) });
    if (response.status !== 200 || response.redirected || !response.body) throw new Error(`公网下载失败：${object.url}（HTTP ${response.status}）`);
    // Fetch decodes compressed bodies but leaves their wire Content-Length: verify only identity bytes.
    const encoding = response.headers.get('content-encoding');
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') { await response.body.cancel(); throw new Error(`公网的 Content-Encoding 不对：${object.url}`); }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== object.contentType.split(';')[0]) throw new Error(`公网的 Content-Type 不对：${object.url}`);
    if (Number(response.headers.get('content-length')) !== object.bytes) throw new Error(`公网内容不一致（大小）：${object.url}`);
    cachePolicy(response.headers, kind === 'stable' ? 'manifest' : 'versioned');
    const sha256 = createHash('sha256'), sha512 = createHash('sha512'), small = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > object.bytes) throw new Error(`公网内容不一致（比计划大）：${object.url}`);
      sha256.update(chunk); sha512.update(chunk);
      if (object.bytes <= 64 * 1024) small.push(Buffer.from(chunk));
    }
    const digest = sha256.digest('hex'), digest512 = sha512.digest('hex');
    if (bytes !== object.bytes || digest !== object.sha256 || (object.sha512 && digest512 !== object.sha512)) throw new Error(`公网内容不一致：${object.url}`);
    results.push({ file: object.file, url: object.url, bytes, sha256: digest, ...(object.sha512 ? { sha512: digest512 } : {}), ...(small.length ? { body: Buffer.concat(small) } : {}) });
  }
  return results;
}
const withoutBody = items => items.map(({ body: _body, ...rest }) => rest);

/**
 * Uploads the versioned objects of a reviewed plan with x-cos-forbid-overwrite. An object already there is kept only when
 * its public bytes are the planned ones. Checks CANCEL before each write; writes the receipt once every object is
 * verified on the public address.
 */
export async function publishServerObjects({ dir, plan, config, client, env = process.env, fetchImpl = fetch, log = console.log, cancelFile }) {
  fetchImpl = withReleaseCdnVerification(fetchImpl, config.cdn);
  await assertNotCancelled(cancelFile);
  const lockPath = join(dir, '.server-publish.lock');
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error('服务端上传的锁还在：先查记录的进程是否已经结束'); });
  try {
    client ??= await serverCosClient(config, env);
    const target = { Bucket: config.bucket, Region: config.region };
    const configuration = (await call(client, 'getBucketVersioning', target))?.VersioningConfiguration;
    // With versioning on, COS ignores x-cos-forbid-overwrite (as for Mac and Windows).
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || !['', undefined].includes(configuration.Status)) throw new Error('bucket 不能开过版本控制：开了以后禁止覆盖不生效');
    for (const object of plan.versioned) {
      await assertNotCancelled(cancelFile);
      // Hashed again right before writing: a file changed since the plan cannot slip through.
      const body = await readFile(join(dir, object.file));
      if (body.length !== object.bytes || hash(body) !== object.sha256 || hash(body, 'sha512') !== object.sha512) throw new Error(`本地的 ${object.file} 在计划之后被改过`);
      let exists = false;
      try { await call(client, 'headObject', { ...target, Key: object.key }); exists = true; }
      catch (error) { if (error.status !== 404) throw error; }
      if (!exists) {
        await assertNotCancelled(cancelFile);
        log(`上传 ${object.key}（${object.bytes} 字节）`);
        try {
          await call(client, 'putObject', { ...target, Key: object.key, Body: body, ContentLength: body.length, ContentMD5: createHash('md5').update(body).digest('base64'),
            ContentType: object.contentType, CacheControl: immutable, Headers: { 'x-cos-forbid-overwrite': 'true' } });
        } catch (error) { if (error.status !== 409) throw error; exists = true; }
      }
      if (exists) {
        await verifyServerPublic([object], { fetchImpl });
        log(`公网上已经有一样的 ${object.key}，不再上传`);
      }
    }
    await assertNotCancelled(cancelFile);
    const objects = withoutBody(await verifyServerPublic(plan.versioned, { fetchImpl }));
    const receipt = { version: plan.version, sourceSha: plan.sourceSha, cdn: releaseCdnDescription(config.cdn), verifiedAt: new Date().toISOString(), objects };
    await atomic(join(dir, UPLOAD_RECEIPT), receipt);
    return receipt;
  } finally { await lock.close(); await unlink(lockPath); }
}

/** The live stable manifest is still the snapshot the owner reviewed in the plan, or (`candidateSHA256`) already this one. */
async function liveManifestAsReviewed(plan, fetchImpl, candidateSHA256) {
  const live = await stableSnapshot(fetchImpl, plan.publicKey);
  return JSON.stringify(live) === JSON.stringify(plan.previousManifest) || (candidateSHA256 !== undefined && live.status === 200 && live.sha256 === candidateSHA256);
}

/**
 * Switches the server's stable: install.sh, uninstall.sh, then stable/manifest.json, each only when its live bytes differ
 * from the plan. Called only from release-publish promote, with the reviewed plan (its hash checked there) and the
 * owner's confirmation; without the confirmation nothing is written. Before the first write the live manifest must still
 * be the one in the plan (or already this candidate's, on a rerun), so a stable that moved on gets none of the three; it
 * is read again right before the manifest replaces it. An already switched stable is only checked again.
 */
export async function promoteServerStable({ dir, plan, config, client, env = process.env, ownerConfirmation, planSHA256, cancelFile, readSource, fetchImpl = fetch, log = console.log }) {
  fetchImpl = withReleaseCdnVerification(fetchImpl, config.cdn);
  if (!/^[a-f0-9]{64}$/.test(planSHA256 ?? '')) throw new Error('切服务端 stable 要带 owner 看过的计划哈希');
  await verifyServerPublic(plan.versioned, { fetchImpl });
  const bodies = {};
  for (const object of plan.stable) {
    const body = await readFile(join(dir, object.file));
    if (body.length !== object.bytes || hash(body) !== object.sha256) throw new Error(`本地的 ${object.file} 在计划之后被改过`);
    bodies[object.file] = body;
  }
  for (const name of SERVER_SCRIPTS) if (!(await readSource(`scripts/${name}`)).equals(bodies[name])) throw new Error(`${name} 和发布源码 SHA 里的不一样`);
  verifyServerManifest(bodies[SIGNED_MANIFEST], plan.publicKey);

  const pending = [];
  for (const object of plan.stable) {
    const live = await publicSnapshot(object.url, fetchImpl, 1024 * 1024);
    if (live.status !== 200 || live.sha256 !== object.sha256) pending.push(object);
  }
  const receipt = { version: plan.version, sourceSha: plan.sourceSha, planSHA256, cdn: releaseCdnDescription(config.cdn), ownerConfirmation: ownerConfirmation ?? null };
  if (pending.length) {
    if (!ownerConfirmation?.trim()) throw new Error('切服务端 stable 要 owner 对这份候选的确认（--owner-confirmation）；什么都没写');
    // The scripts carry the key and address of the manifest they come with: none is written over a stable that moved on.
    const candidate = plan.stable.find(object => object.file === SIGNED_MANIFEST).sha256;
    if (!(await liveManifestAsReviewed(plan, fetchImpl, candidate))) throw new Error('线上的服务端 stable 清单在 owner 看过计划之后变了；服务端 stable 一个对象都没写');
    for (const object of pending) {
      await assertNotCancelled(cancelFile);
      const manifest = object.file === SIGNED_MANIFEST;
      // Read again right before replacing it, as for Mac and Windows stable.
      if (manifest && !(await liveManifestAsReviewed(plan, fetchImpl))) throw new Error('线上的服务端 stable 清单在 owner 看过计划之后变了；清单没覆盖');
      await atomic(join(dir, STABLE_RECEIPT), { ...receipt, status: 'write-started' });
      client ??= await serverCosClient(config, env);
      const body = bodies[object.file];
      await call(client, 'putObject', { Bucket: config.bucket, Region: config.region, Key: object.key, Body: body, ContentLength: body.length,
        ContentMD5: createHash('md5').update(body).digest('base64'), ContentType: object.contentType, CacheControl: 'no-cache',
        ...(manifest && plan.previousManifest.status === 404 ? { Headers: { 'x-cos-forbid-overwrite': 'true' } } : {}) });
      log(`已写 ${object.key}`);
    }
  }
  const verified = await verifyServerPublic(plan.stable, { fetchImpl, kind: 'stable' });
  verifyServerManifest(verified.find(item => item.file === SIGNED_MANIFEST).body, plan.publicKey);
  const published = { ...receipt, status: 'published', verifiedAt: new Date().toISOString(), objects: withoutBody(verified) };
  await atomic(join(dir, STABLE_RECEIPT), published);
  return published;
}
