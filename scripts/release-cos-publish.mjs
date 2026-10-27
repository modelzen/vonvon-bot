import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { checkVersionGate, compareVersions, validateFirstRelease } from './release-mac.mjs';
import { assertCredentialEnvNames, COS_SDK_VERSION, cosCredentialEnvNames, isStableCosTarget, loadPinnedSdk, readCosConfig, readCosReleaseEvidence } from './release-cos-evidence.mjs';
import { assertSecureTransport, cachePolicy, DEFAULT_MANIFEST_URL, readStableManifest, validateManifest, validateReleaseInventory } from './verify-public-release.mjs';

// The only COS writer for releases. plan writes nothing to COS; upload writes the three versioned
// objects named in an owner-reviewed plan; promote writes bot/mac/stable/manifest.json and nothing
// else; rollback touches only that manifest; fix-headers replaces versioned-object metadata in place.
const manifestURL = DEFAULT_MANIFEST_URL;
const immutableCache = 'public, max-age=31536000, immutable';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const NO_CDN = '未启用 CDN，未刷新';
const names = { plan: 'publish-plan.json', uploadState: 'publish-upload-state.json', uploadReceipt: 'upload-receipt.json', publishReceipt: 'publish-receipt.json', rollbackReceipt: 'rollback-receipt.json', fixReceipt: 'fix-headers-receipt.json', lock: '.publish.lock' };
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
  promote: [...common, 'plan-sha256', 'cancel-file', 'owner-confirmation'],
  rollback: [...common, 'plan-sha256', 'restore-previous', 'delete-first-release-manifest', 'dry-run'],
  'fix-headers': [...common, 'plan-sha256', 'cancel-file'],
};

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
  full: { flags: [], label: 'full public verification', field: 'publiclyVerified' },
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
const sameSnapshot = (a, b) => a.status === b.status && (a.status === 404 || (a.sha256 === b.sha256 && a.size === b.size));

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
  const path = join(context.out, names.uploadState);
  if (!(await exists(path))) return false;
  const record = await readJSONFile(path, names.uploadState);
  if (record.version !== context.version || record.sourceCommit !== context.sha) throw new Error(`${names.uploadState} belongs to different release inputs; investigate`);
  return true;
}

/**
 * COS history plus ledger, excluding this version only when this OUT itself started uploading it;
 * then a resumed upload or a later promote still gates on every other published version.
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

/** Every gate of the plan; the result is deterministic so upload and promote can regenerate and compare it. */
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
    target: { region, prefix, publicBaseURL: new URL('.', manifestURL).href, sdk: `cos-nodejs-sdk-v5@${COS_SDK_VERSION}`, ...context.configHashes },
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
    'promote (only after the owner\'s own stable confirmation in their Codex App session):',
    `  ${promote.step}. ${promote.operation} ${promote.key}  ${promote.size} bytes  SHA-256 ${promote.sha256}`,
    `     ${headers(promote.headers)}`,
    `     CDN: ${promote.cdn}`,
    `  then ${promote.afterPromote}`,
    `rollback if needed: ${plan.rollback.command}: ${plan.rollback.operation} ${plan.rollback.key}${plan.rollback.sha256 ? ` (saved bytes, SHA-256 ${plan.rollback.sha256})` : `; ${plan.rollback.expect}`}; ${plan.rollback.untouched} untouched`,
  ];
}

