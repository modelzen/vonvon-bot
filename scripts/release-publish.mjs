import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planPublish, uploadRelease, promoteRelease, reverifyRelease, readCosWriteConfig } from './release-cos-publish.mjs';
import { downloadBuild, readWindowsCosConfig, windowsObjectPlan, planWindowsUpdates, promoteWindowsUpdates } from './publish-windows.mjs';
import { collectRelease, runReleaseChild } from './release-all.mjs';
import { assertSecureTransport, readStableManifest, validateReleaseInventory, verifyPublicRelease } from './verify-public-release.mjs';
import { cosCredentialEnvNames, readCosConfig } from './release-cos-evidence.mjs';

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
function runtime(dependencies) {
  return { env: process.env, download: downloadBuild, planWindowsUpdates, promoteWindowsUpdates, verifyMac: validateReleaseInventory, planMac: planPublish,
    uploadMac: uploadRelease, promoteMac: promoteRelease, reverifyMac: reverifyRelease,
    verifyPublicMac: verifyPublicRelease, readLiveManifest: readStableManifest, collect: collectRelease, execute: runReleaseChild, log: console.log, ...dependencies };
}
async function context(options, r, saved) {
  assertSecureTransport(r.env);
  if (!isAbsolute(options.out ?? '')) throw new Error('Supply absolute --out from release-all');
  const out = await realpath(options.out), state = await readJSON(join(out, 'release-orchestration.json'));
  if (state.format !== 1 || state.out !== out || !/^[a-f0-9]{40}$/.test(state.sha ?? '') || !/^\d+\.\d+\.\d+$/.test(state.version ?? '')
    || state.mac?.phase !== 'candidate-complete' || state.windows?.status !== 'completed' || state.windows.conclusion !== 'success' || !Number.isSafeInteger(state.windows.runId)) throw new Error('Both pinned platform candidates must be complete; resume release-all first');
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
  const readConfig = await readCosConfig(configs.readonly.path), macWrite = await readCosWriteConfig(configs.macWrite.path), windowsConfig = await readWindowsCosConfig(configs.windows.path);
  const allPrivateNames = new Set([readConfig, macWrite, windowsConfig].flatMap(cosCredentialEnvNames));
  const downloadEnv = Object.fromEntries(Object.entries(r.env).filter(([name]) => !allPrivateNames.has(name)));
  const macEvidence = await r.verifyMac(macOut, { version: state.version, sha: state.sha });
  if (['arm64', 'x64'].some(architecture => !macEvidence.files.some(file => file.file === `Vonvon-Bot-${state.version}-${architecture}.dmg`))) throw new Error('Both Mac architecture candidates are required');
  const windowsInventory = await r.download({ runId: state.windows.runId, out: windowsOut, env: downloadEnv, expectedSha: state.sha, expectedVersion: state.version });
  if (windowsInventory.architecture !== 'x64+arm64') throw new Error('Both Windows architectures are required');
  const provenance = await readJSON(join(windowsOut, 'github-build.json'));
  if (provenance.runId !== state.windows.runId || provenance.sourceSha !== state.sha) throw new Error('Windows provenance differs from this release');
  const windowsNotes = windowsInventory.updatesEnabled && state.paths.notesFile ? (await readFile(state.paths.notesFile, 'utf8')).trim().slice(0, 4096) : undefined;
  const updates = windowsInventory.updatesEnabled ? await r.planWindowsUpdates({ out: windowsOut, inventory: windowsInventory, env: r.env, privateKeyFile: windowsConfig.updatePrivateKeyFile, notes: windowsNotes, previous: saved?.candidate.windows.updates }) : [];
  const candidate = { version: state.version, sourceSha: state.sha, macOut, macFiles: macEvidence.files,
    windows: { runId: state.windows.runId, provenance, updatesEnabled: windowsInventory.updatesEnabled, updates, objects: windowsObjectPlan(windowsInventory) } };
  const macOptions = { out: macOut, version: state.version, sha: state.sha, 'cos-config': configs.readonly.path, 'cos-write-config': configs.macWrite.path };
  const releaseFlags = Object.fromEntries(['first-release', 'no-live-manifest'].filter(key => state.flags?.[key === 'first-release' ? 'firstRelease' : 'noLiveManifest']).map(key => [key, true]));
  const windowsNames = new Set(cosCredentialEnvNames(windowsConfig));
  const macNames = new Set([...cosCredentialEnvNames(readConfig), ...cosCredentialEnvNames(macWrite)]);
  const privateNames = [...macNames].filter(name => !windowsNames.has(name));
  const without = (env, names) => Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)));
  return { out, state, configs, candidate, windowsInventory, windowsConfig, windowsNotes, macOptions, releaseFlags, windowsOut,
    publicEnv: downloadEnv,
    macDependencies: { ...r.macDependencies, env: without(r.macDependencies?.env ?? r.env, new Set([...windowsNames].filter(name => !macNames.has(name)))) },
    collectDependencies: { ...r.collectDependencies, env: without(r.collectDependencies?.env ?? r.env, allPrivateNames) },
    windowsEnv: Object.fromEntries(Object.entries(r.env).filter(([name]) => !privateNames.includes(name))) };
}
async function reviewed(options, r) {
  if (!/^[a-f0-9]{64}$/.test(options['plan-sha256'] ?? '')) throw new Error('Supply the reviewed publication --plan-sha256');
  const bytes = await readFile(join(options.out, planName));
  if (digest(bytes) !== options['plan-sha256']) throw new Error('Publication plan hash differs from the reviewed plan');
  const plan = JSON.parse(bytes), c = await context(options, r, plan);
  if (plan.format !== 1 || plan.out !== c.out || json(plan.configs) !== json(c.configs) || json(plan.candidate) !== json(c.candidate)) throw new Error('Candidate, provenance or configuration changed since review; nothing was published');
  if (digest(await readFile(join(c.macOptions.out, 'publish-plan.json'))) !== plan.macPlanSHA256) throw new Error('Mac publication plan changed since review');
  return { ...c, plan };
}
const matchesFiles = (actual, expected, sizeKey = 'size') => Array.isArray(actual) && actual.length === expected.length && expected.every(file => actual.some(item => item.file === file.file && item.sha256 === file.sha256 && item[sizeKey] === file[sizeKey] && (!file.url || item.url === file.url)));
async function receipts(c) {
  const mac = await optional(join(c.macOptions.out, 'upload-receipt.json')), windows = await optional(join(c.windowsOut, 'windows-publish-receipt.json'));
  const macPlan = await readJSON(join(c.macOptions.out, 'publish-plan.json'));
  if (mac && (mac.version !== c.state.version || mac.sourceCommit !== c.state.sha || mac.planSHA256 !== c.plan.macPlanSHA256 || mac.versionedVerification?.versionedObjectsVerified !== true || !matchesFiles(mac.objects, macPlan.upload))) throw new Error('Mac upload receipt does not match the reviewed candidate');
  if (windows && (windows.version !== c.state.version || windows.sourceSha !== c.state.sha || windows.architecture !== 'x64+arm64' || windows.signed !== false || windows.updatesEnabled !== c.candidate.windows.updatesEnabled || !matchesFiles(windows.objects, c.candidate.windows.objects, 'bytes'))) throw new Error('Windows upload receipt does not match the reviewed candidate');
  return { mac, windows };
}

