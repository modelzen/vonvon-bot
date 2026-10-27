import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { checkVersionGate, compareVersions, validateFirstRelease } from './release-mac.mjs';
import { assertCredentialEnvNames, COS_SDK_VERSION, cosCredentialEnvNames, isStableCosTarget, loadPinnedSdk, readCosConfig, readCosReleaseEvidence } from './release-cos-evidence.mjs';
import { assertSecureTransport, DEFAULT_MANIFEST_URL, readStableManifest, validateManifest, validateReleaseInventory } from './verify-public-release.mjs';

// The only COS writer for releases. plan writes nothing to COS; upload writes the three versioned
// objects named in an owner-reviewed plan; fix-headers replaces versioned-object metadata. Nothing here
// writes bot/mac/stable/manifest.json yet: promote, reverify and rollback come in the next PR.
const manifestURL = DEFAULT_MANIFEST_URL;
const immutableCache = 'public, max-age=31536000, immutable';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const NO_CDN = '未启用 CDN，未刷新';
const names = { plan: 'publish-plan.json', uploadState: 'publish-upload-state.json', uploadReceipt: 'upload-receipt.json', fixReceipt: 'fix-headers-receipt.json', lock: '.publish.lock' };
const scriptPath = fileURLToPath(import.meta.url);
const verifyScript = join(dirname(scriptPath), 'verify-public-release.mjs');
const exec = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('base64');
const json = value => JSON.stringify(value, null, 2) + '\n';
const redact = text => String(text).replace(/\/Users\/[^/\s"']+/g, '/Users/<u>');
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function readJSONFile(path, label) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { throw new Error(error.code === 'ENOENT' ? `${label} is missing` : `Cannot read ${label}; inspect it privately`); }
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); }
}
async function writeAtomic(path, text) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, text, { flag: 'wx' });
  await rename(temporary, path);
}

const common = ['out', 'version', 'sha', 'cos-config', 'cos-write-config'];
const commandOptions = {
  plan: [...common, 'first-release', 'no-live-manifest'],
  upload: [...common, 'first-release', 'no-live-manifest', 'plan-sha256', 'cancel-file'],
  'fix-headers': [...common, 'plan-sha256', 'cancel-file'],
};
// The COS keys each command really uses. A command never waits on a key it does not use, so a
// header fix is not blocked by a missing read-only key.
const keysUsed = command => ({
  plan: ['read-only', 'write'], upload: ['read-only', 'write'],
  'fix-headers': ['write'],
})[command];

function versionedObjects(version) {
  return [
    { file: `Vonvon-Bot-${version}-universal.zip`, contentType: 'application/zip' },
    { file: `Vonvon-Bot-${version}-universal.dmg`, contentType: 'application/x-apple-diskimage' },
    { file: `feed-${version}.json`, contentType: 'application/json' },
  ];
}

