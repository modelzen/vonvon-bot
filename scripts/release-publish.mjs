import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { access, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { planPublish, uploadRelease, promoteRelease, reverifyRelease, readCosWriteConfig } from './release-cos-publish.mjs';
import { downloadBuild, readWindowsCosConfig, windowsObjectPlan, planWindowsUpdates, promoteWindowsUpdates } from './publish-windows.mjs';
import { collectRelease, runReleaseChild } from './release-all.mjs';
import { assertSecureTransport, readStableManifest, validateReleaseInventory, verifyPublicRelease } from './verify-public-release.mjs';
import { cosCredentialEnvNames, readCosConfig } from './release-cos-evidence.mjs';
import { planServerPublication, promoteServerStable, publishServerObjects, readServerCosConfig, STABLE_RECEIPT, UPLOAD_RECEIPT } from './publish-server.mjs';
import { planR2Mirror, readR2Config, r2PlanSHA256, syncR2Mirror, R2_UPLOAD_RECEIPT, R2_STABLE_RECEIPT } from './release-r2.mjs';
import { withReleaseCdnVerification } from './release-cdn.mjs';
import { SERVER_REQUIRED_FROM, SERVER_SETUP_DOC, serverRequired } from './server-constants.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const planName = 'publication-plan.json';
const json = value => JSON.stringify(value, null, 2) + '\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
async function optional(path) { try { return await readJSON(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function atomic(path, value) { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
const outputRoot = async out => { if (!isAbsolute(out ?? '')) throw new Error('Supply absolute --out from release-all'); return realpath(out); };
async function cancelled(out) { if (await readFile(join(out, 'CANCEL')).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) throw new Error('Release stopped by CANCEL; existing publication receipts are retained'); }
async function locked(out, work) {
  const path = join(out, '.publication.lock');
  const lock = await open(path, 'wx').catch(() => { throw new Error('Publication lock exists; inspect its process before resuming'); });
  await lock.writeFile(String(process.pid));
  const control = new AbortController();
  let interrupted;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(name => [name, () => {
    interrupted ??= name;
    // Persist before aborting a child: in-process Mac writers check this before each PUT.
    try { writeFileSync(join(out, 'CANCEL'), `Publication interrupted by ${name}.\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') interrupted = 'signal; cancellation marker could not be written'; }
    control.abort();
  }]));
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    const result = await work(control.signal);
    if (interrupted) throw new Error(`Publication stopped by ${interrupted}; receipts retained`);
    return result;
  } finally {
    // work joins every upload branch before handlers or the publication lock are released.
    for (const [name, handler] of handlers) process.off(name, handler);
    await lock.close(); await unlink(path);
  }
}
/** A repository file's bytes at the release SHA, from the checkout release-all started from (not the working copy). */
async function sourceFile(repo, sha, path) {
  const { stdout } = await promisify(execFile)('git', ['show', `${sha}:${path}`], { cwd: repo, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024,
    env: Object.fromEntries(['PATH', 'HOME'].filter(name => process.env[name]).map(name => [name, process.env[name]])) });
  return stdout;
}
function runtime(dependencies) {
  const { VONVON_RELEASE_CODE_SSH: releaseCodeHost, ...env } = dependencies.env ?? process.env;
  return { download: downloadBuild, planWindowsUpdates, promoteWindowsUpdates, verifyMac: validateReleaseInventory, planMac: planPublish,
    planServer: planServerPublication, uploadServer: publishServerObjects, promoteServer: promoteServerStable, readSource: sourceFile,
    serverConfigPath: join(homedir(), '.config/vonvon-release/cos-server.json'),
    releaseCodeConfigPath: join(homedir(), '.config/vonvon-release/release-code.json'),
    r2ConfigPath: join(homedir(), '.config/vonvon-release/r2-linux.json'), planR2: planR2Mirror, syncR2: syncR2Mirror,
    uploadMac: uploadRelease, promoteMac: promoteRelease, reverifyMac: reverifyRelease,
    verifyPublicMac: verifyPublicRelease, readLiveManifest: readStableManifest, collect: collectRelease, execute: runReleaseChild, log: console.log, ...dependencies, env, releaseCodeHost };
}
async function context(options, r, saved) {
  assertSecureTransport(r.env);
  if (!isAbsolute(options.out ?? '')) throw new Error('Supply absolute --out from release-all');
  const out = await realpath(options.out), state = await readJSON(join(out, 'release-orchestration.json'));
  if (state.format !== 1 || state.out !== out || !/^[a-f0-9]{40}$/.test(state.sha ?? '') || !/^\d+\.\d+\.\d+$/.test(state.version ?? '')
    || state.mac?.phase !== 'candidate-complete' || state.windows?.status !== 'completed' || state.windows.conclusion !== 'success' || !Number.isSafeInteger(state.windows.runId)) throw new Error('Both pinned platform candidates must be complete; resume release-all first');
  const required = serverRequired(state.version), threePlatforms = `${SERVER_REQUIRED_FROM} 起三平台同版本，${state.version} 必须连 Linux 服务端包一起发`;
  if (required && state.server?.phase !== 'complete') throw new Error(`${threePlatforms}，但 release-all 的状态里没有打好的服务端包（server.phase：${state.server?.phase ?? '没有'}）：先用 release-all resume 打完，再 plan（见 ${SERVER_SETUP_DOC}）`);
  const macOut = await realpath(state.macRelease), windowsOut = join(out, 'windows');
  if (relative(out, macOut).startsWith('..') || macOut === out || isAbsolute(relative(out, macOut))) throw new Error('Mac candidate must be inside this release output');
  const requested = { readonly: state.paths.cosConfig,
    macWrite: options['cos-write-config'] ?? saved?.configs.macWrite.path ?? join(homedir(), '.config/vonvon-release/cos-write.json'),
    windows: options['windows-cos-config'] ?? saved?.configs.windows.path ?? join(homedir(), '.config/vonvon-release/cos-windows.json') };
  const configs = {};
  for (const [key, path] of Object.entries(requested)) {
    if (!isAbsolute(path ?? '')) throw new Error('Use absolute external COS configuration paths');
    configs[key] = { path: await realpath(path), sha256: digest(await readFile(path)) };
  }
  // The server is published once cos-server.json exists; a path named on the command line or in the plan must exist.
  // From 0.9.0 it must exist: no release of macOS and Windows alone, at plan, upload or promote (a plan saved without it).
  const serverPath = options['server-cos-config'] ?? (saved ? saved.configs.server?.path : r.serverConfigPath);
  if (serverPath !== undefined) {
    if (!isAbsolute(serverPath)) throw new Error('Use absolute external COS configuration paths');
    const present = await access(serverPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (present) configs.server = { path: await realpath(serverPath), sha256: digest(await readFile(serverPath)) };
    else if (options['server-cos-config'] || saved) throw new Error('服务端的 COS 配置不在指定的位置');
  }
  if (required && !configs.server) throw new Error(`${threePlatforms}，但没有服务端的发布配置 cos-server.json：照 ${SERVER_SETUP_DOC}建好 ~/.config/vonvon-release/cos-server.json（或用 --server-cos-config 指定），再 plan`);
  const readConfig = await readCosConfig(configs.readonly.path), macWrite = await readCosWriteConfig(configs.macWrite.path), windowsConfig = await readWindowsCosConfig(configs.windows.path);
  const serverConfig = configs.server ? await readServerCosConfig(configs.server.path) : undefined;
  const serverOut = join(out, 'server');
  const readSource = path => r.readSource(state.seedRepo, state.sha, path);
  const serverNotes = state.paths.notesFile ? (await readFile(state.paths.notesFile, 'utf8')).trim().slice(0, 4096) || undefined : undefined;
  const server = serverConfig ? await r.planServer({ dir: serverOut, version: state.version, sha: state.sha, config: serverConfig, readSource, notes: serverNotes, previous: saved?.candidate.server ?? undefined }) : null;
  const mirrors = server?.mirrorBaseURLs ?? [];
  const r2Path = options['r2-config'] ?? saved?.configs.r2?.path ?? (mirrors.length ? r.r2ConfigPath : undefined);
  let r2Config, r2;
  if (r2Path !== undefined) {
    if (!server || !isAbsolute(r2Path)) throw new Error('R2 requires a server candidate and an absolute external r2-linux.json path');
    r2Config = await readR2Config(r2Path);
    configs.r2 = { path: await realpath(r2Path), sha256: digest(await readFile(r2Path)) };
    if (mirrors.length && json(mirrors) !== json([r2Config.publicBaseURL])) throw new Error('Packaged server mirrors must exactly match the configured R2 publicBaseURL');
    const mirrorPlan = await r.planR2({ dir: serverOut, serverPlan: server, config: r2Config });
    r2 = { plan: mirrorPlan, planSHA256: r2PlanSHA256(mirrorPlan) };
  }
  if (mirrors.length && !r2) throw new Error('Packaged server mirrorBaseURLs require r2-linux.json; the mirror cannot be omitted');
  const allPrivateNames = new Set([readConfig, macWrite, windowsConfig, ...(serverConfig ? [serverConfig] : [])].flatMap(cosCredentialEnvNames).concat(r2Config ? [r2Config.accessKeyIdEnv, r2Config.secretAccessKeyEnv] : []));
  const downloadEnv = Object.fromEntries(Object.entries(r.env).filter(([name]) => !allPrivateNames.has(name)));
  const macEvidence = await r.verifyMac(macOut, { version: state.version, sha: state.sha });
  if (['arm64', 'x64'].some(architecture => !macEvidence.files.some(file => file.file === `Vonvon-Bot-${state.version}-${architecture}.dmg`))) throw new Error('Both Mac architecture candidates are required');
  const windowsInventory = await r.download({ runId: state.windows.runId, out: windowsOut, env: downloadEnv, expectedSha: state.sha, expectedVersion: state.version });
  if (windowsInventory.architecture !== 'x64+arm64') throw new Error('Both Windows architectures are required');
  const provenance = await readJSON(join(windowsOut, 'github-build.json'));
  if (provenance.runId !== state.windows.runId || provenance.sourceSha !== state.sha) throw new Error('Windows provenance differs from this release');
  const windowsNotes = windowsInventory.updatesEnabled && state.paths.notesFile ? (await readFile(state.paths.notesFile, 'utf8')).trim().slice(0, 4096) : undefined;
  const updates = windowsInventory.updatesEnabled ? await r.planWindowsUpdates({ out: windowsOut, inventory: windowsInventory, env: r.env, privateKeyFile: windowsConfig.updatePrivateKeyFile, cdn: windowsConfig.cdn, notes: windowsNotes, previous: saved?.candidate.windows.updates }) : [];
  const candidate = { version: state.version, sourceSha: state.sha, macOut, macFiles: macEvidence.files,
    windows: { runId: state.windows.runId, provenance, updatesEnabled: windowsInventory.updatesEnabled, updates, objects: windowsObjectPlan(windowsInventory) }, server, ...(r2 ? { r2 } : {}) };
  const macOptions = { out: macOut, version: state.version, sha: state.sha, 'cos-config': configs.readonly.path, 'cos-write-config': configs.macWrite.path };
  const releaseFlags = Object.fromEntries(['first-release', 'no-live-manifest'].filter(key => state.flags?.[key === 'first-release' ? 'firstRelease' : 'noLiveManifest']).map(key => [key, true]));
  const windowsNames = new Set(cosCredentialEnvNames(windowsConfig));
  const macNames = new Set([...cosCredentialEnvNames(readConfig), ...cosCredentialEnvNames(macWrite)]);
  const serverNames = new Set(serverConfig ? cosCredentialEnvNames(serverConfig) : []);
  const r2Names = new Set(r2Config ? [r2Config.accessKeyIdEnv, r2Config.secretAccessKeyEnv] : []);
  // Each platform's writer sees only its own key (names shared between configurations stay with each that uses them).
  const othersOf = mine => new Set([...allPrivateNames].filter(name => !mine.has(name)));
  const without = (env, names) => Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)));
  return { out, state, configs, candidate, windowsInventory, windowsConfig, windowsNotes, macOptions, releaseFlags, windowsOut, serverOut, serverConfig, r2Config, readSource,
    publicEnv: downloadEnv,
    publicFetch: withReleaseCdnVerification(r.macDependencies?.fetchImpl ?? r.fetchImpl ?? fetch, macWrite.cdn),
    macDependencies: { ...r.macDependencies, env: without(r.macDependencies?.env ?? r.env, othersOf(macNames)) },
    collectDependencies: { ...r.collectDependencies, env: without(r.collectDependencies?.env ?? r.env, allPrivateNames) },
    windowsEnv: without(r.env, othersOf(windowsNames)),
    serverEnv: without(r.env, othersOf(serverNames)),
    r2Env: without(r.env, othersOf(r2Names)) };
}
async function reviewed(options, r) {
  if (!/^[a-f0-9]{64}$/.test(options['plan-sha256'] ?? '')) throw new Error('Supply the reviewed publication --plan-sha256');
  const bytes = await readFile(join(options.out, planName));
  if (digest(bytes) !== options['plan-sha256']) throw new Error('Publication plan hash differs from the reviewed plan');
  const plan = JSON.parse(bytes), c = await context(options, r, plan);
  if (plan.format !== 1 || plan.out !== c.out || json(plan.configs) !== json(c.configs) || json(plan.candidate) !== json(c.candidate)) throw new Error('Candidate, provenance or configuration changed since review; nothing was published');
  if (digest(await readFile(join(c.macOptions.out, 'publish-plan.json'))) !== plan.macPlanSHA256) throw new Error('Mac publication plan changed since review');
  return { ...c, plan, publicationPlanSHA256: options['plan-sha256'] };
}
const NO_SERVER = `服务端未配置（没有 cos-server.json）：这次只发 macOS 和 Windows（${SERVER_REQUIRED_FROM} 以前的版本才可以）`;
const matchesFiles = (actual, expected, sizeKey = 'size') => Array.isArray(actual) && actual.length === expected.length && expected.every(file => actual.some(item => item.file === file.file && item.sha256 === file.sha256 && item[sizeKey] === file[sizeKey] && (!file.url || item.url === file.url)));
async function receipts(c) {
  const mac = await optional(join(c.macOptions.out, 'upload-receipt.json')), windows = await optional(join(c.windowsOut, 'windows-publish-receipt.json'));
  const server = c.candidate.server ? await optional(join(c.serverOut, UPLOAD_RECEIPT)) : undefined;
  if (server && (server.version !== c.state.version || server.sourceSha !== c.state.sha || !matchesFiles(server.objects, c.candidate.server.versioned, 'bytes'))) throw new Error('服务端的上传回执和 owner 看过的候选对不上');
  const macPlan = await readJSON(join(c.macOptions.out, 'publish-plan.json'));
  if (mac && (mac.version !== c.state.version || mac.sourceCommit !== c.state.sha || mac.planSHA256 !== c.plan.macPlanSHA256 || mac.versionedVerification?.versionedObjectsVerified !== true || !matchesFiles(mac.objects, macPlan.upload))) throw new Error('Mac upload receipt does not match the reviewed candidate');
  if (windows && (windows.version !== c.state.version || windows.sourceSha !== c.state.sha || windows.architecture !== 'x64+arm64' || windows.signed !== false || windows.updatesEnabled !== c.candidate.windows.updatesEnabled || !matchesFiles(windows.objects, c.candidate.windows.objects, 'bytes'))) throw new Error('Windows upload receipt does not match the reviewed candidate');
  const r2 = c.candidate.r2 ? await optional(join(c.serverOut, R2_UPLOAD_RECEIPT)) : undefined;
  if (r2 && (r2.schemaVersion !== 1 || r2.version !== c.state.version || r2.sourceSha !== c.state.sha || r2.publicationPlanSHA256 !== c.publicationPlanSHA256 || r2.planSHA256 !== c.candidate.r2.planSHA256 || r2.mode !== 'versioned')) throw new Error('R2 upload receipt does not match the reviewed candidate');
  if (r2?.status === 'verified' && !matchesFiles(r2.verification, c.candidate.r2.plan.versioned, 'bytes')) throw new Error('R2 upload verification differs from the reviewed candidate');
  return { mac, windows, server, r2: r2?.status === 'verified' ? r2 : undefined };
}

async function publishR2Stage(c, r, mode) {
  await cancelled(c.out);
  const path = join(c.serverOut, mode === 'versioned' ? R2_UPLOAD_RECEIPT : R2_STABLE_RECEIPT);
  const identity = { schemaVersion: 1, version: c.state.version, sourceSha: c.state.sha, planSHA256: c.candidate.r2.planSHA256, publicationPlanSHA256: c.publicationPlanSHA256, mode };
  await atomic(path, { ...identity, status: 'sync-started' });
  try {
    const result = await r.syncR2({ dir: c.serverOut, plan: c.candidate.r2.plan, planSHA256: c.candidate.r2.planSHA256, config: c.r2Config, env: c.r2Env, mode, cancelFile: join(c.out, 'CANCEL'), log: r.log });
    const expected = c.candidate.r2.plan[mode];
    if (result.schemaVersion !== 1 || result.status !== 'verified' || result.version !== identity.version || result.planSHA256 !== identity.planSHA256 || result.mode !== mode || !matchesFiles(result.verification, expected, 'bytes')) throw new Error('R2 helper did not verify every planned object');
    await cancelled(c.out);
    await atomic(path, { ...result, ...identity, status: 'verified' });
  } catch {
    await atomic(path, { ...identity, status: 'failed' });
    throw new Error('R2 Linux mirror publication failed; inspect mirror state and resume with the same reviewed plan hash');
  }
}

export async function planPublication(options, dependencies = {}) {
  const r = runtime(dependencies), out = await outputRoot(options.out);
  return locked(out, async () => {
    await cancelled(out);
    const c = await context(options, r);
    const mac = await r.planMac({ ...c.macOptions, ...c.releaseFlags }, c.macDependencies);
    const plan = { format: 1, out, configs: c.configs, candidate: c.candidate, macPlanSHA256: mac.sha256 };
    await atomic(join(out, planName), plan);
    const server = c.candidate.server;
    const report = { version: c.state.version, sourceSha: c.state.sha, planSHA256: digest(json(plan)),
      macPlanSHA256: mac.sha256, windowsRunId: c.state.windows.runId,
      objects: [...mac.plan.upload, ...c.candidate.windows.objects, ...c.candidate.windows.updates, ...server?.versioned ?? []].map(({ file, url, size, bytes, sha256 }) => ({ file, url, bytes: bytes ?? size, sha256 })),
      ...(c.candidate.r2 ? { r2: { publicBaseURL: c.r2Config.publicBaseURL, planSHA256: c.candidate.r2.planSHA256, objects: [...c.candidate.r2.plan.versioned, ...c.candidate.r2.plan.stable] } } : {}),
      server: server ? { publishedAt: server.publishedAt, liveStable: server.previousManifest.status === 404 ? 'none' : server.previousManifest.version ?? 'unverified',
        stable: server.stable.map(({ key, url, bytes, sha256 }) => ({ key, url, bytes, sha256 })) } : NO_SERVER };
    r.log(json(report)); return report;
  });
}
export async function uploadPublication(options, dependencies = {}) {
  const r = runtime(dependencies), out = await outputRoot(options.out);
  return locked(out, async signal => {
    await cancelled(out);
    const c = await reviewed(options, r), prior = await receipts(c);
    const tasks = [async () => {
      if (prior.mac) return;
      await cancelled(out);
      await r.uploadMac({ ...c.macOptions, ...c.releaseFlags, 'plan-sha256': c.plan.macPlanSHA256, 'cancel-file': join(out, 'CANCEL') }, c.macDependencies);
    }, async () => {
      if (prior.windows) return;
      await cancelled(out);
      await r.execute(process.execPath, [join(scripts, 'publish-windows.mjs'), '--run-id', String(c.state.windows.runId), '--out', c.windowsOut,
        '--sha', c.state.sha, '--version', c.state.version, '--cos-config', c.configs.windows.path, '--cancel-file', join(out, 'CANCEL')],
      { env: c.windowsEnv, signal });
    }, async () => {
      if (!c.candidate.server || prior.server) return;
      await cancelled(out);
      await r.uploadServer({ dir: c.serverOut, plan: c.candidate.server, config: c.serverConfig, env: c.serverEnv, cancelFile: join(out, 'CANCEL'), log: r.log });
    }, async () => {
      if (!c.candidate.r2 || prior.r2) return;
      await publishR2Stage(c, r, 'versioned');
    }];
    // Join every branch even on failure; a successful platform keeps its original durable receipt.
    const outcomes = await Promise.allSettled(tasks.map(task => task()));
    const failed = outcomes.flatMap((item, index) => item.status === 'rejected' ? [['Mac', 'Windows', 'server', 'R2'][index]] : []);
    // execFile / SDK errors can embed command output or signed URLs. Never forward raw failures.
    if (failed.length) throw new Error(`Versioned publication incomplete: ${failed.join(' and ')} publication helper failed; successful receipts retained; inspect platform state and resume upload with the same plan hash`);
    const completed = await receipts(c);
    if (!completed.mac || !completed.windows || (c.candidate.server && !completed.server) || (c.candidate.r2 && !completed.r2)) throw new Error('Publication helpers did not produce every verified receipt');
    r.log(c.candidate.server ? 'macOS, Windows and the server packages uploaded and publicly verified. Stable and website are unchanged.'
      : `Both platforms uploaded and publicly verified. Stable and website are unchanged. ${NO_SERVER}.`);
    return { version: c.state.version, sourceSha: c.state.sha, versionedObjectsVerified: true };
  });
}
export async function promotePublication(options, dependencies = {}) {
  const r = runtime(dependencies), out = await outputRoot(options.out);
  return locked(out, async signal => {
    await cancelled(out);
    const c = await reviewed(options, r), uploaded = await receipts(c);
    if (!uploaded.mac || !uploaded.windows || (c.candidate.server && !uploaded.server) || (c.candidate.r2 && !uploaded.r2)) throw new Error('Both versioned public receipts (and the server\'s, when planned) are required before stable');
    if (c.candidate.r2 && !options['owner-confirmation']?.trim()) throw new Error('R2 stable requires the owner confirmation for this exact reviewed publication plan');
    const previous = await optional(join(c.macOptions.out, 'publish-receipt.json'));
    if (previous && (previous.planSHA256 !== c.plan.macPlanSHA256 || previous.version !== c.state.version || previous.sourceCommit !== c.state.sha)) throw new Error('Stable receipt belongs to a different candidate');
    // A prior handoff is no longer current while publication is being reverified.
    const oldHandoff = await optional(join(out, 'release-handoff.json'));
    if (oldHandoff?.readyForWebsite === true) await atomic(join(out, 'release-handoff.json'), { ...oldHandoff, readyForWebsite: false });
    const macOptions = { ...c.macOptions, 'plan-sha256': c.plan.macPlanSHA256 };
    if (previous?.status === 'published') {
      const verified = await r.verifyPublicMac({ out: c.macOptions.out, version: c.state.version, sha: c.state.sha, env: c.publicEnv, fetchImpl: c.publicFetch });
      if (verified.publiclyVerified !== true) throw new Error('Existing stable publication did not verify');
    } else {
      let written = false;
      if (previous) {
        const macPlan = await readJSON(join(c.macOptions.out, 'publish-plan.json'));
        const live = await r.readLiveManifest({ env: c.publicEnv, fetchImpl: c.publicFetch });
        const snapshot = live.kind === 'missing' ? { status: 404 } : { status: 200, size: live.bytes.length, sha256: digest(live.bytes) };
        written = snapshot.status === 200 && snapshot.size === macPlan.promote.size && snapshot.sha256 === macPlan.promote.sha256;
        const old = macPlan.previousManifest;
        const unchanged = snapshot.status === old.status && (snapshot.status === 404 || snapshot.size === old.size && snapshot.sha256 === old.sha256);
        if (!written && !unchanged) throw new Error('Stable changed to neither this candidate nor the reviewed previous snapshot; stop and investigate');
        if (!written && !options['owner-confirmation']?.trim()) throw new Error('The manifest was not written; retry requires the owner confirmation for this reviewed candidate');
      }
      if (written) await r.reverifyMac(macOptions, c.macDependencies);
      else await r.promoteMac({ ...macOptions, 'cancel-file': join(out, 'CANCEL'), 'owner-confirmation': options['owner-confirmation'], 'reviewed-plan': true }, c.macDependencies);
    }
    if (c.candidate.windows.updatesEnabled) await r.promoteWindowsUpdates({ out: c.windowsOut, inventory: c.windowsInventory, feeds: c.candidate.windows.updates, config: c.windowsConfig,
      env: c.windowsEnv, notes: c.windowsNotes, ownerConfirmation: options['owner-confirmation'], planSHA256: options['plan-sha256'], cancelFile: join(out, 'CANCEL') });
    // Last, after macOS and Windows (devices 7.6). Each of those is skipped on a rerun once its stable is live, so a
    // rerun with the same plan hash only completes the server.
    if (c.candidate.server) {
      try {
        await r.promoteServer({ dir: c.serverOut, plan: c.candidate.server, config: c.serverConfig, env: c.serverEnv, readSource: c.readSource, log: r.log,
          ownerConfirmation: options['owner-confirmation'], planSHA256: options['plan-sha256'], cancelFile: join(out, 'CANCEL') });
      } catch (error) {
        throw new Error(`macOS 和 Windows 的 stable 已经切好，服务端 stable 没切成：${error.message}。用同一个计划哈希重跑 promote，只补服务端。`);
      }
    }
    if (c.candidate.r2) await publishR2Stage(c, r, 'stable');
    const handoff = await r.collect({ out }, c.collectDependencies);
    if (handoff.readyForWebsite !== true) throw new Error('Publication receipts did not produce a complete website handoff');
    r.log('Stable publicly verified. release-handoff.json is ready for the existing website workflow.');
    await cancelled(out);
    let host = r.releaseCodeHost;
    try {
      if (host === undefined) {
        const config = await optional(r.releaseCodeConfigPath);
        if (config === undefined) return handoff;
        host = config?.sshHost;
      } else if (host === '') {
        return handoff;
      }
      if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host)) throw new Error('Invalid source upload host');
      const syncEnv = Object.fromEntries(['PATH', 'HOME', 'SSH_AUTH_SOCK']
        .filter(name => r.env[name]).map(name => [name, r.env[name]]));
      await r.execute('python3', [join(scripts, 'release-code.py'), 'send', '--out', out, '--host', host], { env: syncEnv, signal });
      return { ...handoff, releaseCodeSync: 'verified' };
    } catch {
      // This auxiliary copy can be retried independently after the website handoff.
      r.log('Release-code sync pending. Check the upload host, then run python3 scripts/release-code.py send --out <release-output> --host <ssh-alias>.');
      return { ...handoff, releaseCodeSync: 'pending' };
    }
  });
}
export async function publicationStatus({ out }) {
  const root = await outputRoot(out), plan = await optional(join(root, planName));
  if (!plan) return { planned: false };
  const planSHA256 = digest(await readFile(join(root, planName)));
  const r2Stable = plan.candidate.r2 ? await optional(join(root, 'server', R2_STABLE_RECEIPT)) : undefined;
  const r2Ready = !plan.candidate.r2 || (r2Stable?.schemaVersion === 1 && r2Stable.status === 'verified' && r2Stable.mode === 'stable'
    && r2Stable.version === plan.candidate.version && r2Stable.sourceSha === plan.candidate.sourceSha && r2Stable.publicationPlanSHA256 === planSHA256
    && r2Stable.planSHA256 === plan.candidate.r2.planSHA256 && plan.candidate.r2.planSHA256 === r2PlanSHA256(plan.candidate.r2.plan)
    && matchesFiles(r2Stable.verification, plan.candidate.r2.plan.stable, 'bytes'));
  return { planned: true, version: plan.candidate.version, sourceSha: plan.candidate.sourceSha, planSHA256,
    macReceiptPresent: !!await optional(join(plan.candidate.macOut, 'upload-receipt.json')),
    windowsReceiptPresent: !!await optional(join(root, 'windows/windows-publish-receipt.json')),
    server: !plan.candidate.server ? (serverRequired(plan.candidate.version) ? `这份计划没有服务端：${SERVER_REQUIRED_FROM} 起不能只发 macOS 和 Windows，照 ${SERVER_SETUP_DOC}配好后重新 plan` : NO_SERVER) : { receiptPresent: !!await optional(join(root, 'server', UPLOAD_RECEIPT)),
      stableStatus: (await optional(join(root, 'server', STABLE_RECEIPT)))?.status ?? 'not-promoted' },
    ...(plan.candidate.r2 ? { r2: { publicBaseURL: plan.candidate.r2.plan.target.publicBaseURL, uploadStatus: (await optional(join(root, 'server', R2_UPLOAD_RECEIPT)))?.status ?? 'not-uploaded', stableStatus: r2Stable?.status ?? 'not-promoted' } } : {}),
    stableRecordedStatus: (await optional(join(plan.candidate.macOut, 'publish-receipt.json')))?.status ?? 'not-promoted',
    website: r2Ready && (await optional(join(root, 'release-handoff.json')))?.readyForWebsite === true ? 'handoff-ready; deployment not verified' : 'not-ready' };
}

const help = 'Usage: node scripts/release-publish.mjs <plan|upload|promote|status> --out /absolute/release [--cos-write-config /external/cos-write.json] [--windows-cos-config /external/cos-windows.json] [--server-cos-config /external/cos-server.json] [--r2-config /external/r2-linux.json]\nplan prints the unified reviewed plan SHA-256; it covers the server packages once cos-server.json exists (default ~/.config/vonvon-release/cos-server.json), and from 0.9.0 refuses a release without it or without the server build. upload requires --plan-sha256 and publishes the versioned objects of every platform concurrently. promote requires that same hash and --owner-confirmation with the owner\'s reply about this reviewed candidate; it switches macOS, then Windows, then the server stable (its signed manifest and install scripts), verifies them and writes the website handoff. Packaged mirrorBaseURLs require the matching external R2 config (default ~/.config/vonvon-release/r2-linux.json); its exact plan and config hash are reviewed too. Versioned R2 files upload before stable, and R2 stable only mirrors the publicly verified COS stable. No command deploys the website.';
const invoked = process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null);
if (invoked && invoked === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, ...Object.fromEntries(['out', 'cos-write-config', 'windows-cos-config', 'server-cos-config', 'r2-config', 'plan-sha256', 'owner-confirmation'].map(name => [name, { type: 'string' }])) } });
    const commands = { plan: planPublication, upload: uploadPublication, promote: promotePublication, status: publicationStatus };
    if (values.help) console.log(help);
    else if (positionals.length !== 1 || !commands[positionals[0]] || !values.out) throw new Error(help);
    else console.log(json(await commands[positionals[0]](values)));
  } catch (error) { console.error(String(error.message).replace(/\/Users\/[^/\s"']+/g, '/Users/<u>')); process.exitCode = 1; }
}