async function readReviewedPlan(context, expected) {
  let bytes;
  try { bytes = await readFile(join(context.out, names.plan)); } catch (error) { throw new Error(error.code === 'ENOENT' ? `${names.plan} is missing; run plan first` : `Cannot read ${names.plan}`); }
  if (sha256(bytes) !== expected) throw new Error(`${names.plan} differs from --plan-sha256; use the plan the owner reviewed`);
  const plan = JSON.parse(bytes.toString('utf8'));
  if (plan.planFormat !== 1 || plan.version !== context.version || plan.sourceCommit !== context.sha) throw new Error('The reviewed plan belongs to a different version or source SHA');
  if (plan.target?.readConfigSHA256 !== context.configHashes.readConfigSHA256 || plan.target?.writeConfigSHA256 !== context.configHashes.writeConfigSHA256) throw new Error('COS configuration files changed since the reviewed plan; run plan again');
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

async function withLock(context, work) {
  if (await exists(join(context.out, '.release.lock'))) throw new Error('release-mac still holds this output; wait for it to finish');
  const path = join(context.out, names.lock);
  const handle = await open(path, 'wx').catch(error => { throw new Error(error.code === 'EEXIST' ? 'Publishing output is locked; check the recorded process before removing a stale .publish.lock' : 'Cannot lock the evidence directory; check --out'); });
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
async function ledgerContains(file, version) {
  const ledger = await readJSONFile(file, 'the publication ledger');
  return Array.isArray(ledger?.versions) && ledger.versions.includes(version);
}

async function publicDigest(context, url, expectedSize) {
  const response = await context.fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20 * 60_000) });
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
    context.log('Versioned objects uploaded and publicly verified; the stable manifest was not changed. Show the JSON above to the owner. Only the owner\'s own confirmation in their Codex App session allows promote.');
    return receipt;
  });
}