export async function planPublication(options, dependencies = {}) {
  const r = runtime(dependencies), out = await outputRoot(options.out);
  return locked(out, async () => {
    await cancelled(out);
    const c = await context(options, r);
    const mac = await r.planMac({ ...c.macOptions, ...c.releaseFlags }, c.macDependencies);
    const plan = { format: 1, out, configs: c.configs, candidate: c.candidate, macPlanSHA256: mac.sha256 };
    await atomic(join(out, planName), plan);
    const report = { version: c.state.version, sourceSha: c.state.sha, planSHA256: digest(json(plan)),
      macPlanSHA256: mac.sha256, windowsRunId: c.state.windows.runId,
      objects: [...mac.plan.upload, ...c.candidate.windows.objects, ...c.candidate.windows.updates].map(({ file, url, size, bytes, sha256 }) => ({ file, url, bytes: bytes ?? size, sha256 })) };
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
    }];
    // Join both branches even on failure; a successful platform keeps its original durable receipt.
    const outcomes = await Promise.allSettled(tasks.map(task => task()));
    const failed = outcomes.flatMap((item, index) => item.status === 'rejected' ? [index ? 'Windows' : 'Mac'] : []);
    // execFile / SDK errors can embed command output or signed URLs. Never forward raw failures.
    if (failed.length) throw new Error(`Versioned publication incomplete: ${failed.join(' and ')} publication helper failed; successful receipts retained; inspect platform state and resume upload with the same plan hash`);
    const completed = await receipts(c);
    if (!completed.mac || !completed.windows) throw new Error('Publication helpers did not produce both verified receipts');
    r.log('Both platforms uploaded and publicly verified. Stable and website are unchanged.');
    return { version: c.state.version, sourceSha: c.state.sha, versionedObjectsVerified: true };
  });
}
export async function promotePublication(options, dependencies = {}) {
  const r = runtime(dependencies), out = await outputRoot(options.out);
  return locked(out, async () => {
    await cancelled(out);
    const c = await reviewed(options, r), uploaded = await receipts(c);
    if (!uploaded.mac || !uploaded.windows) throw new Error('Both versioned public receipts are required before stable');
    const previous = await optional(join(c.macOptions.out, 'publish-receipt.json'));
    if (previous && (previous.planSHA256 !== c.plan.macPlanSHA256 || previous.version !== c.state.version || previous.sourceCommit !== c.state.sha)) throw new Error('Stable receipt belongs to a different candidate');
    const macOptions = { ...c.macOptions, 'plan-sha256': c.plan.macPlanSHA256 };
    if (previous?.status === 'published') {
      const verified = await r.verifyPublicMac({ out: c.macOptions.out, version: c.state.version, sha: c.state.sha, env: c.publicEnv });
      if (verified.publiclyVerified !== true) throw new Error('Existing stable publication did not verify');
    } else {
      let written = false;
      if (previous) {
        const macPlan = await readJSON(join(c.macOptions.out, 'publish-plan.json'));
        const live = await r.readLiveManifest({ env: c.publicEnv });
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
    const handoff = await r.collect({ out }, c.collectDependencies);
    if (handoff.readyForWebsite !== true) throw new Error('Publication receipts did not produce a complete website handoff');
    r.log('Stable publicly verified. release-handoff.json is ready for the existing website workflow.');
    return handoff;
  });
}
export async function publicationStatus({ out }) {
  const root = await outputRoot(out), plan = await optional(join(root, planName));
  if (!plan) return { planned: false };
  return { planned: true, version: plan.candidate.version, sourceSha: plan.candidate.sourceSha, planSHA256: digest(await readFile(join(root, planName))),
    macReceiptPresent: !!await optional(join(plan.candidate.macOut, 'upload-receipt.json')),
    windowsReceiptPresent: !!await optional(join(root, 'windows/windows-publish-receipt.json')),
    stableRecordedStatus: (await optional(join(plan.candidate.macOut, 'publish-receipt.json')))?.status ?? 'not-promoted',
    website: (await optional(join(root, 'release-handoff.json')))?.readyForWebsite === true ? 'handoff-ready; deployment not verified' : 'not-ready' };
}

const help = 'Usage: node scripts/release-publish.mjs <plan|upload|promote|status> --out /absolute/release [--cos-write-config /external/cos-write.json] [--windows-cos-config /external/cos-windows.json]\nplan prints the unified reviewed plan SHA-256. upload requires --plan-sha256 and publishes both versioned platforms concurrently. promote requires that same hash and --owner-confirmation with the owner\'s reply about this reviewed candidate; it verifies stable and writes the website handoff. No command deploys the website.';
const invoked = process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null);
if (invoked && invoked === await realpath(fileURLToPath(import.meta.url))) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, ...Object.fromEntries(['out', 'cos-write-config', 'windows-cos-config', 'plan-sha256', 'owner-confirmation'].map(name => [name, { type: 'string' }])) } });
    const commands = { plan: planPublication, upload: uploadPublication, promote: promotePublication, status: publicationStatus };
    if (values.help) console.log(help);
    else if (positionals.length !== 1 || !commands[positionals[0]] || !values.out) throw new Error(help);
    else console.log(json(await commands[positionals[0]](values)));
  } catch (error) { console.error(String(error.message).replace(/\/Users\/[^/\s"']+/g, '/Users/<u>')); process.exitCode = 1; }
}