const writeConfigFields = ['bucket', 'region', 'prefix', 'publicManifestURL', 'secretIdEnv', 'secretKeyEnv', 'securityTokenEnv', 'sdkModule'];
/** The write key lives in its own external file; like --cos-config it holds only variable names. */
export async function readCosWriteConfig(configPath, { readJSON = async path => JSON.parse(await readFile(path, 'utf8')) } = {}) {
  if (!isAbsolute(configPath ?? '')) throw new Error('Publishing requires an absolute --cos-write-config file outside the repository');
  let config;
  try { config = await readJSON(configPath); } catch { throw new Error('Cannot read COS write configuration'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('COS write configuration must be a JSON object');
  if (Object.hasOwn(config, 'cdn')) throw new Error('CDN refresh is not implemented; add a reviewed refresh step before configuring a CDN');
  if (Object.keys(config).some(key => !writeConfigFields.includes(key))) throw new Error('COS write configuration has unexpected fields; it may hold only target settings and credential environment variable names');
  if (!isStableCosTarget(config)) throw new Error('COS write configuration must identify the stable bucket, region, prefix and public URL');
  assertCredentialEnvNames(config);
  if (!config.secretIdEnv || !config.secretKeyEnv) throw new Error('Configure the COS write key as environment variable names, never inline credentials');
  return config;
}

// SDK errors can carry signed request details; keep only the HTTP status and a short error code.
function cosFailure(operation, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  const code = [error?.code, error?.error?.Code].find(value => typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value));
  return Object.assign(new Error(`COS ${operation} failed${status ? ` with HTTP ${status}` : ''}${code ? ` (${code})` : ''}; inspect the account privately`), { cosStatus: status, cosCode: code });
}
const cosCall = (client, method, params, operation) => new Promise((resolvePromise, reject) => {
  try { client[method](params, (error, data) => error ? reject(cosFailure(operation, error)) : resolvePromise(data ?? {})); } catch (error) { reject(cosFailure(operation, error)); }
});
const refusedOverwrite = error => error.cosStatus === 409 || error.cosCode === 'FileAlreadyExists';

async function openContext(command, options, dependencies) {
  const env = dependencies.env ?? process.env;
  assertSecureTransport(env, dependencies.execArgv ?? process.execArgv);
  for (const [name, value] of Object.entries(options)) {
    if (value !== undefined && value !== false && !commandOptions[command].includes(name)) throw new Error(`${command} does not take --${name}; see --help`);
  }
  if (!versionPattern.test(options.version ?? '')) throw new Error('Supply --version X.Y.Z');
  if (!/^[a-f0-9]{40}$/.test(options.sha ?? '')) throw new Error('Supply the full, exact --sha of the release source');
  if (!isAbsolute(options.out ?? '')) throw new Error('Supply --out as the absolute evidence directory written by release-mac');
  const readConfig = await readCosConfig(options['cos-config']);
  const writeConfig = await readCosWriteConfig(options['cos-write-config']);
  if (readConfig.bucket !== writeConfig.bucket || readConfig.region !== writeConfig.region || readConfig.prefix !== writeConfig.prefix) throw new Error('Read-only and write COS configurations must name the same stable bucket, region and prefix');
  const readNames = cosCredentialEnvNames(readConfig), writeNames = cosCredentialEnvNames(writeConfig);
  if (writeNames.some(name => readNames.includes(name))) throw new Error('The write key must use environment variables separate from the read-only enumeration key');
  if (env[readConfig.secretIdEnv] && env[readConfig.secretIdEnv] === env[writeConfig.secretIdEnv]) throw new Error('The write key must belong to a different sub-account from the read-only enumeration key');
  // Fail before any work when a key this command uses is absent; values are never read into output.
  const roles = { 'read-only': [readConfig, dependencies.readClient], write: [writeConfig, dependencies.writeClient] };
  for (const role of keysUsed(command)) {
    const [config, injected] = roles[role];
    if (!injected && (!config.secretIdEnv || !config.secretKeyEnv || cosCredentialEnvNames(config).some(name => !env[name]))) throw new Error(`The COS ${role} key is not in this process environment; the owner provides the variables its configuration names, never their values`);
  }
  const configHashes = { readConfigSHA256: sha256(await readFile(options['cos-config'])), writeConfigSHA256: sha256(await readFile(options['cos-write-config'])) };
  const secrets = new Set([...readNames, ...writeNames]);
  return {
    command, options, dependencies, env, version: options.version, sha: options.sha, out: resolve(options.out), readConfig, writeConfig, configHashes,
    // Verification children never see either key.
    childEnv: Object.fromEntries(Object.entries(env).filter(([name]) => !secrets.has(name))),
    fetchImpl: dependencies.fetchImpl ?? fetch, execute: dependencies.execFile ?? exec, log: dependencies.log ?? console.log, now: dependencies.now ?? (() => new Date()),
  };
}

async function writeClient(context) {
  if (context.client) return context.client;
  if (context.dependencies.writeClient) return (context.client = context.dependencies.writeClient);
  const config = context.writeConfig;
  for (const name of cosCredentialEnvNames(config)) if (!context.env[name]) throw new Error('Required COS write credential environment variable is unavailable');
  const COS = await loadPinnedSdk(config.sdkModule);
  context.client = new COS({ SecretId: context.env[config.secretIdEnv], SecretKey: context.env[config.secretKeyEnv], ...(config.securityTokenEnv ? { SecurityToken: context.env[config.securityTokenEnv] } : {}),
    // cos-request's timeout runs until response headers, so it must cover a whole large PUT.
    Protocol: 'https:', StrictSsl: true, FollowRedirect: false, KeepAlive: false, Timeout: 30 * 60_000 });
  return context.client;
}
const target = (context, key) => ({ Bucket: context.writeConfig.bucket, Region: context.writeConfig.region, ...(key ? { Key: key } : {}) });

const verifyModes = {
  local: { flags: ['--local-only'], label: '--local-only' },
  versioned: { flags: ['--versioned-only'], label: '--versioned-only', field: 'versionedObjectsVerified' },
};
/** Success is the printed line or JSON field (workflow.md), never the exit code alone. */
async function runVerify(context, mode) {
  const { flags, label, field } = verifyModes[mode];
  let result;
  try {
    result = await context.execute(process.execPath, [verifyScript, '--out', context.out, '--version', context.version, '--sha', context.sha, ...flags], { env: context.childEnv, timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const reason = String(error.stderr ?? '').split('\n').find(line => line.trim())?.slice(0, 300) ?? 'no diagnostic';
    throw new Error(`verify-public-release ${label} failed: ${redact(reason)}`);
  }
  const stdout = String(result?.stdout ?? '');
  if (mode === 'local') {
    if (!/^Local formal-release evidence verified\./m.test(stdout)) throw new Error('verify-public-release --local-only did not print "Local formal-release evidence verified."; not verified');
    return { localEvidenceVerified: true };
  }
  let report;
  try { report = JSON.parse(stdout); } catch { report = undefined; }
  if (!stdout.includes(`"${field}": true`) || report?.[field] !== true || report.version !== context.version || report.sourceCommit !== context.sha) {
    throw new Error(`verify-public-release ${label} did not print "${field}": true for this release; not verified`);
  }
  return report;
}
function assertReportCovers(report, steps) {
  for (const step of steps) {
    const record = report.files?.find(item => item.file === step.file);
    if (!record || record.sha256 !== step.sha256 || record.size !== step.size) throw new Error(`Verification did not confirm ${step.file} with its planned size and SHA-256`);
  }
}

async function liveManifest(context) {
  const live = await readStableManifest({ fetchImpl: context.fetchImpl, url: manifestURL, env: context.env });
  if (live.kind === 'missing') return { live, snapshot: { url: manifestURL, status: 404 } };
  return { live, snapshot: { url: manifestURL, status: 200, version: live.manifest.version, feedURL: live.manifest.feedURL, size: live.bytes.length, sha256: sha256(live.bytes), bytesBase64: live.bytes.toString('base64') } };
}

async function assertVersioningNeverEnabled(context) {
  const data = await cosCall(await writeClient(context), 'getBucketVersioning', target(context), 'GetBucketVersioning');
  const configuration = data.VersioningConfiguration;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('COS returned an unrecognized bucket versioning status; stop before any upload');
  if (configuration.Status !== undefined && configuration.Status !== '') {
    const status = ['Enabled', 'Suspended'].includes(configuration.Status) ? configuration.Status : 'in an unknown state';
    throw new Error(`Bucket versioning is ${status}; x-cos-forbid-overwrite would be ignored, so stop until a reviewed equivalent atomic protection exists`);
  }
}

async function uploadRecord(context) {
  for (const name of [names.uploadState, names.uploadReceipt]) {
    const path = join(context.out, name);
    if (!(await exists(path))) continue;
    const record = await readJSONFile(path, name);
    if (record.version !== context.version || record.sourceCommit !== context.sha) throw new Error(`${name} belongs to different release inputs; investigate`);
    return true;
  }
  return false;
}
// Hash only: plans and receipts never name the bucket, yet a reworded config can be told from another target.
const targetIdentity = config => sha256(JSON.stringify([config.bucket, config.region, config.prefix]));

/**
 * COS history plus ledger, excluding this version only when this OUT itself started uploading it;
 * then a resumed upload still gates on every other published version.
 */
async function publishedHistory(context) {
  const evidence = await readCosReleaseEvidence(context.options['cos-config'], { env: context.env, config: context.readConfig, client: context.dependencies.readClient });
  const ownKeys = new Set(versionedObjects(context.version).map(object => context.readConfig.prefix + object.file));
  if ((evidence.versions.includes(context.version) || evidence.keys.some(key => ownKeys.has(key))) && !(await uploadRecord(context))) {
    throw new Error(`Version ${context.version} already appears in COS or the ledger, but this output has no upload record; investigate instead of publishing`);
  }
  return { keys: evidence.keys.filter(key => !ownKeys.has(key)), versions: evidence.versions.filter(version => version !== context.version) };
}

async function checkLocalEvidence(context) {
  // Refuses DO-NOT-PUBLISH, rehearsal or incomplete output, another version or SHA, missing or extra
  // public files, and any size, SHA-256 or SHA256SUMS mismatch after rehashing every file.
  const { inventory } = await validateReleaseInventory(context.out, { version: context.version, sha: context.sha });
  const manifestBytes = await readFile(join(context.out, 'manifest.json'));
  if (validateManifest(JSON.parse(manifestBytes.toString('utf8'))).version !== context.version) throw new Error('Local manifest.json names a different version');
  await runVerify(context, 'local');
  return { inventory, manifestBytes };
}

/** Every gate of the plan; the result is deterministic so upload can regenerate and compare it. */
async function buildPlan(context, flags) {
  const { inventory, manifestBytes } = await checkLocalEvidence(context);
  const { live, snapshot } = await liveManifest(context);
  const history = await publishedHistory(context);
  const baseline = validateFirstRelease({ firstRelease: flags.firstRelease, noLiveManifest: flags.noLiveManifest, live, evidence: history });
  checkVersionGate({ version: context.version, mode: 'release', liveVersion: live.manifest?.version, firstRelease: baseline === 'none', historicalVersions: history.versions });
  await assertVersioningNeverEnabled(context);
  const { prefix, region } = context.writeConfig;
  const record = file => inventory.files.find(item => item.file === file);
  const historicalVersions = [...new Set(history.versions)].sort(compareVersions);
  const highestPublished = [...historicalVersions, ...(live.manifest ? [live.manifest.version] : [])].sort(compareVersions).at(-1) ?? null;
  const manifestRecord = record('manifest.json');
  if (manifestRecord.sha256 !== sha256(manifestBytes)) throw new Error('Local manifest.json differs from the inventory');
  const manifestHeaders = { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json' };
  const plan = {
    planFormat: 1,
    tool: 'scripts/release-cos-publish.mjs',
    version: context.version,
    sourceCommit: context.sha,
    notarization: inventory.notarization ?? null,
    target: { region, prefix, publicBaseURL: new URL('.', manifestURL).href, sdk: `cos-nodejs-sdk-v5@${COS_SDK_VERSION}`, targetSHA256: targetIdentity(context.writeConfig), ...context.configHashes },
    gates: {
      localEvidence: 'verify-public-release --local-only printed "Local formal-release evidence verified."',
      bucketVersioning: 'never enabled',
      releaseFlags: { firstRelease: !!flags.firstRelease, noLiveManifest: !!flags.noLiveManifest },
      baseline, helperBaseline: inventory.baseline ?? null, historicalVersions, highestPublished,
    },
    previousManifest: snapshot,
    uploadIntegrity: 'Each PUT sends Content-MD5 of bytes whose size and SHA-256 equal this plan; an existing object is reused only when its public bytes have the planned SHA-256',
    upload: versionedObjects(context.version).map((object, index) => ({
      step: index + 1, operation: 'PutObject', key: prefix + object.file, file: object.file, url: new URL(object.file, manifestURL).href, size: record(object.file).size, sha256: record(object.file).sha256,
      headers: { 'Cache-Control': immutableCache, 'Content-Type': object.contentType, 'x-cos-forbid-overwrite': 'true' },
    })),
    afterUpload: ['verify-public-release --versioned-only must print "versionedObjectsVerified": true', `then the ledger records ${context.version}`],
    promote: {
      step: 4, operation: 'PutObject', key: `${prefix}manifest.json`, file: 'manifest.json', url: manifestURL, size: manifestRecord.size, sha256: manifestRecord.sha256,
      headers: { ...manifestHeaders, ...(snapshot.status === 404 ? { 'x-cos-forbid-overwrite': 'true' } : {}) },
      requires: 'the owner\'s own stable confirmation in their Codex App session, the unchanged live manifest snapshot above and a passing --versioned-only',
      cdn: NO_CDN, afterPromote: 'full verify-public-release must print "publiclyVerified": true',
    },
    rollback: snapshot.status === 200
      ? { command: 'rollback --restore-previous', operation: 'PutObject', key: `${prefix}manifest.json`, size: snapshot.size, sha256: snapshot.sha256, headers: manifestHeaders, untouched: 'versioned objects and the ledger' }
      : { command: 'rollback --delete-first-release-manifest', operation: 'DeleteObject', key: `${prefix}manifest.json`, expect: 'public manifest returns HTTP 404 and COS lists no manifest.json', untouched: 'versioned objects and the ledger' },
  };
  const bytes = Buffer.from(json(plan));
  return { plan, bytes, sha256: sha256(bytes), manifestBytes };
}

function describePlan(plan) {
  const headers = values => Object.entries(values).map(([name, value]) => `${name}: ${value}`).join('; ');
  const before = plan.previousManifest.status === 404 ? 'HTTP 404 (no stable manifest)' : `HTTP 200, version ${plan.previousManifest.version}, ${plan.previousManifest.size} bytes, SHA-256 ${plan.previousManifest.sha256}`;
  const promote = plan.promote;
  return [
    `COS write plan for Vonvon Bot ${plan.version} from source ${plan.sourceCommit}. plan made no COS write.`,
    `Stable manifest now: ${before}`,
    `Baseline: ${JSON.stringify(plan.gates.baseline)}; highest previously published: ${plan.gates.highestPublished ?? 'none'}; bucket versioning: never enabled`,
    'upload (versioned objects only, after the owner approves this plan):',
    ...plan.upload.flatMap(step => [`  ${step.step}. ${step.operation} ${step.key}  ${step.size} bytes  SHA-256 ${step.sha256}`, `     ${headers(step.headers)}`]),
    `  then ${plan.afterUpload.join('; ')}`,
    'stable switch (recorded in this plan; the promote command comes in the next PR, so stop after upload):',
    `  ${promote.step}. ${promote.operation} ${promote.key}  ${promote.size} bytes  SHA-256 ${promote.sha256}`,
    `     ${headers(promote.headers)}`,
    `     CDN: ${promote.cdn}`,
    `  then ${promote.afterPromote}`,
    `rollback if needed (the rollback command comes in the next PR): ${plan.rollback.command}: ${plan.rollback.operation} ${plan.rollback.key}${plan.rollback.sha256 ? ` (saved bytes, SHA-256 ${plan.rollback.sha256})` : `; ${plan.rollback.expect}`}; ${plan.rollback.untouched} untouched`,
  ];
}

async function readReviewedPlan(context, expected) {
  let bytes;
  try { bytes = await readFile(join(context.out, names.plan)); } catch (error) { throw new Error(error.code === 'ENOENT' ? `${names.plan} is missing; run plan first` : `Cannot read ${names.plan}`); }
  if (sha256(bytes) !== expected) throw new Error(`${names.plan} differs from --plan-sha256; use the plan the owner reviewed`);
  const plan = JSON.parse(bytes.toString('utf8'));
  if (plan.planFormat !== 1 || plan.version !== context.version || plan.sourceCommit !== context.sha) throw new Error('The reviewed plan belongs to a different version or source SHA');
  if (plan.target?.readConfigSHA256 !== context.configHashes.readConfigSHA256 || plan.target?.writeConfigSHA256 !== context.configHashes.writeConfigSHA256) {
    throw new Error('COS configuration files changed since the reviewed plan; run plan again');
  }
  return { plan, bytes };
}

const planHash = options => {
  if (!/^[a-f0-9]{64}$/.test(options['plan-sha256'] ?? '')) throw new Error('Supply --plan-sha256 with the SHA-256 that plan printed and the owner reviewed');
  return options['plan-sha256'];
};
const cancelFile = options => {
  if (!isAbsolute(options['cancel-file'] ?? '')) throw new Error('Supply --cancel-file /absolute/path; creating that file stops the run before its next COS write');
  return options['cancel-file'];
};
async function assertNotCancelled(path, when) {
  if (await exists(path)) throw new Error(`Cancel file exists; stopped ${when}`);
}
const releaseFlags = options => ({ firstRelease: !!options['first-release'], noLiveManifest: !!options['no-live-manifest'] });

const running = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function withLock(context, work) {
  if (await exists(join(context.out, '.release.lock'))) throw new Error('release-mac still holds this output; wait for it to finish');
  const path = join(context.out, names.lock);
  const take = () => open(path, 'wx').catch(error => { throw new Error(error.code === 'EEXIST' ? 'Publishing output is locked; wait for the other run to finish' : 'Cannot lock the evidence directory; check --out'); });
  let handle;
  try { handle = await take(); } catch (error) {
    // An interrupted or killed run leaves its lock behind; it is stale once that process is gone.
    const holder = (await readFile(path, 'utf8').catch(() => '')).trim();
    if (!/^[1-9]\d*$/.test(holder) || holder === String(process.pid) || running(Number(holder))) throw error;
    context.log(`Removing the stale .publish.lock of process ${holder}, which is no longer running`);
    await unlink(path).catch(problem => { if (problem.code !== 'ENOENT') throw problem; });
    handle = await take();
  }
  try { await handle.writeFile(String(process.pid)); return await work(); } finally { await handle.close(); await unlink(path); }
}

/** Same rule as workflow.md "写台账": already present is not repeated; a leftover .new stops. */
export async function appendLedger(file, version) {
  if (!isAbsolute(file ?? '') || !versionPattern.test(version ?? '')) throw new Error('ledger or version is invalid');
  const ledger = await readJSONFile(file, 'the publication ledger');
  if (!Array.isArray(ledger?.versions) || ledger.versions.some(item => typeof item !== 'string')) throw new Error('ledger or version is invalid');
  const interrupted = new Error(`${file}.new already exists: an earlier write was interrupted; investigate before retrying`);
  if (await exists(`${file}.new`)) throw interrupted;
  if (ledger.versions.includes(version)) return 'already-recorded';
  ledger.versions.push(version);
  await writeFile(`${file}.new`, json(ledger), { flag: 'wx', mode: 0o600 }).catch(error => { throw error.code === 'EEXIST' ? interrupted : error; });
  await rename(`${file}.new`, file);
  return 'appended';
}
async function publicDigest(context, url, expectedSize, timeout = 20 * 60_000) {
  const response = await context.fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (response.redirected) throw new Error('Release endpoint redirected');
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return { status: 404 }; }
  if (response.status !== 200 || !response.body) throw new Error(`Public object returned HTTP ${response.status}; cannot compare its bytes`);
  const hash = createHash('sha256'); let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > expectedSize) return { status: 200, size, sha256: null };
    hash.update(chunk);
  }
  return { status: 200, size, sha256: hash.digest('hex') };
}

/** plan: read-only; writes OUT/publish-plan.json and prints its SHA-256 for the owner. */
export async function planPublish(options, dependencies = {}) {
  const context = await openContext('plan', options, dependencies);
  return withLock(context, async () => {
    const { plan, bytes, sha256: hash } = await buildPlan(context, releaseFlags(options));
    const path = join(context.out, names.plan);
    await writeAtomic(path, bytes);
    for (const line of describePlan(plan)) context.log(line);
    context.log(`Plan file: ${path}`);
    context.log(`Plan SHA-256: ${hash}`);
    return { plan, sha256: hash, path };
  });
}

/** upload: only the versioned ZIP, DMG and feed; never manifest.json. */
export async function uploadRelease(options, dependencies = {}) {
  const context = await openContext('upload', options, dependencies);
  const expected = planHash(options), cancel = cancelFile(options);
  await assertNotCancelled(cancel, 'before upload; nothing was uploaded');
  return withLock(context, async () => {
    const { plan, sha256: regenerated } = await buildPlan(context, releaseFlags(options));
    if (regenerated !== expected) throw new Error('The regenerated plan differs from --plan-sha256; nothing was uploaded. Run plan again and have the owner review the new plan');
    await readReviewedPlan(context, expected);
    const statePath = join(context.out, names.uploadState);
    if (!(await uploadRecord(context))) await writeFile(statePath, json({ version: context.version, sourceCommit: context.sha, startedAt: context.now().toISOString() }), { flag: 'wx' });
    const client = await writeClient(context);
    const objects = [];
    for (const step of plan.upload) {
      await assertNotCancelled(cancel, `before uploading ${step.file}`);
      // The PUT body is the very buffer just hashed, so no file change can slip in after the check.
      const body = await readFile(join(context.out, step.file));
      if (body.length !== step.size || sha256(body) !== step.sha256) throw new Error(`${step.file} differs from the reviewed plan; stopped before uploading it`);
      context.log(`PutObject ${step.key} (${step.size} bytes, SHA-256 ${step.sha256})`);
      let result = 'uploaded';
      try {
        await cosCall(client, 'putObject', { ...target(context, step.key), Body: body, ContentLength: body.length, ContentMD5: md5(body),
          CacheControl: step.headers['Cache-Control'], ContentType: step.headers['Content-Type'], Headers: { 'x-cos-forbid-overwrite': 'true' } }, `PutObject ${step.file}`);
      } catch (error) {
        if (!refusedOverwrite(error)) throw error;
        // ETag is not a content hash for every upload path; only the full public SHA-256 decides reuse.
        const existing = await publicDigest(context, step.url, step.size);
        if (existing.status === 404) throw new Error(`COS refused to overwrite ${step.key}, but its public URL returns HTTP 404; investigate`);
        if (existing.size !== step.size || existing.sha256 !== step.sha256) throw new Error(`${step.key} already exists with different bytes; stopped without overwriting. Investigate; published bytes are never replaced`);
        result = 'reused-existing';
        context.log(`${step.key} already existed with the planned SHA-256; reused without overwriting`);
      }
      objects.push({ key: step.key, file: step.file, url: step.url, size: step.size, sha256: step.sha256, cacheControl: step.headers['Cache-Control'], contentType: step.headers['Content-Type'], result, at: context.now().toISOString() });
    }
    const verification = await runVerify(context, 'versioned');
    assertReportCovers(verification, plan.upload);
    const ledger = await appendLedger(context.readConfig.ledgerFile, context.version);
    context.log(`Ledger records ${context.version}`);
    const receipt = { receipt: 'upload', version: context.version, sourceCommit: context.sha, planSHA256: expected, objects, versionedVerification: verification, ledger, stableManifest: 'not changed', completedAt: context.now().toISOString() };
    await writeAtomic(join(context.out, names.uploadReceipt), json(receipt));
    context.log(JSON.stringify(verification, null, 2));
    context.log('Versioned objects uploaded and publicly verified; the stable manifest was not changed. Show the JSON above to the owner and stop here: the promote command comes in the next PR, and only the owner\'s own confirmation in their Codex App session allows the stable switch.');
    return receipt;
  });
}

/** fix-headers: same-key PUT Object - Copy with Replaced metadata; bytes stay and are rehashed publicly. */
export async function fixReleaseHeaders(options, dependencies = {}) {
  const context = await openContext('fix-headers', options, dependencies);
  const expected = planHash(options), cancel = cancelFile(options);
  await assertNotCancelled(cancel, 'before fixing headers');
  return withLock(context, async () => {
    const { plan } = await readReviewedPlan(context, expected);
    if (!(await uploadRecord(context))) throw new Error('This output has no upload record; fix-headers only repairs objects its upload wrote');
    const client = await writeClient(context), { bucket, region } = context.writeConfig;
    const objects = [];
    for (const step of plan.upload) {
      // Never restamp metadata onto bytes that are not the planned release.
      const existing = await publicDigest(context, step.url, step.size);
      if (existing.status !== 200 || existing.size !== step.size || existing.sha256 !== step.sha256) throw new Error(`${step.key} does not publicly serve the planned bytes; stopped before changing its headers`);
      await assertNotCancelled(cancel, `before fixing ${step.file}`);
      const cacheControl = step.headers['Cache-Control'], contentType = step.headers['Content-Type'];
      context.log(`PUT Object - Copy ${step.key} onto itself; x-cos-metadata-directive: Replaced; Cache-Control: ${cacheControl}; Content-Type: ${contentType}`);
      await cosCall(client, 'putObjectCopy', { ...target(context, step.key), CopySource: `${bucket}.cos.${region}.myqcloud.com/${encodeURIComponent(step.key).replaceAll('%2F', '/')}`,
        MetadataDirective: 'Replaced', CacheControl: cacheControl, ContentType: contentType }, `PUT Object - Copy ${step.file}`);
      objects.push({ key: step.key, cacheControl, contentType, at: context.now().toISOString() });
    }
    const verification = await runVerify(context, 'versioned');
    assertReportCovers(verification, plan.upload);
    const ledger = await appendLedger(context.readConfig.ledgerFile, context.version);
    context.log(`Ledger records ${context.version}`);
    const receipt = { receipt: 'fix-headers', version: context.version, sourceCommit: context.sha, planSHA256: expected, objects, bytes: 'unchanged; full SHA-256 re-verified publicly', versionedVerification: verification, ledger, completedAt: context.now().toISOString() };
    await writeAtomic(join(context.out, names.fixReceipt), json(receipt));
    context.log(JSON.stringify(verification, null, 2));
    if (!(await exists(join(context.out, names.uploadReceipt)))) context.log('Run upload again with the same plan to record upload-receipt.json.');
    return receipt;
  });
}

export const publishCommands = { plan: planPublish, upload: uploadRelease, 'fix-headers': fixReleaseHeaders };

const help = `Usage: node scripts/release-cos-publish.mjs <plan|upload|fix-headers> --out /absolute/evidence --version X.Y.Z --sha FULL_SHA --cos-config /absolute/cos-readonly.json --cos-write-config /absolute/cos-write.json [options]

plan         Read-only; makes no COS write. Rechecks the formal-release evidence (state, inventory, DO-NOT-PUBLISH, every file against SHA256SUMS, verify-public-release --local-only), snapshots the live stable manifest over strict TLS without redirects, recomputes the highest published version from COS and the ledger, and requires bucket versioning never enabled. A 404 manifest needs --first-release or --no-live-manifest exactly as release-mac does. Writes OUT/publish-plan.json and prints its SHA-256 for the owner to review.
upload       --plan-sha256 HASH --cancel-file /absolute/path [--first-release | --no-live-manifest]. Regenerates the plan and requires the reviewed hash, then PUTs only the versioned ZIP, DMG and feed with x-cos-forbid-overwrite: true. An existing object is reused only when its public bytes have the planned full SHA-256. Requires verify-public-release --versioned-only to print "versionedObjectsVerified": true, appends the ledger and writes OUT/upload-receipt.json. Never touches manifest.json.
fix-headers  --plan-sha256 HASH --cancel-file /absolute/path. Only for objects this output uploaded and only while their public bytes match the plan. Same-key PUT Object - Copy with x-cos-metadata-directive: Replaced and the planned headers; bytes unchanged, then --versioned-only must pass again with the same full SHA-256.

Switching the stable manifest (promote), finishing its public verification (reverify) and withdrawing it (rollback) come in the next PR; until then stop after upload and never switch stable by hand.

The write key comes from environment variables named in --cos-write-config (same bucket, region and prefix as --cos-config, separate variables, pinned cos-nodejs-sdk-v5@${COS_SDK_VERSION} installed with npm ci from scripts/cos-sdk/package-lock.json). Keys each command needs in its environment: plan and upload both (plan reads bucket versioning with the write key); fix-headers only the write key. A command stops at once when a key it uses is missing and never requires one it does not use. Neither key reaches child processes or output. TLS trust-store overrides and redirects are refused. CDN refresh is not implemented; a cdn setting is refused. A .publish.lock whose recorded process is no longer running is removed automatically.`;

const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath && invokedPath === await realpath(scriptPath)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      out: { type: 'string' }, version: { type: 'string' }, sha: { type: 'string' }, 'cos-config': { type: 'string' }, 'cos-write-config': { type: 'string' },
      'first-release': { type: 'boolean' }, 'no-live-manifest': { type: 'boolean' }, 'plan-sha256': { type: 'string' }, 'cancel-file': { type: 'string' }, help: { type: 'boolean' },
    } });
    const { help: wantsHelp, ...options } = values;
    if (wantsHelp) console.log(help);
    else if (positionals.length !== 1 || !Object.hasOwn(publishCommands, positionals[0])) throw new Error('Use one subcommand: plan, upload or fix-headers; see --help');
    else await publishCommands[positionals[0]](options);
  } catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