function ownerConfirmation(options) {
  const text = options['owner-confirmation'];
  if (typeof text !== 'string' || !text.trim()) throw new Error('promote requires --owner-confirmation with the verbatim text of the owner\'s own message in their Codex App session');
  const version = new RegExp(`(?<![0-9.])${options.version.replaceAll('.', '\\.')}(?!\\.?[0-9])`);
  const sha = new RegExp(`(?<![0-9a-f])${options.sha}(?![0-9a-f])`, 'i');
  if (!version.test(text) || !sha.test(text) || !/发布到\s*stable/i.test(text)) throw new Error('The owner confirmation must state this version, the exact full source SHA and 发布到 stable');
  return text;
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function rollbackCommand(context, plan, planSHA256) {
  const mode = plan.previousManifest.status === 200 ? '--restore-previous' : '--delete-first-release-manifest';
  return ['node', quote(scriptPath), 'rollback', mode, '--out', quote(context.out), '--version', context.version, '--sha', context.sha, '--plan-sha256', planSHA256,
    '--cos-config', quote(context.options['cos-config']), '--cos-write-config', quote(context.options['cos-write-config'])].join(' ');
}

/** promote: writes only bot/mac/stable/manifest.json, last, after the owner's own stable confirmation. */
export async function promoteRelease(options, dependencies = {}) {
  const context = await openContext('promote', options, dependencies);
  const expected = planHash(options), cancel = cancelFile(options), confirmation = ownerConfirmation(options);
  await assertNotCancelled(cancel, 'before promote; the stable manifest was not changed');
  return withLock(context, async () => {
    const { plan } = await readReviewedPlan(context, expected);
    if (await exists(join(context.out, names.rollbackReceipt))) throw new Error('This candidate was rolled back; a fix must be a new, higher version');
    const upload = await readJSONFile(join(context.out, names.uploadReceipt), names.uploadReceipt);
    if (upload.planSHA256 !== expected || upload.version !== context.version || upload.sourceCommit !== context.sha) throw new Error(`${names.uploadReceipt} belongs to a different plan; run upload with this plan first`);
    const { snapshot: before } = await liveManifest(context);
    if (!sameSnapshot(before, plan.previousManifest)) {
      if (before.status === 200 && before.sha256 === plan.promote.sha256) throw new Error('Stable already serves this release manifest; do not promote again. Run the full public verification and check publish-receipt.json');
      throw new Error('The live stable manifest changed since the reviewed plan; nothing was written. Run plan again and get a new owner review and confirmation');
    }
    const regenerated = await buildPlan(context, plan.gates.releaseFlags);
    if (regenerated.sha256 !== expected) throw new Error('Release evidence, COS history, bucket versioning or configuration changed since the reviewed plan; nothing was written. Run plan again');
    const versioned = await runVerify(context, 'versioned');
    assertReportCovers(versioned, plan.upload);
    if (!(await ledgerContains(context.readConfig.ledgerFile, context.version))) throw new Error('The ledger does not record this version; run upload with this plan again before promote');
    const step = plan.promote, body = regenerated.manifestBytes;
    if (body.length !== step.size || sha256(body) !== step.sha256) throw new Error('Local manifest.json differs from the reviewed plan');
    await assertNotCancelled(cancel, 'before writing the stable manifest; nothing was written');
    context.log(`PutObject ${step.key} (${step.size} bytes, SHA-256 ${step.sha256})`);
    try {
      await cosCall(await writeClient(context), 'putObject', { ...target(context, step.key), Body: body, ContentLength: body.length, ContentMD5: md5(body),
        CacheControl: step.headers['Cache-Control'], ContentType: step.headers['Content-Type'], ...(step.headers['x-cos-forbid-overwrite'] ? { Headers: { 'x-cos-forbid-overwrite': 'true' } } : {}) }, 'PutObject manifest.json');
    } catch (error) {
      if (refusedOverwrite(error)) throw new Error('A stable manifest appeared after the snapshot; nothing was overwritten. Investigate');
      throw error;
    }
    const writtenAt = context.now().toISOString();
    context.log(`CDN: ${NO_CDN}`);
    let publicVerification;
    try {
      publicVerification = await runVerify(context, 'full');
      assertReportCovers(publicVerification, [...plan.upload, step]);
    } catch (error) { publicVerification = { publiclyVerified: false, error: error.message }; }
    const passed = publicVerification.publiclyVerified === true;
    const receipt = {
      receipt: 'publish', status: passed ? 'published' : 'manifest-written-public-verification-failed', version: context.version, sourceCommit: context.sha, planSHA256: expected,
      notarization: plan.notarization, objects: upload.objects, uploadCompletedAt: upload.completedAt,
      manifest: { key: step.key, url: step.url, size: step.size, sha256: step.sha256, cacheControl: step.headers['Cache-Control'], contentType: step.headers['Content-Type'], writtenAt },
      previousManifest: { status: plan.previousManifest.status, ...(plan.previousManifest.status === 200 ? { version: plan.previousManifest.version, size: plan.previousManifest.size, sha256: plan.previousManifest.sha256 } : {}) },
      ownerConfirmation: confirmation,
      ownerConfirmationRule: 'Recorded verbatim. The tool cannot verify who sent it; only the owner\'s own message in their Codex App session counts.',
      cdn: NO_CDN, versionedVerification: versioned, publicVerification, ledgerRecordsVersion: true, completedAt: context.now().toISOString(),
    };
    await writeAtomic(join(context.out, names.publishReceipt), json(receipt));
    if (!passed) {
      context.log('Public verification failed after the stable switch. Nothing was rolled back automatically. Prepared rollback command (run it only after the owner approves it):');
      context.log(rollbackCommand(context, plan, expected));
      throw new Error(`Public verification failed after writing the stable manifest: ${publicVerification.error}`);
    }
    context.log(JSON.stringify(publicVerification, null, 2));
    context.log(`Published ${context.version} to stable; receipt saved as ${names.publishReceipt}`);
    return receipt;
  });
}

/** rollback: only the stable manifest; versioned objects and the ledger are never touched. */
export async function rollbackRelease(options, dependencies = {}) {
  const context = await openContext('rollback', options, dependencies);
  const expected = planHash(options);
  const restore = !!options['restore-previous'], remove = !!options['delete-first-release-manifest'];
  if (restore === remove) throw new Error('rollback needs exactly one of --restore-previous or --delete-first-release-manifest');
  return withLock(context, async () => {
    const { plan } = await readReviewedPlan(context, expected);
    const previous = plan.previousManifest, key = plan.promote.key;
    const { snapshot: current } = await liveManifest(context);
    let action;
    if (restore) {
      if (previous.status !== 200) throw new Error('The reviewed plan saved no previous manifest; withdraw a first release with --delete-first-release-manifest');
      const bytes = Buffer.from(previous.bytesBase64 ?? '', 'base64');
      if (bytes.length !== previous.size || sha256(bytes) !== previous.sha256) throw new Error('The saved previous manifest bytes do not match their recorded SHA-256');
      validateManifest(JSON.parse(bytes.toString('utf8')));
      if (current.status === 200 && current.sha256 === previous.sha256) action = 'already-restored';
      else if (current.status !== 200 || current.sha256 !== plan.promote.sha256) throw new Error('The live stable manifest is neither this release nor the saved previous manifest; investigate before writing');
      else {
        context.log(`Will PutObject ${key} with the saved previous manifest (version ${previous.version}, ${previous.size} bytes, SHA-256 ${previous.sha256}); Cache-Control: no-cache; Content-Type: application/json. Versioned objects and the ledger stay untouched. CDN: ${NO_CDN}`);
        if (options['dry-run']) return { action: 'dry-run' };
        await cosCall(await writeClient(context), 'putObject', { ...target(context, key), Body: bytes, ContentLength: bytes.length, ContentMD5: md5(bytes), CacheControl: 'no-cache', ContentType: 'application/json' }, 'PutObject manifest.json');
        action = 'restored';
      }
      const after = await readStableManifest({ fetchImpl: context.fetchImpl, url: manifestURL, env: context.env });
      if (after.kind !== 'present' || sha256(after.bytes) !== previous.sha256) throw new Error('The public stable manifest does not equal the saved previous manifest; investigate');
      cachePolicy(after.responseHeaders, 'manifest');
    } else {
      if (previous.status !== 404) throw new Error('--delete-first-release-manifest applies only when the reviewed plan found no stable manifest; use --restore-previous');
      if (current.status === 404) action = 'already-deleted';
      else if (current.sha256 !== plan.promote.sha256) throw new Error('The live stable manifest is not this release; investigate before deleting anything');
      else {
        context.log(`Will DeleteObject ${key} only; versioned objects and the ledger stay untouched; then the public manifest must return HTTP 404. CDN: ${NO_CDN}`);
        if (options['dry-run']) return { action: 'dry-run' };
        await cosCall(await writeClient(context), 'deleteObject', target(context, key), 'DeleteObject manifest.json');
        action = 'deleted';
      }
      if ((await readStableManifest({ fetchImpl: context.fetchImpl, url: manifestURL, env: context.env })).kind !== 'missing') throw new Error('The public stable manifest is still served; investigate');
      const listing = await readCosReleaseEvidence(context.options['cos-config'], { env: context.env, config: context.readConfig, client: context.dependencies.readClient });
      if (listing.keys.includes(key)) throw new Error('COS still lists manifest.json; investigate');
    }
    const receipt = { receipt: 'rollback', mode: restore ? 'restore-previous' : 'delete-first-release-manifest', action, version: context.version, sourceCommit: context.sha, planSHA256: expected,
      before: { status: current.status, ...(current.sha256 ? { sha256: current.sha256 } : {}) },
      after: restore ? { status: 200, sha256: previous.sha256 } : { status: 404 }, untouched: 'versioned objects and the ledger', cdn: NO_CDN, completedAt: context.now().toISOString() };
    await writeAtomic(join(context.out, names.rollbackReceipt), json(receipt));
    context.log(`Rollback ${action}; the public stable manifest is ${restore ? 'the saved previous manifest' : 'HTTP 404'}. Receipt saved as ${names.rollbackReceipt}`);
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
    const client = await writeClient(context), { bucket, region } = context.writeConfig;
    const objects = [];
    for (const step of plan.upload) {
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
    if (!(await exists(join(context.out, names.uploadReceipt)))) context.log('Run upload again with the same plan to record upload-receipt.json before promote.');
    return receipt;
  });
}

export const publishCommands = { plan: planPublish, upload: uploadRelease, promote: promoteRelease, rollback: rollbackRelease, 'fix-headers': fixReleaseHeaders };

const help = `Usage: node scripts/release-cos-publish.mjs <plan|upload|promote|rollback|fix-headers> --out /absolute/evidence --version X.Y.Z --sha FULL_SHA --cos-config /absolute/cos-readonly.json --cos-write-config /absolute/cos-write.json [options]

plan         Read-only; makes no COS write. Rechecks the formal-release evidence (state, inventory, DO-NOT-PUBLISH, every file against SHA256SUMS, verify-public-release --local-only), snapshots the live stable manifest over strict TLS without redirects, recomputes the highest published version from COS and the ledger, and requires bucket versioning never enabled. A 404 manifest needs --first-release or --no-live-manifest exactly as release-mac does. Writes OUT/publish-plan.json and prints its SHA-256 for the owner to review.
upload       --plan-sha256 HASH --cancel-file /absolute/path [--first-release | --no-live-manifest]. Regenerates the plan and requires the reviewed hash, then PUTs only the versioned ZIP, DMG and feed with x-cos-forbid-overwrite: true. An existing object is reused only when its public bytes have the planned full SHA-256. Requires verify-public-release --versioned-only to print "versionedObjectsVerified": true, appends the ledger and writes OUT/upload-receipt.json. Never touches manifest.json.
promote      --plan-sha256 HASH --cancel-file /absolute/path --owner-confirmation "verbatim owner message". Run only after the owner, in their own Codex App session and after seeing the evidence, sent a message naming the version, the exact source SHA and 发布到 stable; the tool records the text but cannot verify who sent it. Rechecks the plan, the live manifest snapshot and the versioned objects, writes only bot/mac/stable/manifest.json, requires "publiclyVerified": true and writes OUT/publish-receipt.json. On failure it prints the prepared rollback command and exits nonzero without rolling back.
rollback     --plan-sha256 HASH and exactly one of --restore-previous (write back the manifest bytes saved in the plan) or --delete-first-release-manifest (delete only manifest.json when the plan found none). Prints the action first; --dry-run stops there. Versioned objects and the ledger are never touched.
fix-headers  --plan-sha256 HASH --cancel-file /absolute/path. Same-key PUT Object - Copy with x-cos-metadata-directive: Replaced and the planned headers; bytes unchanged, then --versioned-only must pass again with the same full SHA-256.

The write key comes from environment variables named in --cos-write-config (same bucket, region and prefix as --cos-config, separate variables, pinned cos-nodejs-sdk-v5@${COS_SDK_VERSION}). Neither key reaches child processes or output. TLS trust-store overrides and redirects are refused. CDN refresh is not implemented; a cdn setting is refused.`;

const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath && invokedPath === await realpath(scriptPath)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      out: { type: 'string' }, version: { type: 'string' }, sha: { type: 'string' }, 'cos-config': { type: 'string' }, 'cos-write-config': { type: 'string' },
      'first-release': { type: 'boolean' }, 'no-live-manifest': { type: 'boolean' }, 'plan-sha256': { type: 'string' }, 'cancel-file': { type: 'string' },
      'owner-confirmation': { type: 'string' }, 'restore-previous': { type: 'boolean' }, 'delete-first-release-manifest': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
    } });
    const { help: wantsHelp, ...options } = values;
    if (wantsHelp) console.log(help);
    else if (positionals.length !== 1 || !Object.hasOwn(publishCommands, positionals[0])) throw new Error('Use one subcommand: plan, upload, promote, rollback or fix-headers; see --help');
    else await publishCommands[positionals[0]](options);
  } catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
